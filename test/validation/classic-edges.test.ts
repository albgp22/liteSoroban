/**
 * Exhaustive classic-layer edge cases.
 *
 * Every expectation in this file is derived from stellar-core master, not from
 * what the harness happens to return. Line references are to
 *   core-src/src/transactions/{TransactionFrame,FeeBumpTransactionFrame,
 *                              OperationFrame,SignatureChecker}.cpp
 *
 * The order of validation in core (TransactionFrame::commonValid ->
 * commonValidPreSeqNum) is, for a v1 Soroban envelope:
 *
 *   1. numOperations == 0                        -> txMISSING_OPERATION   (:1335)
 *   2. validateSorobanOpsConsistency             -> txMALFORMED           (:1331)
 *   3. validateSorobanMemo (P25+)                -> txSOROBAN_INVALID     (:1348)
 *   4. sorobanData.resourceFee > fullFee         -> txSOROBAN_INVALID     (:1374)
 *   5. isTooEarly / isTooLate                    -> txTOO_EARLY/TOO_LATE  (:1476,:1482)
 *   6. inclusionFee < minInclusionFee            -> txINSUFFICIENT_FEE    (:1489)
 *   7. source account missing                    -> txNO_ACCOUNT          (:1503)
 *   8. isBadSeq                                  -> txBAD_SEQ            (:1686)
 *   9. checkAllTransactionSignatures (LOW thr.)  -> txBAD_AUTH           (:1707)
 *  10. availableBalance < fullFee                -> txINSUFFICIENT_BALANCE(:1727)
 *  11. per-operation checkValid (MED threshold)  -> txFAILED             (:1918)
 *  12. checkAllSignaturesUsed                    -> txBAD_AUTH_EXTRA     (:1923)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Keypair,
  Networks,
  Operation,
  Asset,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import {
  accountIdFromPublicKey,
  loadAccount,
  BASE_FEE,
  BASE_RESERVE,
  type TxOutcome,
} from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);

const NET = Networks.TESTNET;
const NETWORK_ID = sha256(NET);

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');

const plain = (pk: string) =>
  xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
const muxed = (pk: string, id = 7n) =>
  xdr.MuxedAccount.keyTypeMuxedEd25519(
    new xdr.MuxedAccountMed25519({
      id: xdr.Uint64.fromString(id.toString()),
      ed25519: StrKey.decodeEd25519PublicKey(pk),
    }),
  );

/** A plausible declared Soroban resource fee. The harness never recomputes it. */
const RESOURCE_FEE = 500_000n;

// ---------------------------------------------------------------------------
// envelope construction, done at the XDR level so every field is controllable
// ---------------------------------------------------------------------------

interface Spec {
  source: xdr.MuxedAccount;
  seqNum: bigint;
  /** Total transaction fee (inclusion + resource). */
  fee: bigint;
  ops: xdr.Operation[];
  sorobanData?: xdr.SorobanTransactionData | null;
  memo?: xdr.Memo;
  cond?: xdr.Preconditions;
}

function rawTx(s: Spec): xdr.Transaction {
  return new xdr.Transaction({
    sourceAccount: s.source,
    fee: Number(s.fee),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(s.seqNum)),
    cond: s.cond ?? xdr.Preconditions.precondNone(),
    memo: s.memo ?? xdr.Memo.memoNone(),
    operations: s.ops,
    ext:
      s.sorobanData === null
        ? new xdr.TransactionExt(0)
        : new xdr.TransactionExt(1, s.sorobanData!),
  });
}

function txHash(raw: xdr.Transaction): Buffer {
  return sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction:
        xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
    }).toXDR(),
  );
}

function envelope(raw: xdr.Transaction, sigs: xdr.DecoratedSignature[]): string {
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: raw, signatures: sigs }),
  ).toXDR('base64');
}

/** Sign with the given keypairs (duplicates allowed) and encode. */
function signed(raw: xdr.Transaction, kps: Keypair[]): string {
  const h = txHash(raw);
  return envelope(raw, kps.map((k) => k.signDecorated(h)));
}

function feeBumpEnvelope(
  feeSource: xdr.MuxedAccount,
  fee: bigint,
  innerEnvB64: string,
  kps: Keypair[],
): string {
  const innerV1 = xdr.TransactionEnvelope.fromXDR(innerEnvB64, 'base64').v1();
  const fbTx = new xdr.FeeBumpTransaction({
    feeSource,
    fee: new xdr.Int64(fee),
    innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(innerV1),
    ext: new xdr.FeeBumpTransactionExt(0),
  });
  const h = sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction:
        xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(fbTx),
    }).toXDR(),
  );
  return xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({ tx: fbTx, signatures: kps.map((k) => k.signDecorated(h)) }),
  ).toXDR('base64');
}

function ihfOp(fn: xdr.HostFunction, source?: xdr.MuxedAccount): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: source ?? null,
    body: xdr.OperationBody.invokeHostFunction(
      new xdr.InvokeHostFunctionOp({ hostFunction: fn, auth: [] }),
    ),
  });
}

function extendOp(source?: xdr.MuxedAccount): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: source ?? null,
    body: xdr.OperationBody.extendFootprintTtl(
      new xdr.ExtendFootprintTtlOp({ ext: new xdr.ExtensionPoint(0), extendTo: 100_000 }),
    ),
  });
}

function restoreOp(source?: xdr.MuxedAccount): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: source ?? null,
    body: xdr.OperationBody.restoreFootprint(
      new xdr.RestoreFootprintOp({ ext: new xdr.ExtensionPoint(0) }),
    ),
  });
}

// ---------------------------------------------------------------------------

describe('classic layer: exhaustive edge cases against stellar-core', () => {
  let L: Ledger;
  let deployer: Keypair;
  let addr: xdr.ScAddress;
  /** A footprint that covers put_persistent('k', ...) -- identical every call. */
  let RESOURCES: xdr.SorobanResources;
  /** startingSequenceNumber for the current ledger: ledgerSeq << 32. */
  let STARTING_SEQ: bigint;

  const hostFn = () => invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);

  const sorobanData = (resourceFee: bigint = RESOURCE_FEE, res = RESOURCES) =>
    new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(0),
      resources: res,
      resourceFee: new xdr.Int64(resourceFee),
    });

  /**
   * The default happy-path spec: one InvokeHostFunction, inclusion fee 100.
   * `seqNum` is resolved lazily so a spec may name an account that does not
   * exist, as long as the caller supplies the sequence number.
   */
  const spec = (source: Keypair, over: Partial<Spec> = {}): Spec => ({
    source: over.source ?? plain(source.publicKey()),
    seqNum: over.seqNum ?? seqOf(source) + 1n,
    fee: over.fee ?? RESOURCE_FEE + BigInt(BASE_FEE),
    ops: over.ops ?? [ihfOp(hostFn())],
    sorobanData: over.sorobanData === undefined ? sorobanData() : over.sorobanData,
    memo: over.memo,
    cond: over.cond,
  });

  const seqOf = (kp: Keypair) =>
    BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.seqNum().toString());
  const balOf = (kp: Keypair) =>
    BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.balance().toString());

  /** Write an AccountEntry with an arbitrary numSubEntries. */
  function fundWithSubEntries(
    pk: string,
    balance: bigint,
    numSubEntries: number,
    thresholds: [number, number, number, number] = [1, 0, 0, 0],
  ): void {
    const entry = new xdr.AccountEntry({
      accountId: accountIdFromPublicKey(pk),
      balance: new xdr.Int64(balance),
      seqNum: new xdr.SequenceNumber(new xdr.Int64(0n)),
      numSubEntries,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from(thresholds),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    });
    L.putEntry(
      new xdr.LedgerEntry({
        lastModifiedLedgerSeq: L.ledgerSeq,
        data: xdr.LedgerEntryData.account(entry),
        ext: new xdr.LedgerEntryExt(0),
      }).toXDR('base64'),
    );
  }

  beforeEach(() => {
    L = new Ledger();
    deployer = Keypair.random();
    L.fund(deployer.publicKey());

    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(
      createContractHostFn(accB64(deployer.publicKey()), wasmHash),
      accB64(deployer.publicKey()),
    );
    addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();

    const sim = L.simulate(hostFn(), accB64(deployer.publicKey()));
    expect(sim.ok).toBe(true);
    RESOURCES = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');

    STARTING_SEQ = BigInt(L.ledgerSeq) * 4_294_967_296n;
  });

  // =========================================================================
  // 1. SEQUENCE NUMBERS
  //    core: TransactionFrame::isBadSeq, TransactionFrame.cpp:1601-1625
  //          "return seqNum == INT64_MAX || seqNum + 1 != getSeqNum();"
  // =========================================================================
  describe('sequence numbers', () => {
    it('accepts exactly current + 1', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a]));
      expect(out.code).toBe('txSUCCESS');
      expect(seqOf(a)).toBe(1n);
    });

    it('rejects current + 2 with txBAD_SEQ', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: 2n })), [a]));
      expect(out.code).toBe('txBAD_SEQ');
      // A rejected transaction consumes nothing.
      expect(seqOf(a)).toBe(0n);
    });

    it('rejects a sequence number equal to the account seqNum', () => {
      const a = Keypair.random();
      L.fund(a.publicKey(), { seqNum: 41n });
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: 41n })), [a]));
      expect(out.code).toBe('txBAD_SEQ');
    });

    it('rejects seqNum 0 (never equals current + 1, since current >= 0)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: 0n })), [a]));
      expect(out.code).toBe('txBAD_SEQ');
    });

    it('accepts a huge sequence number one below the ledger start boundary', () => {
      // Sanity anchor for the boundary test below: startingSeq - 1 is a
      // perfectly ordinary sequence number.
      const a = Keypair.random();
      L.fund(a.publicKey(), { seqNum: STARTING_SEQ - 2n });
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: STARTING_SEQ - 1n })), [a]));
      expect(out.code).toBe('txSUCCESS');
    });

    // GAP CANDIDATE. TransactionFrame.cpp:1605-1608:
    //   if (getSeqNum() == getStartingSequenceNumber(header.current()))
    //       return true;   // isBadSeq
    // getStartingSequenceNumber(ledgerSeq) == ledgerSeq << 32
    // (TransactionUtils.cpp:1016-1023). A transaction may never use the
    // sequence number that CreateAccountOpFrame would hand a brand-new account
    // in this ledger -- even when it is exactly current + 1.
    it('rejects seqNum == ledgerSeq << 32 even when it is current + 1', () => {
      const a = Keypair.random();
      L.fund(a.publicKey(), { seqNum: STARTING_SEQ - 1n });
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: STARTING_SEQ })), [a]));
      expect(out.code).toBe('txBAD_SEQ');
    });

    it('rejects seqNum == ledgerSeq << 32 after the ledger advances too', () => {
      L.advanceLedgers(5);
      const start = BigInt(L.ledgerSeq) * 4_294_967_296n;
      const a = Keypair.random();
      L.fund(a.publicKey(), { seqNum: start - 1n });
      const out = L.sendTransaction(signed(rawTx(spec(a, { seqNum: start })), [a]));
      expect(out.code).toBe('txBAD_SEQ');
    });
  });

  // =========================================================================
  // 2. THRESHOLDS AND SIGNATURES
  //    core: SignatureChecker::checkSignature / checkAllSignaturesUsed
  //          TransactionFrame::checkSignature (:451-466)
  //          TransactionFrame::checkAllTransactionSignatures (:534-539)
  //          OperationFrame::getThresholdLevel (:203-207) -> MEDIUM
  // =========================================================================
  describe('thresholds and signature weights', () => {
    it('master weight 0 drops the master key from the signer set entirely', () => {
      // TransactionFrame.cpp:458 -- "if (acc.thresholds[0])": a zero master
      // weight is not a weight-0 signer, the key is simply not a signer.
      const a = Keypair.random();
      const co = Keypair.random();
      L.fund(a.publicKey(), {
        thresholds: [0, 3, 3, 3],
        signers: [{ key: co.publicKey(), weight: 3 }],
      });

      // Signed only by the co-signer: weight 3 >= 3 -> valid.
      const ok = L.sendTransaction(signed(rawTx(spec(a)), [co]));
      expect(ok.code).toBe('txSUCCESS');

      // Signed only by the (weight-0) master key: no weight at all.
      const bad = L.sendTransaction(signed(rawTx(spec(a, { seqNum: 2n })), [a]));
      expect(bad.code).toBe('txBAD_AUTH');
    });

    // GAP CANDIDATE. TxEnvelopeTests.cpp:688-695 "master key is extra" pins
    // txBAD_AUTH_EXTRA: with masterWeight 0 the master signature can never be
    // consumed, so checkAllSignaturesUsed fails (SignatureChecker.cpp:172-189,
    // TransactionFrame.cpp:1923).
    it('rejects a master-key signature on a master-weight-0 account with txBAD_AUTH_EXTRA', () => {
      const a = Keypair.random();
      const co = Keypair.random();
      L.fund(a.publicKey(), {
        thresholds: [0, 3, 3, 3],
        signers: [{ key: co.publicKey(), weight: 3 }],
      });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [co, a]));
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });

    it('rejects a threshold higher than the total available weight', () => {
      const a = Keypair.random();
      const co = Keypair.random();
      // master 1 + co 1 = 2 total, medium threshold 5: unsatisfiable.
      L.fund(a.publicKey(), {
        thresholds: [1, 5, 5, 5],
        signers: [{ key: co.publicKey(), weight: 1 }],
      });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, co]));
      expect(out.code).toBe('txBAD_AUTH');
    });

    it('counts a duplicated signature only once', () => {
      // SignatureChecker.cpp:86-112: verifyAll erases the matched signer from
      // the candidate list, so the second copy of the same signature finds no
      // signer to pay it. TxEnvelopeTests.cpp:707-717 pins txBAD_AUTH for
      // 10 copies of one signature.
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 2, 2, 2] });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, a, a, a, a]));
      expect(out.code).toBe('txBAD_AUTH');
    });

    // GAP CANDIDATE. When one signature already reaches the threshold, the
    // duplicates are left unused and checkAllSignaturesUsed rejects the
    // transaction: TransactionFrame.cpp:1923 -> txBAD_AUTH_EXTRA.
    it('rejects duplicate signatures with txBAD_AUTH_EXTRA when one already suffices', () => {
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 1, 1] });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, a]));
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });

    it('accumulates partial signatures among several signers', () => {
      const a = Keypair.random();
      const s1 = Keypair.random();
      const s2 = Keypair.random();
      const s3 = Keypair.random();
      L.fund(a.publicKey(), {
        thresholds: [0, 3, 3, 3],
        signers: [
          { key: s1.publicKey(), weight: 1 },
          { key: s2.publicKey(), weight: 1 },
          { key: s3.publicKey(), weight: 1 },
        ],
      });

      const two = L.sendTransaction(signed(rawTx(spec(a)), [s1, s2]));
      expect(two.code).toBe('txBAD_AUTH');

      const three = L.sendTransaction(signed(rawTx(spec(a)), [s1, s2, s3]));
      expect(three.code).toBe('txSUCCESS');
    });

    // GAP CANDIDATE, and it contradicts a headline claim in README.md.
    // SignatureChecker::checkSignature never evaluates "totalWeight >=
    // neededWeight" outside the per-signature loop (SignatureChecker.cpp:96-107
    // -- verifyAll returns false immediately when mSignatures is empty), so
    // with zero signatures it returns false whatever neededWeight is. At least
    // one signature from a listed signer is always required, even when the
    // threshold is 0. Ground truth: TxEnvelopeTests.cpp:390-401, SECTION
    // "no signature" -- signatures cleared on a root CreateAccount tx (a
    // MEDIUM-threshold op on an account whose medium threshold is 0) gives
    // txBAD_AUTH on every protocol version except the buggy V_7.
    it('rejects a completely unsigned transaction even when the threshold is 0', () => {
      const a = Keypair.random();
      L.fund(a.publicKey()); // default thresholds [1,0,0,0]
      const out = L.sendTransaction(envelope(rawTx(spec(a)), []));
      expect(out.code).toBe('txBAD_AUTH');
    });

    // GAP CANDIDATE. TransactionFrame.cpp:534-539 checks the TRANSACTION-level
    // signatures against thresholds[THRESHOLD_LOW]; the MEDIUM threshold is
    // only applied per operation (OperationFrame.cpp:203-207 + :217-230).
    // An account with low > med must therefore satisfy the LOW threshold.
    it('enforces the LOW threshold at transaction level, not only MEDIUM', () => {
      const a = Keypair.random();
      // master 1, low 5, medium 0.
      L.fund(a.publicKey(), { thresholds: [1, 5, 0, 0] });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a]));
      expect(out.code).toBe('txBAD_AUTH');
    });

    it('rejects a signature over the wrong network passphrase', () => {
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 1, 1] });
      const raw = rawTx(spec(a));
      const wrongHash = sha256(
        new xdr.TransactionSignaturePayload({
          networkId: sha256(Networks.PUBLIC),
          taggedTransaction:
            xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
        }).toXDR(),
      );
      const out = L.sendTransaction(envelope(raw, [a.signDecorated(wrongHash)]));
      expect(out.code).toBe('txBAD_AUTH');
    });
  });

  // =========================================================================
  // 3. SIGNATURE COUNT LIMIT
  //    XDR: "DecoratedSignature signatures<20>" (Stellar-transaction.x:901)
  //    core: SignatureChecker.h:25 takes xdr::xvector<DecoratedSignature, 20>
  // =========================================================================
  describe('signature count', () => {
    it('a 21st decorated signature cannot even be encoded (XDR bound is 20)', () => {
      // The maximum signature count is an XDR bound, not a core constant:
      // "DecoratedSignature signatures<20>" (Stellar-transaction.x:901), which
      // core reads as xdr::xvector<DecoratedSignature, 20> (SignatureChecker.h:25).
      // 21 never decodes on the wire, so it can never reach any validation.
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 1, 1] });
      const raw = rawTx(spec(a));
      const h = txHash(raw);
      const sigs = Array.from({ length: 21 }, () => a.signDecorated(h));

      expect(() => envelope(raw, sigs)).toThrow(/max allowed is 20/);
      // 20 is legal XDR and must reach the harness without throwing.
      let outcome: TxOutcome | null = null;
      expect(() => {
        outcome = L.sendTransaction(envelope(raw, sigs.slice(0, 20)));
      }).not.toThrow();
      expect(outcome!.code).toBeTruthy();
    });

    // GAP CANDIDATE. 20 signatures is legal XDR, but 19 of them are unusable
    // padding; checkAllSignaturesUsed (SignatureChecker.cpp:172-189) rejects
    // the transaction with txBAD_AUTH_EXTRA (TransactionFrame.cpp:1923).
    it('rejects signature padding from unrelated keys with txBAD_AUTH_EXTRA', () => {
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 1, 1] });
      const junk = Array.from({ length: 19 }, () => Keypair.random());
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, ...junk]));
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });
  });

  // =========================================================================
  // 4. TIMEBOUNDS
  //    core: isTooEarly  -> "tb->minTime && tb->minTime > closeTime"  (:1185)
  //          isTooLate   -> "tb->maxTime && tb->maxTime < closeTime"  (:1212)
  //    Both bounds are INCLUSIVE, and 0 disables the bound.
  // =========================================================================
  describe('timebounds boundaries', () => {
    const timed = (min: bigint, max: bigint) =>
      xdr.Preconditions.precondTime(
        new xdr.TimeBounds({
          minTime: xdr.TimePoint.fromString(min.toString()),
          maxTime: xdr.TimePoint.fromString(max.toString()),
        }),
      );

    it('accepts now == minTime (inclusive lower bound)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(5_000n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(5_000n, 0n) })), [a]));
      expect(out.code).toBe('txSUCCESS');
    });

    it('rejects now == minTime - 1 with txTOO_EARLY', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(4_999n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(5_000n, 0n) })), [a]));
      expect(out.code).toBe('txTOO_EARLY');
    });

    it('accepts now == maxTime (inclusive upper bound)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(9_000n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(0n, 9_000n) })), [a]));
      expect(out.code).toBe('txSUCCESS');
    });

    it('rejects now == maxTime + 1 with txTOO_LATE', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(9_001n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(0n, 9_000n) })), [a]));
      expect(out.code).toBe('txTOO_LATE');
    });

    it('treats minTime 0 as no lower bound, even at timestamp 0', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(0n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(0n, 0n) })), [a]));
      expect(out.code).toBe('txSUCCESS');
    });

    it('treats maxTime 0 as no upper bound, however far the clock runs', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(4_000_000_000n);
      const out = L.sendTransaction(signed(rawTx(spec(a, { cond: timed(1n, 0n) })), [a]));
      expect(out.code).toBe('txSUCCESS');
    });

    // GAP CANDIDATE. Ordering: core checks timebounds inside
    // commonValidPreSeqNum (TransactionFrame.cpp:1476-1487), which runs BEFORE
    // the sequence-number check (:1686). A transaction that is both expired and
    // out of sequence reports txTOO_LATE, not txBAD_SEQ.
    it('reports txTOO_LATE, not txBAD_SEQ, when a stale transaction is also expired', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(9_001n);
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { seqNum: 99n, cond: timed(0n, 9_000n) })), [a]),
      );
      expect(out.code).toBe('txTOO_LATE');
    });

    // GAP CANDIDATE. Same ordering rule for a source account that does not
    // exist: txNO_ACCOUNT is only reached at :1503, after the timebound checks.
    it('reports txTOO_LATE before txNO_ACCOUNT for a nonexistent source', () => {
      const ghost = Keypair.random();
      L.setTimestamp(9_001n);
      const out = L.sendTransaction(
        signed(rawTx(spec(ghost, { seqNum: 1n, cond: timed(0n, 9_000n) })), [ghost]),
      );
      expect(out.code).toBe('txTOO_LATE');
    });
  });

  // =========================================================================
  // 5. FEES
  //    core: getInclusionFee = fullFee - declaredSorobanResourceFee (:401-414)
  //          getMinInclusionFee = baseFee * max(1, numOps) (TransactionUtils.cpp:1994)
  //          baseFee == 100 on every Stellar network.
  // =========================================================================
  describe('fees', () => {
    it('accepts an inclusion fee of exactly BASE_FEE', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: RESOURCE_FEE + BigInt(BASE_FEE) })), [a]),
      );
      expect(out.code).toBe('txSUCCESS');
    });

    it('rejects an inclusion fee one stroop below BASE_FEE', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: RESOURCE_FEE + BigInt(BASE_FEE) - 1n })), [a]),
      );
      expect(out.code).toBe('txINSUFFICIENT_FEE');
    });

    // GAP CANDIDATE. TransactionFrame.cpp:1374-1385: a declared resourceFee
    // above the full transaction fee is txSOROBAN_INVALID, checked well before
    // the inclusion-fee comparison at :1489.
    it('reports txSOROBAN_INVALID when resourceFee exceeds the full fee', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: RESOURCE_FEE - 1n, sorobanData: sorobanData(RESOURCE_FEE) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('accepts a balance exactly equal to reserve + fee', () => {
      const a = Keypair.random();
      const fee = RESOURCE_FEE + BigInt(BASE_FEE);
      const reserve = 2n * BigInt(BASE_RESERVE);
      L.fund(a.publicKey(), { balance: reserve + fee });
      const out = L.sendTransaction(signed(rawTx(spec(a, { fee })), [a]));
      expect(out.code).toBe('txSUCCESS');
      expect(balOf(a)).toBe(reserve);
    });

    it('rejects a balance one stroop short of reserve + fee', () => {
      const a = Keypair.random();
      const fee = RESOURCE_FEE + BigInt(BASE_FEE);
      const reserve = 2n * BigInt(BASE_RESERVE);
      L.fund(a.publicKey(), { balance: reserve + fee - 1n });
      const out = L.sendTransaction(signed(rawTx(spec(a, { fee })), [a]));
      expect(out.code).toBe('txINSUFFICIENT_BALANCE');
      expect(balOf(a)).toBe(reserve + fee - 1n); // nothing charged
    });

    it('charges the fee even when the host call itself fails', () => {
      // core takes the fee in processFeeSeqNum before applying the operation.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const before = balOf(a);
      const fee = RESOURCE_FEE + BigInt(BASE_FEE);
      // Reading key 'k' before anything is written to it traps in the contract,
      // and 'k' is inside the cached footprint so the failure is the contract's,
      // not a footprint violation.
      const bad = invokeHostFn(addr, 'get_persistent', [sym('k')]);
      const out = L.sendTransaction(signed(rawTx(spec(a, { fee, ops: [ihfOp(bad)] })), [a]));
      expect(out.code).toBe('txFAILED');
      expect(balOf(a)).toBe(before - fee);
      expect(seqOf(a)).toBe(1n);
    });
  });

  // =========================================================================
  // 6. RESERVES
  //    core: getAvailableBalance = balance - minBalance - sellingLiabilities,
  //          minBalance = (2 + numSubEntries + numSponsoring - numSponsored)
  //                       * baseReserve.  baseReserve here is 5_000_000
  //          (crates/host-wasm/src/lib.rs:588).
  // =========================================================================
  describe('reserves', () => {
    it('counts numSubEntries in the minimum balance', () => {
      const a = Keypair.random();
      const fee = RESOURCE_FEE + BigInt(BASE_FEE);
      const reserve = (2n + 3n) * BigInt(BASE_RESERVE);

      fundWithSubEntries(a.publicKey(), reserve + fee - 1n, 3);
      const short = L.sendTransaction(signed(rawTx(spec(a, { fee })), [a]));
      expect(short.code).toBe('txINSUFFICIENT_BALANCE');

      fundWithSubEntries(a.publicKey(), reserve + fee, 3);
      const ok = L.sendTransaction(signed(rawTx(spec(a, { fee })), [a]));
      expect(ok.code).toBe('txSUCCESS');
      expect(balOf(a)).toBe(reserve);
    });

    it('a balance above the raw fee but below reserve + fee is still insufficient', () => {
      const a = Keypair.random();
      const fee = RESOURCE_FEE + BigInt(BASE_FEE);
      // Plenty to pay the fee outright, but it would break the 2-slot reserve.
      L.fund(a.publicKey(), { balance: BigInt(BASE_RESERVE) + fee });
      const out = L.sendTransaction(signed(rawTx(spec(a, { fee })), [a]));
      expect(out.code).toBe('txINSUFFICIENT_BALANCE');
    });
  });

  // =========================================================================
  // 7. FEE BUMPS
  //    core: FeeBumpTransactionFrame::commonValidPreSeqNum (:375-440)
  //          minInclusionFee for a fee bump uses getNumOperations() =
  //          inner ops + 1 (:646-649), so a 1-op inner tx needs 200 stroops.
  // =========================================================================
  describe('fee bumps', () => {
    /** An inner envelope with the given inclusion fee, signed by `a`. */
    const inner = (a: Keypair, inclusion: bigint, over: Partial<Spec> = {}) =>
      signed(rawTx(spec(a, { fee: RESOURCE_FEE + inclusion, ...over })), [a]);

    it('allows the fee source to be the inner source (self fee bump)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const before = balOf(a);
      const fb = feeBumpEnvelope(
        plain(a.publicKey()),
        RESOURCE_FEE + 200n,
        inner(a, 100n),
        [a],
      );
      const out = L.sendTransaction(fb);
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
      expect(seqOf(a)).toBe(1n);
      expect(balOf(a)).toBe(before - (RESOURCE_FEE + 200n));
    });

    it('cannot fee bump a fee bump: the XDR union admits only ENVELOPE_TYPE_TX', () => {
      // Stellar-transaction.x:949-956 -- FeeBumpTransaction::innerTx has a
      // single arm, ENVELOPE_TYPE_TX. A doubly-wrapped envelope is not
      // representable, and stellar-base refuses to build one.
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const fbB64 = feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, inner(a, 100n), [s]);
      const fbTx = TransactionBuilder.fromXDR(fbB64, NET);
      expect(() =>
        TransactionBuilder.buildFeeBumpTransaction(s, '1000', fbTx as any, NET),
      ).toThrow();
    });

    // GAP CANDIDATE. FeeBumpTransactionFrame.cpp:387-393 --
    // "if (inclusionFee < minInclusionFee) txINSUFFICIENT_FEE".
    // minInclusionFee = baseFee * (innerOps + 1) = 200 for a one-operation
    // inner transaction, so a fee bump that merely copies the inner fee is
    // rejected.
    it('rejects a fee bump whose inclusion fee is below baseFee * (innerOps + 1)', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const fb = feeBumpEnvelope(
        plain(s.publicKey()),
        RESOURCE_FEE + 199n,
        inner(a, 100n),
        [s],
      );
      const out = L.sendTransaction(fb);
      expect(out.code).toBe('txINSUFFICIENT_FEE');
    });

    it('accepts a fee bump at exactly baseFee * (innerOps + 1)', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const fb = feeBumpEnvelope(
        plain(s.publicKey()),
        RESOURCE_FEE + 200n,
        inner(a, 100n),
        [s],
      );
      const out = L.sendTransaction(fb);
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('P23: a fee-bumped inner tx may carry an inclusion fee below BASE_FEE', () => {
      // TransactionFrame.cpp:1367-1372 -- validateResourceFee = chargeFee, and
      // :1489 is guarded by chargeFee, which is false for a bumped inner tx.
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());

      // Standalone, the same envelope is rejected.
      const alone = L.sendTransaction(inner(a, 0n));
      expect(alone.code).toBe('txINSUFFICIENT_FEE');

      const fb = feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, inner(a, 0n), [s]);
      expect(L.sendTransaction(fb).code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('P23: a fee-bumped inner tx may declare a resourceFee above its own fee', () => {
      // TransactionFrame.cpp:1367-1372 sets validateResourceFee = chargeFee, so
      // with chargeFee false the :1374 "resourceFee > fullFee" check is skipped
      // too. That is what lets a fee bump cover a resource fee that does not fit
      // in the inner uint32 fee field. (Standalone, the same envelope is
      // txSOROBAN_INVALID -- pinned by the fees suite above.)
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const innerEnv = signed(rawTx(spec(a, { fee: 100n, sorobanData: sorobanData(RESOURCE_FEE) })), [a]);
      const fb = feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, innerEnv, [s]);
      expect(L.sendTransaction(fb).code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('rejects a fee bump the fee source cannot afford', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      const total = RESOURCE_FEE + 200n;
      L.fund(s.publicKey(), { balance: 2n * BigInt(BASE_RESERVE) + total - 1n });
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(s.publicKey()), total, inner(a, 100n), [s]),
      );
      expect(out.code).toBe('txINSUFFICIENT_BALANCE');
    });

    it('reports the inner failure code when the inner sequence number is stale', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const staleInner = signed(
        rawTx(spec(a, { seqNum: 99n, fee: RESOURCE_FEE + 100n })),
        [a],
      );
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, staleInner, [s]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_FAILED');
      expect(out.innerCode).toBe('txBAD_SEQ');
    });

    // GAP CANDIDATE. FeeBumpTransactionFrame.cpp:266-269 checks the fee bump
    // signatures against the fee source's thresholds[THRESHOLD_LOW]; there are
    // no operations on a fee bump, so MEDIUM never applies (:246-254).
    it('checks fee-bump signatures against the fee source LOW threshold', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      // low 0, medium 5: a single master signature satisfies LOW.
      L.fund(s.publicKey(), { thresholds: [1, 0, 5, 0] });
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, inner(a, 100n), [s]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('rejects a fee bump whose fee source does not exist', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(s.publicKey()), RESOURCE_FEE + 200n, inner(a, 100n), [s]),
      );
      expect(out.code).toBe('txNO_ACCOUNT');
    });
  });

  // =========================================================================
  // 8. ENVELOPE SHAPE
  //    core: TransactionFrame.cpp:1335 (numOperations == 0),
  //          validateSorobanOpsConsistency (:757-775)
  // =========================================================================
  describe('envelope shape', () => {
    it('rejects zero operations with txMISSING_OPERATION', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { ops: [] })), [a]));
      expect(out.code).toBe('txMISSING_OPERATION');
    });

    it('rejects two Soroban operations with txMALFORMED', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn()), ihfOp(hostFn())] })), [a]),
      );
      expect(out.code).toBe('txMALFORMED');
    });

    it('rejects a Soroban operation mixed with a classic one, in either order', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const pay = Operation.payment({
        destination: deployer.publicKey(),
        asset: Asset.native(),
        amount: '1',
      });

      const sorobanFirst = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn()), pay] })), [a]),
      );
      expect(sorobanFirst.code).toBe('txMALFORMED');

      const classicFirst = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [pay, ihfOp(hostFn())] })), [a]),
      );
      expect(classicFirst.code).toBe('txMALFORMED');
    });

    it('rejects a v0 envelope carrying a Soroban operation', () => {
      // TransactionFrame::XDRProvidesValidFee (:1795-1811): a Soroban tx must
      // be ENVELOPE_TYPE_TX with ext.v() == 1, otherwise txMALFORMED.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const v0 = new xdr.TransactionV0({
        sourceAccountEd25519: StrKey.decodeEd25519PublicKey(a.publicKey()),
        fee: Number(RESOURCE_FEE + 100n),
        seqNum: new xdr.SequenceNumber(new xdr.Int64(1n)),
        timeBounds: null,
        memo: xdr.Memo.memoNone(),
        operations: [ihfOp(hostFn())],
        ext: new xdr.TransactionV0Ext(0),
      });
      const env = xdr.TransactionEnvelope.envelopeTypeTxV0(
        new xdr.TransactionV0Envelope({ tx: v0, signatures: [] }),
      );
      const out = L.sendTransaction(env.toXDR('base64'));
      expect(out.code).toBe('txMALFORMED');
    });

    // The harness validates ExtendFootprintTTL / RestoreFootprint but never
    // dispatches them (README "What this does NOT do"). core would return
    // txSUCCESS and extend the TTL; the requirement here is only that the
    // harness says so honestly instead of pretending to succeed.
    it('reports ExtendFootprintTTL as a failure, never a silent success', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      // Write the entry first so there is a real TTL to observe.
      expect(L.sendTransaction(signed(rawTx(spec(a)), [a])).code).toBe('txSUCCESS');

      const dataKey = RESOURCES.footprint().readWrite()[0];
      const ttlBefore = L.getEntryTtl(dataKey.toXDR('base64'));
      expect(ttlBefore).toBeDefined();

      const res = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [dataKey], readWrite: [] }),
        instructions: 0,
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: 0,
      });
      const out = L.sendTransaction(
        signed(
          rawTx(spec(a, { seqNum: 2n, ops: [extendOp()], sorobanData: sorobanData(RESOURCE_FEE, res) })),
          [a],
        ),
      );

      expect(out.ok).toBe(false);
      expect(out.code).not.toBe('txSUCCESS');
      expect(out.detail ?? '').toMatch(/not dispatched/i);
      // And nothing actually happened to the TTL.
      expect(L.getEntryTtl(dataKey.toXDR('base64'))).toBe(ttlBefore);
    });

    it('reports RestoreFootprint as a failure, never a silent success', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const res = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: RESOURCES.footprint().readWrite() }),
        instructions: 0,
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: RESOURCES.writeBytes(),
      });
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [restoreOp()], sorobanData: sorobanData(RESOURCE_FEE, res) })), [a]),
      );
      expect(out.ok).toBe(false);
      expect(out.code).not.toBe('txSUCCESS');
      expect(out.detail ?? '').toMatch(/not dispatched/i);
    });

    // GAP CANDIDATE. OperationFrame::checkSignature (:217-256) and
    // OperationFrame::checkValid (:315-321): an operation-level source account
    // is checked in its own right. One that does not exist yields opNO_ACCOUNT
    // (or opBAD_AUTH at checkValid time without its signature), and the
    // transaction result is txFAILED (TransactionFrame.cpp:1918).
    it('rejects an operation source account that does not exist', () => {
      const a = Keypair.random();
      const ghost = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), plain(ghost.publicKey()))] })), [a]),
      );
      expect(out.code).toBe('txFAILED');
    });

    // GAP CANDIDATE. Same rule, signature side: the operation source must meet
    // its own MEDIUM threshold (OperationFrame.cpp:203-207, :225-232).
    it('requires the operation source to meet its own MEDIUM threshold', () => {
      const a = Keypair.random();
      const other = Keypair.random();
      L.fund(a.publicKey());
      L.fund(other.publicKey(), { thresholds: [1, 1, 5, 5] });
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), plain(other.publicKey()))] })), [a]),
      );
      expect(out.code).toBe('txFAILED');
    });
  });

  // =========================================================================
  // 9. MUXED ACCOUNTS
  //    core: validateSorobanMemo (TransactionFrame.cpp:363-391) --
  //    returns true early unless the single operation is INVOKE_HOST_FUNCTION.
  // =========================================================================
  describe('muxed accounts', () => {
    it('rejects a muxed envelope source on InvokeHostFunction', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { source: muxed(a.publicKey()) })), [a]));
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('rejects a muxed operation source on InvokeHostFunction', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), muxed(a.publicKey()))] })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('allows a muxed source on ExtendFootprintTTL (validateSorobanMemo returns early)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const res = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: RESOURCES.footprint().readWrite(), readWrite: [] }),
        instructions: 0,
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: 0,
      });
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              source: muxed(a.publicKey()),
              ops: [extendOp()],
              sorobanData: sorobanData(RESOURCE_FEE, res),
            }),
          ),
          [a],
        ),
      );
      // The op is not dispatched by this harness, but it must NOT be rejected
      // as a muxed-source violation.
      expect(out.code).not.toBe('txSOROBAN_INVALID');
    });

    it('allows a memo on RestoreFootprint (validateSorobanMemo returns early)', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const res = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: RESOURCES.footprint().readWrite() }),
        instructions: 0,
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: RESOURCES.writeBytes(),
      });
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              memo: xdr.Memo.memoText('hello'),
              ops: [restoreOp()],
              sorobanData: sorobanData(RESOURCE_FEE, res),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).not.toBe('txSOROBAN_INVALID');
    });

    it('allows a muxed fee-bump fee source', () => {
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const innerEnv = signed(rawTx(spec(a, { fee: RESOURCE_FEE + 100n })), [a]);
      const out = L.sendTransaction(
        feeBumpEnvelope(muxed(s.publicKey(), 42n), RESOURCE_FEE + 200n, innerEnv, [s]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
      expect(seqOf(a)).toBe(1n);
    });

    it('a muxed source is charged and sequenced on its underlying account', () => {
      // A muxed source is legal on a fee bump; the ledger state it touches is
      // the plain AccountID underneath (muxedToAccountId).
      const a = Keypair.random();
      const s = Keypair.random();
      L.fund(a.publicKey());
      L.fund(s.publicKey());
      const before = balOf(s);
      const innerEnv = signed(rawTx(spec(a, { fee: RESOURCE_FEE + 100n })), [a]);
      L.sendTransaction(feeBumpEnvelope(muxed(s.publicKey(), 9n), RESOURCE_FEE + 200n, innerEnv, [s]));
      expect(balOf(s)).toBe(before - (RESOURCE_FEE + 200n));
    });
  });
});
