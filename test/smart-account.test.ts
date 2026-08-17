/**
 * End-to-end against the real Crossmint/stellar-smart-account contract:
 * deploy a custom account, then authorize a call through its own __check_auth
 * by signing the recorded authorization entry the way the app does.
 *
 * This is the flow a mocked RPC cannot test at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, Keypair, scValToNative } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../src/index.js';
import { accountIdFromPublicKey } from '../src/classic.js';
import {
  signAuthEntries,
  authorizeAndSend,
  smartAccountEd25519,
  smartAccountMultiEd25519,
  ed25519SignerKey,
} from '../src/auth.js';

const SMART = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/smart_account.wasm', import.meta.url))),
);

const sym = (s: string) => xdr.ScVal.scvSymbol(s);

/** Signer::Ed25519(Ed25519Signer { public_key }, SignerRole::Admin) */
function adminSigner(kp: Keypair): xdr.ScVal {
  return xdr.ScVal.scvVec([
    sym('Ed25519'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('public_key'), val: xdr.ScVal.scvBytes(kp.rawPublicKey()) }),
    ]),
    xdr.ScVal.scvVec([sym('Admin')]),
  ]);
}

describe('custom account: signing auth entries for __check_auth', () => {
  let L: Ledger;
  let source: string;
  let admin: Keypair;
  let addr: xdr.ScAddress;

  beforeEach(() => {
    L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    source = accountIdFromPublicKey(deployer.publicKey()).toXDR('base64');

    admin = Keypair.random();
    const wasmHash = L.seedWasm(SMART);
    const { sent } = L.simulateAndSend(
      createContractHostFn(source, wasmHash, Buffer.alloc(32), [
        xdr.ScVal.scvVec([adminSigner(admin)]),
        xdr.ScVal.scvVec([]),
      ]),
      source,
    );
    expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
    addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  });

  it('deploys the smart account and registers the admin signer', () => {
    const has = L.simulate(
      invokeHostFn(addr, 'has_signer', [ed25519SignerKey(admin.rawPublicKey())]),
      source,
    );
    expect(has.ok, has.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(true);
  });

  it('simulation records an address credential without running __check_auth', () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const sim = L.simulate(fn, source);

    expect(sim.ok).toBe(true); // green, despite no signature existing yet
    expect(sim.authXdr).toHaveLength(1);
    const cred = xdr.SorobanAuthorizationEntry.fromXDR(sim.authXdr[0], 'base64').credentials();
    expect(cred.switch().name).toBe('sorobanCredentialsAddress');
  });

  it('sending the recorded (unsigned) auth entry is rejected by __check_auth', () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const sim = L.simulate(fn, source);
    const sent = L.send(fn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);

    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('Auth');
  });

  // Skipping the enforcing re-simulation is the mistake that costs an afternoon.
  it('signing alone is NOT enough: the recorded footprint misses __check_auth reads', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const sim = L.simulate(fn, source);
    const signedAuth = await signAuthEntries(L, sim.authXdr, { sign: smartAccountEd25519(admin) });

    // Correct signature, stale footprint.
    const sent = L.send(fn, source, sim.resourcesXdr, signedAuth, sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('ExceededLimit');
  });

  it('the enforcing re-simulation widens the footprint', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const recorded = L.simulate(fn, source);
    const signedAuth = await signAuthEntries(L, recorded.authXdr, {
      sign: smartAccountEd25519(admin),
    });
    const enforced = L.simulateWithAuth(fn, source, signedAuth);

    expect(enforced.ok, enforced.error).toBe(true);
    const before = recorded.readOnlyKeys.length + recorded.readWriteKeys.length;
    const after = enforced.readOnlyKeys.length + enforced.readWriteKeys.length;
    expect(after).toBeGreaterThan(before);
    // __check_auth costs real instructions that the first pass never measured.
    expect(enforced.instructions).toBeGreaterThan(recorded.instructions);
  });

  it('SIGNED auth entries pass __check_auth and the call applies', async () => {
    const newSigner = Keypair.random();
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(newSigner)]);

    const { sent } = await authorizeAndSend(L, fn, source, { sign: smartAccountEd25519(admin) });
    expect(sent.ok, `send failed: ${sent.error}`).toBe(true);

    // The new signer really landed in the account's storage.
    const has = L.simulate(
      invokeHostFn(addr, 'has_signer', [ed25519SignerKey(newSigner.rawPublicKey())]),
      source,
    );
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(true);
  });

  it('a proof from the WRONG key is rejected', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    await expect(
      authorizeAndSend(L, fn, source, { sign: smartAccountEd25519(Keypair.random()) }),
    ).rejects.toThrow();
  });

  it('an expired signature is rejected', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const recorded = L.simulate(fn, source);
    const signedAuth = await signAuthEntries(L, recorded.authXdr, {
      sign: smartAccountEd25519(admin),
      validUntilLedgerSeq: L.ledgerSeq + 5,
    });
    const enforced = L.simulateWithAuth(fn, source, signedAuth);

    L.advanceLedgers(50); // past the expiration the signature committed to

    const sent = L.send(
      fn, source, enforced.resourcesXdr, signedAuth, enforced.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(false);
  });

  it('nonce replay: the same signed auth entry cannot be used twice', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const { sent, signedAuth, enforced } = await authorizeAndSend(L, fn, source, {
      sign: smartAccountEd25519(admin),
    });
    expect(sent.ok).toBe(true);

    const replay = L.send(
      fn, source, enforced.resourcesXdr, signedAuth, enforced.restoredRwEntryIndices,
    );
    expect(replay.ok).toBe(false);
  });

  it('multiple signers can prove the same payload', async () => {
    const co = Keypair.random();
    const addCo = invokeHostFn(addr, 'add_signer', [adminSigner(co)]);
    const first = await authorizeAndSend(L, addCo, source, { sign: smartAccountEd25519(admin) });
    expect(first.sent.ok, first.sent.error).toBe(true);

    // Now prove with both keys at once.
    const fn = invokeHostFn(addr, 'add_signer', [adminSigner(Keypair.random())]);
    const { sent } = await authorizeAndSend(L, fn, source, {
      sign: smartAccountMultiEd25519([admin, co]),
    });
    expect(sent.ok, `send failed: ${sent.error}`).toBe(true);
  });
});
