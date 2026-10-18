/**
 * PRECOND_V2 transaction preconditions (CAP-21) as stellar-core v29.0.0
 * evaluates them (src/transactions/TransactionFrame.cpp: getTimeBounds,
 * isTooEarly, isTooLate, isBadSeq, isTooEarlyForAccount, and the extraSigners
 * block that opens commonValidPreSeqNum). Every scenario here was run on a local
 * protocol-29 node (stellar/quickstart: stellar-core 29.0.0, stellar-rpc 29.0.1)
 * and on the harness, both through rpc.Server, on 2026-10-18, comparing the
 * result code, the reported feeCharged, and whether the fee and the sequence
 * number moved. They agreed on all of them.
 *
 * Ledger numbers: `ledger.ledgerSeq` is the ledger a transaction applies in,
 * which is what a node checks ledgerBounds and minSeqLedgerGap against at
 * submission (TransactionQueue passes the last closed ledger + 1). Bounds below
 * are written relative to it; on the node they were written relative to LCL + 1.
 * Through rpc.Server, getLatestLedger reports the last closed ledger,
 * `ledgerSeq - 1`, as a node does, so a client's `latest + 1` is that same
 * ledger (last describe block).
 *
 * Every rejection is at submission: nothing is debited, the sequence number does
 * not move, and the result reports feeCharged = resourceFee + 100, on the node
 * as here.
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

const ADD_I32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/add_i32.wasm', import.meta.url))),
);
const XLM = 10_000_000n;
const FAR = 1n << 40n;

type V2 = Partial<{
  timeBounds: xdr.TimeBounds;
  ledgerBounds: xdr.LedgerBounds;
  minSeqNum: bigint;
  minSeqAge: bigint;
  minSeqLedgerGap: number;
  extraSigners: xdr.SignerKey[];
}>;
const v2 = (o: V2 = {}) =>
  xdr.Preconditions.precondV2(
    new xdr.PreconditionsV2({
      timeBounds: o.timeBounds ?? null,
      ledgerBounds: o.ledgerBounds ?? null,
      minSeqNum: o.minSeqNum ?? null,
      minSeqAge: o.minSeqAge ?? 0n,
      minSeqLedgerGap: o.minSeqLedgerGap ?? 0,
      extraSigners: o.extraSigners ?? [],
    }),
  );
const tb = (min: bigint, max: bigint) =>
  new xdr.TimeBounds({ minTime: min, maxTime: max });
const lb = (minLedger: number, maxLedger: number) => new xdr.LedgerBounds({ minLedger, maxLedger });
const ed = (k: Keypair) => xdr.SignerKey.signerKeyTypeEd25519(k.rawPublicKey());

function world(svm = new LiteStellar()) {
  const contract = svm.deployContract(ADD_I32);
  const server = svm.rpcServer();
  const account = () => {
    const k = Keypair.random();
    svm.ledger.fund(k.publicKey(), { balance: 10_000n * XLM });
    return k;
  };
  const state = (k: Keypair) => {
    const a = svm.getAccount(k.publicKey())!;
    return { seq: a.seqNum, balance: a.balance };
  };
  /**
   * A simulated add(2, 3) from `source` with its preconditions and sequence
   * number replaced, signed by `signers` (default: the source).
   */
  const tx = async (
    source: Keypair,
    o: { cond?: xdr.Preconditions; seq?: bigint; from?: Keypair; signers?: Keypair[] } = {},
  ) => {
    const acct = await server.getAccount(source.publicKey());
    const built = new TransactionBuilder(new Account(source.publicKey(), acct.sequenceNumber()), {
      fee: '100',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({ contract: contract.contractId, function: 'add', args: [sc.i32(2), sc.i32(3)] }),
      )
      .setTimeout(0)
      .build();
    const env = xdr.expectUnionVariant(((await server.prepareTransaction(built)) as Transaction).toEnvelope(), 'envelopeTypeTx').v1;
    const raw = new xdr.Transaction({
      ...env.tx,
      cond: o.cond ?? xdr.Preconditions.precondNone(),
      seqNum: o.seq ?? state(source).seq + 1n,
      sourceAccount: o.from ? o.from.xdrMuxedAccount() : env.tx.sourceAccount,
    });
    const out = new Transaction(
      xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({ ...env, tx: raw })),
      svm.networkPassphrase,
    );
    for (const s of o.signers ?? [o.from ?? source]) out.sign(s);
    return out;
  };
  const send = (t: Transaction | FeeBumpTransaction) => svm.sendTransaction(t.toXdr());
  /** Submit, and check the rejection left the source untouched. */
  const rejected = (t: Transaction, source: Keypair) => {
    const before = state(source);
    const out = send(t);
    expect(out.rejected).toBe(true);
    expect(state(source)).toEqual(before);
    expect(out.feeCharged).toBe(resourceFee(t) + 100n);
    return out.code;
  };
  return { svm, server, account, state, tx, send, rejected };
}

const resourceFee = (t: Transaction) =>
  xdr.expectUnionVariant(xdr.expectUnionVariant(t.toEnvelope(), 'envelopeTypeTx').v1.tx.ext, 'sorobanData').sorobanData
    .resourceFee;

function bump(inner: Transaction, feeSource: Keypair, passphrase: string) {
  const env = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({
      tx: new xdr.FeeBumpTransaction({
        feeSource: feeSource.xdrMuxedAccount(),
        fee: xdr.Int64.fromString(String(resourceFee(inner) + 1000n)),
        innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(xdr.expectUnionVariant(inner.toEnvelope(), 'envelopeTypeTx').v1),
        ext: xdr.FeeBumpTransactionExt.v0(),
      }),
      signatures: [],
    }),
  );
  const fb = new FeeBumpTransaction(env, passphrase);
  fb.sign(feeSource);
  return fb;
}

describe('time bounds carried in PRECOND_V2 (getTimeBounds)', () => {
  it('a maxTime in the past is txTOO_LATE', async () => {
    const w = world();
    const a = w.account();
    expect(w.rejected(await w.tx(a, { cond: v2({ timeBounds: tb(0n, 1n) }) }), a)).toBe('txTOO_LATE');
  });

  it('a minTime in the future is txTOO_EARLY; a window around the close time is accepted', async () => {
    const w = world();
    const a = w.account();
    const now = BigInt(w.svm.ledger.timestamp);
    expect(w.rejected(await w.tx(a, { cond: v2({ timeBounds: tb(FAR, 0n) }) }), a)).toBe('txTOO_EARLY');
    expect(w.send(await w.tx(a, { cond: v2({ timeBounds: tb(now - 100n, now + 600n) }) })).code).toBe('txSUCCESS');
  });
});

describe('ledgerBounds (isTooEarly / isTooLate)', () => {
  it('maxLedger is exclusive: the current ledger is txTOO_LATE, the next one is accepted', async () => {
    const w = world();
    const a = w.account();
    const L = w.svm.ledger.ledgerSeq;
    expect(w.rejected(await w.tx(a, { cond: v2({ ledgerBounds: lb(0, L) }) }), a)).toBe('txTOO_LATE');
    expect(w.send(await w.tx(a, { cond: v2({ ledgerBounds: lb(0, L + 1) }) })).code).toBe('txSUCCESS');
  });

  it('minLedger is inclusive: the next ledger is txTOO_EARLY, the current one is accepted, {0, 0} is no bound', async () => {
    const w = world();
    const a = w.account();
    const L = w.svm.ledger.ledgerSeq;
    expect(w.rejected(await w.tx(a, { cond: v2({ ledgerBounds: lb(L + 1, 0) }) }), a)).toBe('txTOO_EARLY');
    expect(w.send(await w.tx(a, { cond: v2({ ledgerBounds: lb(L, 0) }) })).code).toBe('txSUCCESS');
    expect(w.send(await w.tx(a, { cond: v2({ ledgerBounds: lb(0, 0) }) })).code).toBe('txSUCCESS');
  });
});

describe('minSeqNum relaxes seqNum + 1 to minSeqNum <= account seq < tx seq (isBadSeq)', () => {
  it('lets a transaction jump the sequence, and the account lands on the jump', async () => {
    const w = world();
    const a = w.account();
    const cur = w.state(a).seq;
    const out = w.send(await w.tx(a, { cond: v2({ minSeqNum: cur }), seq: cur + 1000n }));
    expect(out.code).toBe('txSUCCESS');
    expect(w.state(a).seq).toBe(cur + 1000n);
  });

  it('a minSeqNum of 0 is present, not absent: any jump forward goes', async () => {
    const w = world();
    const a = w.account();
    const cur = w.state(a).seq;
    expect(w.send(await w.tx(a, { cond: v2({ minSeqNum: 0n }), seq: cur + 5n })).code).toBe('txSUCCESS');
    expect(w.state(a).seq).toBe(cur + 5n);
  });

  it('outside the range is still txBAD_SEQ: minSeqNum above the account, or a tx seq not above it', async () => {
    const w = world();
    const a = w.account();
    const cur = w.state(a).seq;
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqNum: cur + 1n }), seq: cur + 1000n }), a)).toBe('txBAD_SEQ');
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqNum: cur }), seq: cur }), a)).toBe('txBAD_SEQ');
    // the boundary: minSeqNum equal to the account sequence is inside the range
    expect(w.send(await w.tx(a, { cond: v2({ minSeqNum: cur }), seq: cur + 2n })).code).toBe('txSUCCESS');
  });
});

describe('minSeqAge / minSeqLedgerGap (isTooEarlyForAccount)', () => {
  it('an account with no ext v3 counts from ledger 0 and time 0', async () => {
    const w = world();
    const a = w.account();
    const L = w.svm.ledger.ledgerSeq;
    const now = BigInt(w.svm.ledger.timestamp);
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqLedgerGap: L + 1 }) }), a)).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqAge: now + 1n }) }), a)).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    expect(w.send(await w.tx(a, { cond: v2({ minSeqLedgerGap: L }) })).code).toBe('txSUCCESS');
    const b = w.account();
    expect(w.send(await w.tx(b, { cond: v2({ minSeqAge: now }) })).code).toBe('txSUCCESS');
  });

  it('after a sequence bump, counts from the seqLedger and seqTime it stamped', async () => {
    const w = world();
    const a = w.account();
    expect(w.send(await w.tx(a)).code).toBe('txSUCCESS'); // stamps ledgerSeq / timestamp
    w.svm.advanceLedgers(3); // 3 ledgers, 15 seconds
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqLedgerGap: 4 }) }), a)).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    expect(w.rejected(await w.tx(a, { cond: v2({ minSeqAge: 16n }) }), a)).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    expect(w.send(await w.tx(a, { cond: v2({ minSeqLedgerGap: 3, minSeqAge: 15n }) })).code).toBe('txSUCCESS');
  });

  it('is ERROR txBadMinSeqAgeOrGap through rpc', async () => {
    const w = world();
    const a = w.account();
    const sent = await w.server.sendTransaction(
      await w.tx(a, { cond: v2({ minSeqLedgerGap: w.svm.ledger.ledgerSeq + 1 }) }),
    );
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result.type).toBe('txBadMinSeqAgeOrGap');
  });
});

describe('extraSigners XDR validation (commonValidPreSeqNum)', () => {
  it('two identical extraSigners are txMALFORMED, even with the signature there', async () => {
    const w = world();
    const [a, e] = [w.account(), Keypair.random()];
    const t = await w.tx(a, { cond: v2({ extraSigners: [ed(e), ed(e)] }), signers: [a, e] });
    expect(w.rejected(t, a)).toBe('txMALFORMED');
  });

  it('an ed25519SignedPayload extraSigner with an empty payload is txMALFORMED', async () => {
    const w = world();
    const [a, e] = [w.account(), Keypair.random()];
    const empty = xdr.SignerKey.signerKeyTypeEd25519SignedPayload(
      new xdr.SignerKeyEd25519SignedPayload({ ed25519: e.rawPublicKey(), payload: Buffer.alloc(0) }),
    );
    expect(w.rejected(await w.tx(a, { cond: v2({ extraSigners: [empty] }) }), a)).toBe('txMALFORMED');
  });
});

describe("which code wins when several apply: core's check order", () => {
  type Build = Parameters<ReturnType<typeof world>['tx']>[1];
  type C = { cur: bigint; L: number; e: Keypair; x: Keypair; a: Keypair };
  // [name, both conditions, the code that wins, the losing condition alone, its own code]
  const cases: [string, (c: C) => Build, string, (c: C) => Build, string][] = [
    ['identical extraSigners + maxTime past',
      (c) => ({ cond: v2({ extraSigners: [ed(c.e), ed(c.e)], timeBounds: tb(0n, 1n) }), signers: [c.a, c.e] }), 'txMALFORMED',
      () => ({ cond: v2({ timeBounds: tb(0n, 1n) }) }), 'txTOO_LATE'],
    ['V2 maxTime past + a stale sequence',
      (c) => ({ cond: v2({ timeBounds: tb(0n, 1n) }), seq: c.cur + 7n }), 'txTOO_LATE',
      (c) => ({ seq: c.cur + 7n }), 'txBAD_SEQ'],
    ['PRECOND_TIME maxTime past + a stale sequence',
      (c) => ({ cond: xdr.Preconditions.precondTime(tb(0n, 1n)), seq: c.cur + 7n }), 'txTOO_LATE',
      (c) => ({ seq: c.cur + 7n }), 'txBAD_SEQ'],
    ['maxLedger reached + a source account that does not exist',
      (c) => ({ cond: v2({ ledgerBounds: lb(0, c.L) }), from: c.x }), 'txTOO_LATE',
      (c) => ({ from: c.x }), 'txNO_ACCOUNT'],
    ['minLedger ahead + maxTime past (isTooEarly runs first)',
      (c) => ({ cond: v2({ ledgerBounds: lb(c.L + 50, 0), timeBounds: tb(0n, 1n) }) }), 'txTOO_EARLY',
      () => ({ cond: v2({ timeBounds: tb(0n, 1n) }) }), 'txTOO_LATE'],
    ['maxLedger reached + minTime ahead',
      (c) => ({ cond: v2({ ledgerBounds: lb(0, c.L), timeBounds: tb(FAR, 0n) }) }), 'txTOO_EARLY',
      (c) => ({ cond: v2({ ledgerBounds: lb(0, c.L) }) }), 'txTOO_LATE'],
    ['minSeqLedgerGap unmet + a stale sequence',
      (c) => ({ cond: v2({ minSeqLedgerGap: c.L + 1 }), seq: c.cur + 7n }), 'txBAD_SEQ',
      (c) => ({ cond: v2({ minSeqLedgerGap: c.L + 1 }) }), 'txBAD_MIN_SEQ_AGE_OR_GAP'],
    ['minSeqLedgerGap unmet + no signature',
      (c) => ({ cond: v2({ minSeqLedgerGap: c.L + 1 }), signers: [] }), 'txBAD_MIN_SEQ_AGE_OR_GAP',
      () => ({ signers: [] }), 'txBAD_AUTH'],
    ['minSeqAge unmet + an extraSigner that did not sign',
      (c) => ({ cond: v2({ minSeqAge: FAR, extraSigners: [ed(c.e)] }) }), 'txBAD_MIN_SEQ_AGE_OR_GAP',
      (c) => ({ cond: v2({ extraSigners: [ed(c.e)] }) }), 'txBAD_AUTH'],
    ['minSeqNum above the account + minSeqLedgerGap unmet',
      (c) => ({ cond: v2({ minSeqNum: c.cur + 1n, minSeqLedgerGap: c.L + 1 }), seq: c.cur + 9n }), 'txBAD_SEQ',
      (c) => ({ cond: v2({ minSeqNum: c.cur, minSeqLedgerGap: c.L + 1 }), seq: c.cur + 9n }), 'txBAD_MIN_SEQ_AGE_OR_GAP'],
  ];
  for (const [name, both, winner, alone, loser] of cases) {
    it(`${name}: ${winner} (alone, the other is ${loser})`, async () => {
      const w = world();
      const a = w.account();
      const c = { a, cur: w.state(a).seq, L: w.svm.ledger.ledgerSeq, e: Keypair.random(), x: Keypair.random() };
      expect(w.rejected(await w.tx(a, both(c)), a)).toBe(winner);
      expect(w.rejected(await w.tx(a, alone(c)), a)).toBe(loser);
    });
  }
});

describe('under a fee bump, the inner transaction is judged the same way', () => {
  it('an inner maxLedger already reached: txFEE_BUMP_INNER_FAILED / txTOO_LATE, nobody pays', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.tx(a, { cond: v2({ ledgerBounds: lb(0, w.svm.ledger.ledgerSeq) }) });
    const [aBefore, fBefore] = [w.state(a), w.state(f)];
    const out = w.send(bump(inner, f, w.svm.networkPassphrase));
    expect([out.code, out.innerCode]).toEqual(['txFEE_BUMP_INNER_FAILED', 'txTOO_LATE']);
    expect([w.state(a), w.state(f)]).toEqual([aBefore, fBefore]);
  });

  it('an inner minSeqNum jump goes through, and the inner source lands on it', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const cur = w.state(a).seq;
    const out = w.send(bump(await w.tx(a, { cond: v2({ minSeqNum: cur }), seq: cur + 50n }), f, w.svm.networkPassphrase));
    expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    expect(w.state(a).seq).toBe(cur + 50n);
  });

  it('an inner minSeqLedgerGap unmet: txFEE_BUMP_INNER_FAILED / txBAD_MIN_SEQ_AGE_OR_GAP', async () => {
    const w = world();
    const [a, f] = [w.account(), w.account()];
    const inner = await w.tx(a, { cond: v2({ minSeqLedgerGap: w.svm.ledger.ledgerSeq + 1 }) });
    const out = w.send(bump(inner, f, w.svm.networkPassphrase));
    expect([out.code, out.innerCode]).toEqual(['txFEE_BUMP_INNER_FAILED', 'txBAD_MIN_SEQ_AGE_OR_GAP']);
  });
});

describe('ledger bounds a client writes from getLatestLedger', () => {
  it('maxLedger = latest + 1 is already txTOO_LATE (exclusive)', async () => {
    const w = world();
    const a = w.account();
    const latest = (await w.server.getLatestLedger()).sequence;
    const sent = await w.server.sendTransaction(await w.tx(a, { cond: v2({ ledgerBounds: lb(0, latest + 1) }) }));
    expect([sent.status, sent.errorResult?.result.type]).toEqual(['ERROR', 'txTooLate']);
  });

  it('minLedger = latest + 1 is met, and the transaction lands in that ledger', async () => {
    const w = world();
    const a = w.account();
    const latest = (await w.server.getLatestLedger()).sequence;
    const sent = await w.server.sendTransaction(await w.tx(a, { cond: v2({ ledgerBounds: lb(latest + 1, 0) }) }));
    expect(sent.status).toBe('PENDING');
    const got = await w.server.getTransaction(sent.hash);
    expect([got.status, got.ledger]).toEqual(['SUCCESS', latest + 1]);
  });
});

describe('the validation switches (a harness feature, nothing to compare with a node)', () => {
  it('withTimebounds(false) also skips ledgerBounds, minSeqAge and minSeqLedgerGap; withSequenceCheck(false) the minSeqNum range', async () => {
    const strict = world();
    const s = strict.account();
    const L = strict.svm.ledger.ledgerSeq;
    const cond = v2({ ledgerBounds: lb(L + 1, L + 2), minSeqAge: FAR, minSeqLedgerGap: L + 1 });
    expect(strict.rejected(await strict.tx(s, { cond }), s)).toBe('txTOO_EARLY');

    const lax = world(new LiteStellar().withTimebounds(false).withSequenceCheck(false));
    const a = lax.account();
    expect(lax.send(await lax.tx(a, { cond })).code).toBe('txSUCCESS');
    const cur = lax.state(a).seq;
    expect(lax.send(await lax.tx(a, { cond: v2({ minSeqNum: cur + 10n }), seq: cur + 3n })).code).toBe('txSUCCESS');
  });
});
