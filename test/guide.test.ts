/**
 * Executable GUIDE.md.
 *
 * Every snippet in the guide has a test here. If the API moves and the guide
 * stops being true, this file goes red — which is the only way documentation
 * stays honest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Keypair,
  Operation,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk';
import { LiteStellar, HostFailure, sc, XLM, type Wallet } from '../src/litestellar.js';
import { invokeHostFn } from '../src/index.js';
import { createP256Signer, smartAccountSecp256r1, type P256Signer } from '../src/auth.js';

const f = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const ADD_I32 = f('add_i32.wasm');
const CONTRACT_DATA = f('contract_data.wasm');
const SMART_ACCOUNT = f('smart_account_current.wasm');

describe('GUIDE.md', () => {
  let svm: LiteStellar;

  beforeEach(() => {
    svm = new LiteStellar();
  });

  it('Five minutes', () => {
    const alice = svm.airdrop();
    const c = svm.deployContract(ADD_I32);
    expect(c.invoke('add', [sc.i32(2), sc.i32(3)])).toBe(5);
    expect(alice.balance()).toBe(10_000n * XLM);
  });

  it('Accounts and XLM', () => {
    const cosigner = Keypair.random();
    const alice = svm.airdrop();
    const poor = svm.airdrop(5n * XLM);
    const multi = svm.airdrop(100n * XLM, {
      thresholds: [1, 1, 2, 3],
      signers: [{ key: cosigner.publicKey(), weight: 1 }],
    });

    expect(alice.balance()).toBe(10_000n * XLM);
    expect(poor.balance()).toBe(5n * XLM);
    expect(alice.sequence()).toBe(0n);
    expect(alice.publicKey.startsWith('G')).toBe(true);
    expect(alice.scAddress).toBeInstanceOf(xdr.ScVal);
    expect(svm.getAccount(multi.publicKey)!.thresholds()[2]).toBe(2);

    // svm.fund wraps a keypair you already hold
    const kp = Keypair.random();
    expect(svm.fund(kp).publicKey).toBe(kp.publicKey());
  });

  it('Contracts', () => {
    const alice = svm.airdrop();
    const c = svm.deployContract(CONTRACT_DATA);
    const d = svm.deployContract(CONTRACT_DATA, { as: alice });
    expect(c.contractId).not.toBe(d.contractId);

    c.invoke('put_persistent', [sc.sym('k'), sc.u64(42n)]);
    expect(c.view('get_persistent', [sc.sym('k')])).toBe(42n);

    const bad = c.tryInvoke('get_persistent', [sc.sym('nope')]);
    expect(bad.ok).toBe(false);

    expect(svm.contractAt(c.contractId).contractId).toBe(c.contractId);
  });

  it('sc argument helpers all produce ScVals', () => {
    const all = [
      sc.sym('a'), sc.str('a'), sc.u32(1), sc.i32(-1), sc.u64(1n), sc.i64(-1n),
      sc.u128(1n), sc.i128(-1n), sc.bool(true), sc.bytes(Buffer.alloc(4)),
      sc.vec([sc.u32(1)]), sc.map([{ key: sc.sym('k'), val: sc.u32(1) }]), sc.void(),
    ];
    for (const v of all) expect(v).toBeInstanceOf(xdr.ScVal);
    expect(sc.address(svm.airdrop())).toBeInstanceOf(xdr.ScVal);
  });

  it('Tokens', () => {
    const alice = svm.airdrop();
    const bob = svm.airdrop();

    const usdc = svm.deployToken({ code: 'USDC' });
    usdc.mint(alice, 1_000n);
    usdc.transfer(alice, bob, 250n);

    expect(usdc.balanceOf(bob)).toBe(250n);
    expect(usdc.balanceOf(alice)).toBe(750n);
    expect(usdc.decimals()).toBe(7);
    expect(usdc.contractId.startsWith('C')).toBe(true);

    const xlm = svm.nativeToken();
    expect(xlm.balanceOf(alice)).toBe(alice.balance());

    // explicit trustline control
    const carol = svm.airdrop();
    expect(usdc.balanceOrZero(carol)).toBe(0n);
    usdc.trust(carol);
    expect(usdc.balanceOf(carol)).toBe(0n);
  });

  it('Custom accounts and passkeys', () => {
    const passkey = createP256Signer();
    const signerFor = (p: P256Signer) =>
      sc.vec([
        sc.sym('Secp256r1'),
        sc.map([{ key: sc.sym('public_key'), val: sc.bytes(p.publicKey) }]),
        sc.vec([sc.sym('Admin')]),
      ]);

    const account = svm.deployContract(SMART_ACCOUNT, {
      constructorArgs: [sc.vec([signerFor(passkey)]), sc.vec([])],
    });

    const newKp = Keypair.random();
    const newSigner = sc.vec([
      sc.sym('Ed25519'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(newKp.rawPublicKey()) }]),
      sc.vec([sc.sym('Admin')]),
    ]);

    account.invoke('add_signer', [newSigner], { signAuth: smartAccountSecp256r1(passkey) });

    expect(
      account.view('has_signer', [sc.vec([sc.sym('Ed25519'), sc.bytes(newKp.rawPublicKey())])]),
    ).toBe(true);
  });

  it('Test isolation', () => {
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('keep'), sc.u64(1n)]);

    const before = svm.stateHash();
    svm.sandboxed(() => {
      c.invoke('put_persistent', [sc.sym('tmp'), sc.u64(1n)]);
    });
    expect(svm.stateHash()).toBe(before);

    const snap = svm.snapshot();
    c.invoke('put_persistent', [sc.sym('x'), sc.u64(2n)]);
    svm.restore(snap);
    expect(svm.stateHash()).toBe(before);

    // sandboxed rolls back even when the body throws
    expect(() => svm.sandboxed(() => { throw new Error('boom'); })).toThrow('boom');
    expect(svm.stateHash()).toBe(before);
  });

  it('Time travel', () => {
    svm.advanceLedgers(100);
    expect(svm.ledgerSequence).toBe(1_000_100);
    svm.warpToLedger(2_000_000);
    expect(svm.ledgerSequence).toBe(2_000_000);
    svm.setTimestamp(1_800_000_000);
    expect(svm.timestamp).toBe(1_800_000_000);

    // the clock is part of a snapshot
    const snap = svm.snapshot();
    svm.advanceLedgers(500);
    svm.restore(snap);
    expect(svm.ledgerSequence).toBe(2_000_000);
  });

  it('Asserting on failures', () => {
    const c = svm.deployContract(CONTRACT_DATA);

    let caught: HostFailure | undefined;
    try {
      c.invoke('get_persistent', [sc.sym('missing')]);
    } catch (e) {
      caught = e as HostFailure;
    }
    expect(caught).toBeInstanceOf(HostFailure);
    expect(caught!.errorType).toBeTruthy();
    expect(typeof caught!.is('Storage')).toBe('boolean');
    expect(caught!.raw).toContain('Diagnostic Event');

    const r = c.tryInvoke('get_persistent', [sc.sym('nope')]);
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(HostFailure);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(Array.isArray(r.events)).toBe(true);
  });

  it('Asserting on resources', () => {
    const calibrated = new LiteStellar().withNetworkCostParams();
    expect(calibrated.metersLikeNetwork).toBe(true);
    expect(new LiteStellar().metersLikeNetwork).toBe(false);

    const c = calibrated.deployContract(CONTRACT_DATA);
    const r = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    expect(r.instructions).toBeGreaterThan(0);
    expect(r.writeBytes).toBeGreaterThan(0);
    expect(r.footprint.readOnly.length + r.footprint.readWrite.length).toBeGreaterThan(0);
  });

  it('Testing your app unchanged', async () => {
    const alice = svm.airdrop();
    const c = svm.deployContract(CONTRACT_DATA, { as: alice });

    const server = svm.rpcServer();
    const account = await server.getAccount(alice.publicKey);

    const tx = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(7n)]),
          auth: [],
        }),
      )
      .setTimeout(300)
      .build();

    const assembled = rpc
      .assembleTransaction(tx, await server.simulateTransaction(tx))
      .build();
    assembled.sign(alice.keypair);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('PENDING');
    const got = await server.pollTransaction(sent.hash);
    expect(got.status).toBe('SUCCESS');

    expect(c.view('get_persistent', [sc.sym('k')])).toBe(7n);
  });

  it('the classic escape hatches chain', () => {
    const relaxed = new LiteStellar()
      .withSigverify(false)
      .withSequenceCheck(false)
      .withFeeCharging(false)
      .withTimebounds(false);
    expect(relaxed).toBeInstanceOf(LiteStellar);
    expect(new LiteStellar().withoutClassicChecks()).toBeInstanceOf(LiteStellar);
  });

  it('Dropping to the low level', () => {
    const alice = svm.airdrop();
    const c = svm.deployContract(CONTRACT_DATA, { as: alice });
    const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);

    const sim = svm.ledger.simulate(hostFn, alice.accountIdB64);
    expect(sim.ok).toBe(true);

    const sent = svm.ledger.send(
      hostFn, alice.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(true);

    expect(svm.allKeys().length).toBe(svm.entryCount);
    const key = svm.allKeys()[0];
    expect(svm.getEntry(key)).toBeTruthy();
  });

  describe('Gotchas', () => {
    it('an unsigned transaction is rejected even at medium threshold 0', async () => {
      const alice = svm.airdrop();
      expect(svm.getAccount(alice.publicKey)!.thresholds()[2]).toBe(0);

      const c = svm.deployContract(CONTRACT_DATA, { as: alice });
      const server = svm.rpcServer();
      const account = await server.getAccount(alice.publicKey);
      const tx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: svm.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build();
      const assembled = rpc
        .assembleTransaction(tx, await server.simulateTransaction(tx))
        .build();
      // deliberately unsigned
      const sent = await server.sendTransaction(assembled);
      expect(sent.status).toBe('ERROR');
    });

    it('balanceOf throws without a trustline; balanceOrZero does not', () => {
      const w = svm.airdrop();
      const usdc = svm.deployToken();
      expect(() => usdc.balanceOf(w)).toThrow(/trustline/);
      expect(usdc.balanceOrZero(w)).toBe(0n);
    });

    it('simulation does not run __check_auth, so signAuth is required', () => {
      const passkey = createP256Signer();
      const account = svm.deployContract(SMART_ACCOUNT, {
        constructorArgs: [
          sc.vec([
            sc.vec([
              sc.sym('Secp256r1'),
              sc.map([{ key: sc.sym('public_key'), val: sc.bytes(passkey.publicKey) }]),
              sc.vec([sc.sym('Admin')]),
            ]),
          ]),
          sc.vec([]),
        ],
      });
      const newSigner = sc.vec([
        sc.sym('Ed25519'),
        sc.map([{ key: sc.sym('public_key'), val: sc.bytes(Keypair.random().rawPublicKey()) }]),
        sc.vec([sc.sym('Admin')]),
      ]);

      // green in simulation...
      expect(account.simulate('add_signer', [newSigner]).ok).toBe(true);
      // ...red on submit without a proof
      expect(() => account.invoke('add_signer', [newSigner])).toThrow(HostFailure);
      // ...green with one
      expect(() =>
        account.invoke('add_signer', [newSigner], { signAuth: smartAccountSecp256r1(passkey) }),
      ).not.toThrow();
    });

    it('the protocol pin fails loudly', () => {
      expect(() => new LiteStellar({ protocolVersion: 28 })).toThrow(/protocol 27/);
    });

    it('deploying twice from one account does not collide', () => {
      const alice = svm.airdrop();
      const a = svm.deployContract(CONTRACT_DATA, { as: alice });
      const b = svm.deployContract(CONTRACT_DATA, { as: alice });
      expect(a.contractId).not.toBe(b.contractId);
    });
  });
});
