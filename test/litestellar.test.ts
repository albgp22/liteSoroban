/**
 * The LiteStellar facade — this is the API a test author should be reading.
 * If a test here is verbose, the abstraction is wrong.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, Networks, xdr } from '@stellar/stellar-sdk';
import { LiteStellar, HostFailure, sc, XLM, type Wallet, type Contract } from '../src/litestellar.js';
import { createP256Signer, smartAccountSecp256r1 } from '../src/auth.js';

const f = (n: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const ADD_I32 = f('add_i32.wasm');
const CONTRACT_DATA = f('contract_data.wasm');
const SMART_ACCOUNT = f('smart_account_current.wasm');

describe('LiteStellar', () => {
  let svm: LiteStellar;

  beforeEach(() => {
    svm = new LiteStellar();
  });

  it('constructs with sane defaults', () => {
    expect(svm.protocolVersion).toBe(27);
    expect(svm.networkPassphrase).toBe(Networks.TESTNET);
    expect(svm.ledgerSequence).toBe(1_000_000);
  });

  it('airdrop creates a funded wallet', () => {
    const alice = svm.airdrop();
    expect(alice.balance()).toBe(10_000n * XLM);
    expect(svm.getBalance(alice.publicKey)).toBe(10_000n * XLM);
    expect(svm.airdrop(5n * XLM).balance()).toBe(50_000_000n);
  });

  it('deploys and invokes a contract in three lines', () => {
    const c = svm.deployContract(ADD_I32);
    expect(c.invoke('add', [sc.i32(2), sc.i32(3)])).toBe(5);
    expect(c.contractId.startsWith('C')).toBe(true);
  });

  it('state persists across invocations', () => {
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(42n)]);
    expect(c.view('get_persistent', [sc.sym('k')])).toBe(42n);
  });

  it('invoke throws a HostFailure with a PARSED error, not a string', () => {
    const c = svm.deployContract(CONTRACT_DATA);
    let caught: HostFailure | undefined;
    try {
      c.invoke('get_persistent', [sc.sym('missing')]);
    } catch (e) {
      caught = e as HostFailure;
    }
    expect(caught).toBeInstanceOf(HostFailure);
    expect(caught!.errorType).toBeTruthy();
    // The raw diagnostics are still there when you need them.
    expect(caught!.raw).toContain('Diagnostic Event');
  });

  it('tryInvoke reports failure without throwing, with resources measured', () => {
    const c = svm.deployContract(CONTRACT_DATA);
    const ok = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    expect(ok.ok).toBe(true);
    expect(ok.instructions).toBeGreaterThan(0);
    expect(ok.footprint.readWrite.length).toBeGreaterThan(0);

    const bad = c.tryInvoke('get_persistent', [sc.sym('nope')]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeInstanceOf(HostFailure);
  });

  it('tokens: deploy, mint, transfer', () => {
    const alice = svm.airdrop();
    const bob = svm.airdrop();
    const usdc = svm.deployToken({ code: 'USDC' });

    usdc.mint(alice, 1_000n);
    usdc.transfer(alice, bob, 250n);

    expect(usdc.balanceOf(alice)).toBe(750n);
    expect(usdc.balanceOf(bob)).toBe(250n);
  });

  it('time travel: warpToLedger and advanceLedgers', () => {
    expect(svm.ledgerSequence).toBe(1_000_000);
    svm.advanceLedgers(5);
    expect(svm.ledgerSequence).toBe(1_000_005);
    svm.warpToLedger(2_000_000);
    expect(svm.ledgerSequence).toBe(2_000_000);
    expect(() => svm.warpToLedger(1)).toThrow(/backwards/);
  });

  it('sandboxed rolls back automatically, even on throw', () => {
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('keep'), sc.u64(1n)]);
    const before = svm.entryCount;

    svm.sandboxed((env) => {
      c.invoke('put_persistent', [sc.sym('temp'), sc.u64(2n)]);
      expect(env.entryCount).toBeGreaterThan(before);
    });
    expect(svm.entryCount).toBe(before);

    expect(() =>
      svm.sandboxed(() => {
        c.invoke('put_persistent', [sc.sym('temp2'), sc.u64(3n)]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(svm.entryCount).toBe(before);
  });

  it('custom account auth is ONE call, not four', () => {
    const passkey = createP256Signer();
    const signer = sc.vec([
      sc.sym('Secp256r1'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(passkey.publicKey) }]),
      sc.vec([sc.sym('Admin')]),
    ]);

    const account = svm.deployContract(SMART_ACCOUNT, { constructorArgs: [sc.vec([signer]), sc.vec([])] });

    const newKp = Keypair.random();
    const newSigner = sc.vec([
      sc.sym('Ed25519'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(newKp.rawPublicKey()) }]),
      sc.vec([sc.sym('Admin')]),
    ]);

    // simulate -> sign auth -> re-simulate enforcing -> apply, in one line.
    account.invoke('add_signer', [newSigner], { signAuth: smartAccountSecp256r1(passkey) });

    expect(
      account.view('has_signer', [sc.vec([sc.sym('Ed25519'), sc.bytes(newKp.rawPublicKey())])]),
    ).toBe(true);
  });

  it('a wrong passkey is still rejected through the facade', () => {
    const passkey = createP256Signer();
    const signer = sc.vec([
      sc.sym('Secp256r1'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(passkey.publicKey) }]),
      sc.vec([sc.sym('Admin')]),
    ]);
    const account = svm.deployContract(SMART_ACCOUNT, { constructorArgs: [sc.vec([signer]), sc.vec([])] });
    const other = sc.vec([
      sc.sym('Ed25519'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(Keypair.random().rawPublicKey()) }]),
      sc.vec([sc.sym('Admin')]),
    ]);

    expect(() =>
      account.invoke('add_signer', [other], { signAuth: smartAccountSecp256r1(createP256Signer()) }),
    ).toThrow(HostFailure);
  });

  it('withSigverify(false) lets an unsigned envelope through', async () => {
    const { TransactionBuilder, Operation, rpc } = await import('@stellar/stellar-sdk');
    const strict = new LiteStellar();
    const w = strict.airdrop(10_000n * XLM, { thresholds: [1, 1, 1, 1] });
    const c = strict.deployContract(CONTRACT_DATA, { as: w });

    const server = strict.rpcServer();
    const build = async (env: LiteStellar) => {
      const account = await server.getAccount(w.publicKey);
      const tx = new TransactionBuilder(account, { fee: '1000', networkPassphrase: env.networkPassphrase })
        .addOperation(
          Operation.invokeHostFunction({
            func: (await import('../src/index.js')).invokeHostFn(c.address, 'put_persistent', [
              sc.sym('a'), sc.u64(1n),
            ]),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build();
      return rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    };

    // Unsigned, thresholds raised: rejected by default.
    expect(strict.sendTransaction((await build(strict)).toXDR()).code).toBe('txBAD_AUTH');

    // Same envelope, sigverify off: accepted.
    strict.withSigverify(false);
    expect(strict.sendTransaction((await build(strict)).toXDR()).ok).toBe(true);
  });

  it('the low-level Ledger is still reachable for plumbing tests', () => {
    expect(svm.ledger).toBeDefined();
    expect(typeof svm.ledger.simulate).toBe('function');
    expect(svm.ledger.protocolVersion).toBe(svm.protocolVersion);
  });

  it('two environments share nothing', () => {
    const a = new LiteStellar();
    const b = new LiteStellar();
    a.deployContract(CONTRACT_DATA);
    expect(a.entryCount).toBeGreaterThan(b.entryCount);
  });
});
