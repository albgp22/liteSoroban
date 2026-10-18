/**
 * Classic-layer validation that a local protocol-29 network (stellar/quickstart:
 * stellar-core 29.0.0, stellar-rpc 29.0.1) was observed to perform, scenario
 * for scenario: signature consumption, operation thresholds, extraSigners,
 * fee-bump fee rules, and fee-field validity. Each comment names the core
 * function the rule comes from (src/transactions/, v29.0.0).
 *
 * The one thing every rejection here shares, on the node and in the harness:
 * it happens at submission, so no fee is taken and no sequence number is used.
 * The result still reports a feeCharged, which core seeds in checkValid as the
 * declared resource fee + baseFee * operations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc } from '../src/litestellar.js';
import type { FundOptions } from '../src/classic.js';

const ADD_I32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/add_i32.wasm', import.meta.url))),
);
const XLM = 10_000_000n;

function world() {
  const svm = new LiteStellar();
  const contract = svm.deployContract(ADD_I32);
  const server = svm.rpcServer();
  const account = (opts: FundOptions = {}) => {
    const k = Keypair.random();
    svm.ledger.fund(k.publicKey(), { balance: 10_000n * XLM, ...opts });
    return k;
  };
  const state = (k: Keypair) => {
    const a = svm.getAccount(k.publicKey())!;
    return { seq: a.seqNum().toString(), balance: a.balance().toString() };
  };
  /** A simulated, assembled add(2, 3) from `source`, unsigned. */
  const addTx = async (
    source: Keypair,
    o: { opSource?: string; extraSigners?: string[]; inclusion?: number } = {},
  ) => {
    const acct = await server.getAccount(source.publicKey());
    const tx = new TransactionBuilder(new Account(source.publicKey(), acct.sequenceNumber()), {
      fee: String(o.inclusion ?? 100),
      networkPassphrase: svm.networkPassphrase,
      ...(o.extraSigners && { extraSigners: o.extraSigners }),
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contract.contractId,
          function: 'add',
          args: [sc.i32(2), sc.i32(3)],
          ...(o.opSource && { source: o.opSource }),
        }),
      )
      .setTimeout(300)
      .build();
    return (await server.prepareTransaction(tx)) as Transaction;
  };
  const send = (tx: Transaction | FeeBumpTransaction) => svm.sendTransaction(tx.toXDR());
  return { svm, server, account, state, addTx, send };
}

const resourceFee = (tx: Transaction) =>
  BigInt(tx.toEnvelope().v1().tx().ext().sorobanData().resourceFee().toString());

function bump(inner: Transaction, feeSource: Keypair, inclusion: bigint, signers: Keypair[], passphrase: string) {
  const env = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({
      tx: new xdr.FeeBumpTransaction({
        feeSource: feeSource.xdrMuxedAccount(),
        fee: xdr.Int64.fromString(String(resourceFee(inner) + inclusion)),
        innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(inner.toEnvelope().v1()),
        ext: new xdr.FeeBumpTransactionExt(0),
      }),
      signatures: [],
    }),
  );
  const fb = new FeeBumpTransaction(env, passphrase);
  for (const s of signers) fb.sign(s);
  return fb;
}

describe('signatures: every one must be consumed (SignatureChecker::checkAllSignaturesUsed)', () => {
  const cases: [string, FundOptions | ((c: Keypair) => FundOptions), (a: Keypair, c: Keypair) => Keypair[]][] = [
    ['an unrelated extra signature', {}, (a) => [a, Keypair.random()]],
    ['the same signature twice', {}, (a) => [a, a]],
    // LOW and MEDIUM are each met by the first signature, and a check stops as
    // soon as its weight is reached, so the cosigner's is never consumed.
    ['a valid but superfluous cosigner', (c) => ({ thresholds: [1, 1, 1, 1], signers: [{ key: c.publicKey(), weight: 1 }] }), (a, c) => [a, c]],
    // A weight-0 master key is not a signer, so its signature is never consumed.
    ['the master key of a master-weight-0 account', (c) => ({ thresholds: [0, 1, 1, 1], signers: [{ key: c.publicKey(), weight: 1 }] }), (a, c) => [a, c]],
  ];
  for (const [name, opts, signers] of cases) {
    it(`rejects ${name} with txBAD_AUTH_EXTRA, before any fee`, async () => {
      const w = world();
      const c = Keypair.random();
      const a = w.account(typeof opts === 'function' ? opts(c) : opts);
      const tx = await w.addTx(a);
      for (const s of signers(a, c)) tx.sign(s);
      const before = w.state(a);
      const out = w.send(tx);
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
      expect(out.rejected).toBe(true);
      expect(w.state(a)).toEqual(before);
      expect(out.feeCharged).toBe(resourceFee(tx) + 100n); // reported, not debited
    });
  }

  it('the weight-0 master account is fine when only the cosigner signs', async () => {
    const w = world();
    const c = Keypair.random();
    const a = w.account({ thresholds: [0, 1, 1, 1], signers: [{ key: c.publicKey(), weight: 1 }] });
    const tx = await w.addTx(a);
    tx.sign(c);
    expect(w.send(tx).code).toBe('txSUCCESS');
  });
});

describe('operation signatures are checked at submission (OperationFrame::checkValid)', () => {
  it('an operation short of MEDIUM is ERROR txFAILED [opBAD_AUTH] through rpc, with nothing taken', async () => {
    const w = world();
    const c = Keypair.random();
    const a = w.account({ thresholds: [1, 1, 2, 2], signers: [{ key: c.publicKey(), weight: 1 }] });
    const tx = await w.addTx(a);
    tx.sign(a); // weight 1: meets LOW (tx level), not MEDIUM (InvokeHostFunction)
    const before = w.state(a);
    const sent = await w.server.sendTransaction(tx);
    expect(sent.status).toBe('ERROR');
    const r = sent.errorResult!.result();
    expect(r.switch().name).toBe('txFailed');
    expect(r.results()[0].switch().name).toBe('opBadAuth');
    expect(w.state(a)).toEqual(before);
  });

  it('a nonexistent operation source that signs is APPLIED and fails with opNO_ACCOUNT', async () => {
    const w = world();
    const a = w.account();
    const ghost = Keypair.random();
    const tx = await w.addTx(a, { opSource: ghost.publicKey() });
    tx.sign(a);
    tx.sign(ghost); // checkSignatureNoAccount: needs the ghost key's own signature
    const before = w.state(a);
    const out = w.send(tx);
    expect(out.code).toBe('txFAILED');
    expect(out.opCode).toBe('opNO_ACCOUNT');
    expect(out.rejected).toBeFalsy();
    expect(w.state(a).seq).not.toBe(before.seq);
  });

  it('a nonexistent operation source that does not sign is rejected with opBAD_AUTH', async () => {
    const w = world();
    const a = w.account();
    const tx = await w.addTx(a, { opSource: Keypair.random().publicKey() });
    tx.sign(a);
    const out = w.send(tx);
    expect([out.code, out.opCode, out.rejected]).toEqual(['txFAILED', 'opBAD_AUTH', true]);
  });
});

describe('PRECOND_V2 extraSigners (TransactionFrame::checkExtraSigners)', () => {
  it('each extra signer must sign: txBAD_AUTH without it, success with it', async () => {
    const w = world();
    const a = w.account();
    const k = Keypair.random();
    const missing = await w.addTx(a, { extraSigners: [k.publicKey()] });
    missing.sign(a);
    expect(w.send(missing).code).toBe('txBAD_AUTH');

    const both = await w.addTx(a, { extraSigners: [k.publicKey()] });
    both.sign(a);
    both.sign(k);
    expect(w.send(both).code).toBe('txSUCCESS');
  });
});

describe('fee bumps (FeeBumpTransactionFrame::commonValidPreSeqNum / checkValidImpl)', () => {
  it('needs an inclusion fee of at least baseFee * (innerOps + 1)', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.addTx(a);
    inner.sign(a);
    expect(w.send(bump(inner, f, 199n, [f], w.svm.networkPassphrase)).code).toBe('txINSUFFICIENT_FEE');
    expect(w.send(bump(inner, f, 200n, [f], w.svm.networkPassphrase)).code).toBe('txFEE_BUMP_INNER_SUCCESS');
  });

  it('must raise the per-operation rate, and reports the fee it would need', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.addTx(a, { inclusion: 1000 });
    inner.sign(a);
    // v1 = 1500 * 100 < v2 = 1000 * 200 -> needs ceil(200_000 / 100) = 2000
    const out = w.send(bump(inner, f, 1500n, [f], w.svm.networkPassphrase));
    expect([out.code, out.feeCharged, out.rejected]).toEqual(['txINSUFFICIENT_FEE', 2000n, true]);
  });

  it('an extra OUTER signature is txBAD_AUTH_EXTRA on the fee bump itself', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.addTx(a);
    inner.sign(a);
    const out = w.send(bump(inner, f, 400n, [f, Keypair.random()], w.svm.networkPassphrase));
    expect(out.code).toBe('txBAD_AUTH_EXTRA');
    expect(out.feeCharged).toBe(resourceFee(inner) + 200n);
  });

  it('an inner rejection rejects the whole fee bump, and the fee source pays nothing', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.addTx(a);
    inner.sign(a);
    inner.sign(Keypair.random());
    const fb = bump(inner, f, 400n, [f], w.svm.networkPassphrase);
    const [fBefore, aBefore] = [w.state(f), w.state(a)];
    const sent = await w.server.sendTransaction(fb);
    expect(sent.status).toBe('ERROR');
    const pair = sent.errorResult!.result().innerResultPair();
    expect(pair.transactionHash().equals(fb.innerTransaction.hash())).toBe(true);
    expect(pair.result().result().switch().name).toBe('txBadAuthExtra');
    expect([w.state(f), w.state(a)]).toEqual([fBefore, aBefore]);
  });
});

describe('fee-field validity comes first (TransactionFrame::XDRProvidesValidFee)', () => {
  /** Re-wrap a prepared tx after editing its XDR, then sign it. */
  const edited = (tx: Transaction, edit: (raw: xdr.Transaction) => void, passphrase: string, signer: Keypair) => {
    const env = tx.toEnvelope();
    edit(env.v1().tx());
    const out = new Transaction(env, passphrase);
    out.sign(signer);
    return out;
  };

  it('no SorobanTransactionData is txMALFORMED with feeCharged 0, even with a stale sequence', async () => {
    const w = world();
    const a = w.account({ seqNum: 10n });
    const tx = edited(await w.addTx(a), (raw) => {
      raw.seqNum(new xdr.SequenceNumber(new xdr.Int64(3n))); // stale: the account is at 10
      raw.ext(new xdr.TransactionExt(0));
    }, w.svm.networkPassphrase, a);
    const out = w.send(tx);
    expect([out.code, out.feeCharged, out.rejected]).toEqual(['txMALFORMED', 0n, true]);
  });

  it('a negative resource fee is txMALFORMED with feeCharged 0', async () => {
    const w = world();
    const a = w.account();
    const tx = edited(await w.addTx(a), (raw) => {
      raw.ext().sorobanData().resourceFee(new xdr.Int64(-1n));
    }, w.svm.networkPassphrase, a);
    const out = w.send(tx);
    expect([out.code, out.feeCharged]).toEqual(['txMALFORMED', 0n]);
  });

  it("an inner tx without SorobanTransactionData is the fee bump's own txMALFORMED", async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = edited(await w.addTx(a), (raw) => raw.ext(new xdr.TransactionExt(0)), w.svm.networkPassphrase, a);
    const env = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
      new xdr.FeeBumpTransactionEnvelope({
        tx: new xdr.FeeBumpTransaction({
          feeSource: f.xdrMuxedAccount(),
          fee: new xdr.Int64(1_000_000n),
          innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(inner.toEnvelope().v1()),
          ext: new xdr.FeeBumpTransactionExt(0),
        }),
        signatures: [],
      }),
    );
    const fb = new FeeBumpTransaction(env, w.svm.networkPassphrase);
    fb.sign(f);
    const out = w.send(fb);
    expect([out.code, out.innerCode, out.feeCharged]).toEqual(['txMALFORMED', undefined, 0n]);
  });
});
