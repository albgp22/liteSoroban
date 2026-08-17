/**
 * The passkey path, against the smart account built from CURRENT source
 * (`stellar contract build --package smart-account`, wasm32v1-none, 49 KB).
 *
 * That build differs from testdata/smart_account_v1.wasm:
 *   current:  SignerProof::Secp256r1(BytesN<64>)   raw ECDSA
 *             SignerKey::Secp256r1(BytesN<65>)     the public key
 *             Secp256r1Signer { public_key }
 *   v1:       SignerProof::Secp256r1(Secp256r1Signature{...})  WebAuthn-shaped
 *             SignerKey::Secp256r1(Bytes)          the key_id
 *             Secp256r1Signer { key_id, public_key }
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, Keypair, scValToNative } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../src/index.js';
import { accountIdFromPublicKey } from '../src/classic.js';
import {
  authorizeAndSend,
  signAuthEntries,
  createP256Signer,
  smartAccountSecp256r1,
  smartAccountMixed,
  secp256r1SignerKey,
  ed25519SignerKey,
  type P256Signer,
} from '../src/auth.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/smart_account_current.wasm', import.meta.url))),
);
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const ADMIN = xdr.ScVal.scvVec([sym('Admin')]);

/** Signer::Secp256r1(Secp256r1Signer { public_key }, SignerRole::Admin) */
const p256Signer = (s: P256Signer, role = ADMIN) =>
  xdr.ScVal.scvVec([
    sym('Secp256r1'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('public_key'), val: xdr.ScVal.scvBytes(s.publicKey) }),
    ]),
    role,
  ]);

/** Signer::Ed25519(Ed25519Signer { public_key }, SignerRole::Admin) */
const edSigner = (kp: Keypair, role = ADMIN) =>
  xdr.ScVal.scvVec([
    sym('Ed25519'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('public_key'), val: xdr.ScVal.scvBytes(kp.rawPublicKey()) }),
    ]),
    role,
  ]);

describe('smart account (current build): secp256r1 / passkey auth', () => {
  let L: Ledger;
  let source: string;
  let passkey: P256Signer;
  let addr: xdr.ScAddress;

  function deploy(signers: xdr.ScVal[]) {
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(
      createContractHostFn(source, wasmHash, Buffer.alloc(32), [
        xdr.ScVal.scvVec(signers),
        xdr.ScVal.scvVec([]),
      ]),
      source,
    );
    expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
    return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  }

  beforeEach(() => {
    L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    source = accountIdFromPublicKey(deployer.publicKey()).toXDR('base64');
    passkey = createP256Signer();
    addr = deploy([p256Signer(passkey)]);
  });

  it('the P-256 keypair is a valid SEC1 uncompressed key', () => {
    expect(passkey.publicKey).toHaveLength(65);
    expect(passkey.publicKey[0]).toBe(0x04);
    expect(passkey.sign(Buffer.alloc(32, 1))).toHaveLength(64);
  });

  it('deploys with a passkey admin and registers it', () => {
    const has = L.simulate(
      invokeHostFn(addr, 'has_signer', [secp256r1SignerKey(passkey.publicKey)]),
      source,
    );
    expect(has.ok, has.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(true);
  });

  it('a passkey signature passes __check_auth and the call applies', async () => {
    const newKey = Keypair.random();
    const fn = invokeHostFn(addr, 'add_signer', [edSigner(newKey)]);

    const { sent } = await authorizeAndSend(L, fn, source, {
      sign: smartAccountSecp256r1(passkey),
    });
    expect(sent.ok, `send failed: ${sent.error}`).toBe(true);

    const has = L.simulate(
      invokeHostFn(addr, 'has_signer', [ed25519SignerKey(newKey.rawPublicKey())]),
      source,
    );
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(true);
  });

  it('a signature from a DIFFERENT passkey is rejected', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [edSigner(Keypair.random())]);
    await expect(
      authorizeAndSend(L, fn, source, { sign: smartAccountSecp256r1(createP256Signer()) }),
    ).rejects.toThrow();
  });

  it('a tampered signature is rejected', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [edSigner(Keypair.random())]);
    const bad: P256Signer = {
      publicKey: passkey.publicKey,
      sign: (payload) => {
        const sig = passkey.sign(payload);
        sig[10] ^= 0xff; // flip a bit in r
        return sig;
      },
    };
    await expect(
      authorizeAndSend(L, fn, source, { sign: smartAccountSecp256r1(bad) }),
    ).rejects.toThrow();
  });

  it('the host rejects a high-S signature (malleability guard)', async () => {
    // Renormalize noble's low-S output back to high S: s' = n - s.
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const highS: P256Signer = {
      publicKey: passkey.publicKey,
      sign: (payload) => {
        const sig = passkey.sign(payload);
        const s = BigInt('0x' + sig.subarray(32).toString('hex'));
        const flipped = N - s;
        return Buffer.concat([
          sig.subarray(0, 32),
          Buffer.from(flipped.toString(16).padStart(64, '0'), 'hex'),
        ]);
      },
    };
    const fn = invokeHostFn(addr, 'add_signer', [edSigner(Keypair.random())]);
    await expect(
      authorizeAndSend(L, fn, source, { sign: smartAccountSecp256r1(highS) }),
    ).rejects.toThrow();
  });

  it('an expired passkey signature is rejected', async () => {
    const fn = invokeHostFn(addr, 'add_signer', [edSigner(Keypair.random())]);
    const recorded = L.simulate(fn, source);
    const signedAuth = await signAuthEntries(L, recorded.authXdr, {
      sign: smartAccountSecp256r1(passkey),
      validUntilLedgerSeq: L.ledgerSeq + 5,
    });
    const enforced = L.simulateWithAuth(fn, source, signedAuth);

    L.advanceLedgers(50);

    const sent = L.send(
      fn, source, enforced.resourcesXdr, signedAuth, enforced.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(false);
  });

  it('mixed ed25519 + passkey signers prove the same payload', async () => {
    const ed = Keypair.random();
    const pk2 = createP256Signer();
    L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    source = accountIdFromPublicKey(deployer.publicKey()).toXDR('base64');
    const multi = deploy([edSigner(ed), p256Signer(pk2)]);

    const fn = invokeHostFn(multi, 'add_signer', [edSigner(Keypair.random())]);
    const { sent } = await authorizeAndSend(L, fn, source, {
      sign: smartAccountMixed([ed], [pk2]),
    });
    expect(sent.ok, `send failed: ${sent.error}`).toBe(true);
  });

  it('P-256 verification costs measurably more than ed25519', async () => {
    const edKp = Keypair.random();
    L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    source = accountIdFromPublicKey(deployer.publicKey()).toXDR('base64');

    const edAddr = deploy([edSigner(edKp)]);
    const fn = invokeHostFn(edAddr, 'add_signer', [edSigner(Keypair.random())]);
    const recorded = L.simulate(fn, source);
    const edAuth = await signAuthEntries(L, recorded.authXdr, {
      sign: (await import('../src/auth.js')).smartAccountEd25519(edKp),
    });
    const edCost = L.simulateWithAuth(fn, source, edAuth).instructions;

    // Same operation, passkey account.
    const L2 = new Ledger();
    const d2 = Keypair.random();
    L2.fund(d2.publicKey());
    const src2 = accountIdFromPublicKey(d2.publicKey()).toXDR('base64');
    const pk = createP256Signer();
    const hash2 = L2.seedWasm(CODE);
    const { sent: dep2 } = L2.simulateAndSend(
      createContractHostFn(src2, hash2, Buffer.alloc(32), [
        xdr.ScVal.scvVec([p256Signer(pk)]),
        xdr.ScVal.scvVec([]),
      ]),
      src2,
    );
    const a2 = xdr.ScVal.fromXDR(dep2.returnValueXdr!, 'base64').address();
    const fn2 = invokeHostFn(a2, 'add_signer', [edSigner(Keypair.random())]);
    const rec2 = L2.simulate(fn2, src2);
    const pkAuth = await signAuthEntries(L2, rec2.authXdr, {
      sign: smartAccountSecp256r1(pk),
    });
    const pkCost = L2.simulateWithAuth(fn2, src2, pkAuth).instructions;

    console.log(`  __check_auth instructions: ed25519=${edCost}  secp256r1=${pkCost}`);
    expect(pkCost).toBeGreaterThan(edCost);
  });
});
