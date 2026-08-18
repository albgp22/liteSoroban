/**
 * ROUND 3 — classic-layer defects that no earlier round looked at.
 *
 * Every expectation below was FIRST OBSERVED on the live protocol-27
 * `stellar-conformance` node (stellar-rpc 27.1.1 / captive-core 27.1.0,
 * passphrase "Standalone Network ; February 2017") by submitting the
 * byte-identical envelope and decoding the returned TransactionResult. The
 * observed payload is quoted next to each assertion, together with the
 * stellar-core master source that explains it. Nothing here was read back out
 * of this harness.
 *
 * Line references are to
 *   core-src/src/transactions/{TransactionFrame,FeeBumpTransactionFrame,
 *                              OperationFrame}.cpp
 *
 * The check that classic-edges.test.ts's header comment omits entirely, and
 * which turns out to run BEFORE every rule in that list, is
 * TransactionFrame::checkValidImpl (:1930-1966):
 *
 *     if (!validateXDRForProtocol(...))  return txError(txMALFORMED);
 *     if (!XDRProvidesValidFee())        return txError(txMALFORMED);
 *
 * with XDRProvidesValidFee (:1795-1811):
 *
 *     if (isSoroban()) {
 *         if (mEnvelope.type() != ENVELOPE_TYPE_TX ||
 *             mEnvelope.v1().tx.ext.v() != 1)          return false;
 *         int64_t resourceFee = declaredSorobanResourceFee();
 *         if (resourceFee < 0 || resourceFee > MAX_RESOURCE_FEE) return false;
 *     }
 *     return true;
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { LiteStellar } from '../../src/litestellar.js';
import { accountIdFromPublicKey, loadAccount, BASE_FEE } from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);

const NET = Networks.TESTNET;
const NETWORK_ID = sha256(NET);
const RESOURCE_FEE = 500_000n;

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');
const plain = (pk: string) =>
  xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));

interface Spec {
  source: xdr.MuxedAccount;
  seqNum: bigint;
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

function signed(raw: xdr.Transaction, kps: Keypair[]): string {
  const h = txHash(raw);
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: raw, signatures: kps.map((k) => k.signDecorated(h)) }),
  ).toXDR('base64');
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
    new xdr.FeeBumpTransactionEnvelope({
      tx: fbTx,
      signatures: kps.map((k) => k.signDecorated(h)),
    }),
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

function v2cond(over: Partial<{
  timeBounds: xdr.TimeBounds | null;
  ledgerBounds: xdr.LedgerBounds | null;
  minSeqNum: xdr.SequenceNumber | null;
  minSeqAge: bigint;
  minSeqLedgerGap: number;
  extraSigners: xdr.SignerKey[];
}> = {}): xdr.Preconditions {
  return xdr.Preconditions.precondV2(
    new xdr.PreconditionsV2({
      timeBounds: over.timeBounds ?? null,
      ledgerBounds: over.ledgerBounds ?? null,
      minSeqNum: over.minSeqNum ?? null,
      minSeqAge: new xdr.Duration(new xdr.Uint64(over.minSeqAge ?? 0n)),
      minSeqLedgerGap: over.minSeqLedgerGap ?? 0,
      extraSigners: over.extraSigners ?? [],
    }),
  );
}

describe('round-3 classic-layer residue, pinned against a live protocol-27 node', () => {
  let L: Ledger;
  let deployer: Keypair;
  let addr: xdr.ScAddress;
  let RESOURCES: xdr.SorobanResources;

  const hostFn = () => invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);

  const sorobanData = (resourceFee: bigint = RESOURCE_FEE, res = RESOURCES) =>
    new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(0),
      resources: res,
      resourceFee: new xdr.Int64(resourceFee),
    });

  const seqOf = (kp: Keypair) =>
    BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.seqNum().toString());
  const balOf = (kp: Keypair) =>
    BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.balance().toString());

  const spec = (source: Keypair, over: Partial<Spec> = {}): Spec => ({
    source: over.source ?? plain(source.publicKey()),
    seqNum: over.seqNum ?? seqOf(source) + 1n,
    fee: over.fee ?? RESOURCE_FEE + BigInt(BASE_FEE),
    ops: over.ops ?? [ihfOp(hostFn())],
    sorobanData: over.sorobanData === undefined ? sorobanData() : over.sorobanData,
    memo: over.memo,
    cond: over.cond,
  });

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
  });

  // =========================================================================
  // 1. THE DECLARED RESOURCE FEE IS NEVER COMPARED WITH THE ACTUAL ONE
  //
  //    core: commonValidPreSeqNum (:1391-1400)
  //        if (sorobanData.resourceFee < refundable + non_refundable)
  //            -> txSOROBAN_INVALID,
  //              "transaction `sorobanData.resourceFee` is lower than the
  //               actual Soroban resource fee"
  //
  //    classic.ts:432-436 reads `sorobanData.resourceFee()` only to subtract
  //    it from the total fee. Nothing ever computes what the transaction's
  //    resources actually cost, so ANY declared value is accepted.
  // =========================================================================
  describe('sorobanData.resourceFee is never checked against the real cost', () => {
    it('rejects a resource fee below the actual cost of the invocation', () => {
      // LIVE (put_persistent, minResourceFee 83 183 as reported by simulate):
      //   fee=1100, resourceFee=1000
      //   -> ERROR txSorobanInvalid, feeCharged 1100, diagnostic
      //      "transaction `sorobanData.resourceFee` is lower than the actual
      //       Soroban resource fee" {1000, 23785}
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: 1_100n, sorobanData: sorobanData(1_000n) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('rejects a declared resource fee of zero', () => {
      // LIVE: fee=100, resourceFee=0 -> ERROR txSorobanInvalid, feeCharged 100.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: BigInt(BASE_FEE), sorobanData: sorobanData(0n) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('does not let a zero resource fee buy a real state write', () => {
      // The consequence, not just the code: the harness applies the write and
      // charges 100 stroops for work the network prices at ~24 000.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const before = balOf(a);
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: BigInt(BASE_FEE), sorobanData: sorobanData(0n) })), [a]),
      );
      expect(out.ok).toBe(false);
      expect(before - balOf(a)).toBe(0n);
    });
  });

  // =========================================================================
  // 2. A NEGATIVE DECLARED RESOURCE FEE IS NOT REJECTED — IT IS A FEE DISCOUNT
  //
  //    core: XDRProvidesValidFee (:1804-1808) -> txMALFORMED, feeCharged 0.
  //    classic.ts:435 computes `inclusionFee = totalFee - resourceFee`, so a
  //    negative resourceFee makes the inclusion fee LARGER than the fee bid
  //    and the `inclusionFee < BASE_FEE` gate passes for free.
  // =========================================================================
  describe('negative sorobanData.resourceFee', () => {
    it('rejects resourceFee = -1 with txMALFORMED and no fee charged', () => {
      // LIVE: fee=100, resourceFee=-1
      //   -> ERROR, errorResultXdr AAAAAAAAAAD////wAAAAAA== =
      //      feeCharged 0, txMalformed.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: BigInt(BASE_FEE), sorobanData: sorobanData(-1n) })), [a]),
      );
      expect(out.code).toBe('txMALFORMED');
      expect(out.feeCharged).toBe(0n);
    });

    it('does not accept an arbitrarily negative resource fee as a valid transaction', () => {
      // resourceFee = -10^12 makes classic.ts's inclusionFee 10^12 + 100.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(spec(a, { fee: BigInt(BASE_FEE), sorobanData: sorobanData(-1_000_000_000_000n) })),
          [a],
        ),
      );
      expect(out.ok).toBe(false);
      expect(out.code).toBe('txMALFORMED');
    });
  });

  // =========================================================================
  // 3. A SOROBAN ENVELOPE WITHOUT SorobanTransactionData IS txMALFORMED,
  //    AND THAT CHECK RUNS BEFORE EVERYTHING ELSE
  //
  //    core: checkValidImpl (:1949) -> XDRProvidesValidFee -> `tx.ext.v() != 1`
  //    -> txMALFORMED, feeCharged 0, before commonValid is even entered.
  //    classic.ts:430-431 answers txSOROBAN_INVALID, and only AFTER the memo,
  //    source-account, sequence, timebounds and signature checks have run.
  // =========================================================================
  describe('missing SorobanTransactionData', () => {
    it('is txMALFORMED with feeCharged 0, not txSOROBAN_INVALID', () => {
      // LIVE: InvokeHostFunction with tx.ext.v()==0
      //   -> ERROR AAAAAAAAAAD////wAAAAAA== = feeCharged 0, txMalformed.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { sorobanData: null })), [a]));
      expect(out.code).toBe('txMALFORMED');
      expect(out.feeCharged).toBe(0n);
    });

    it('outranks a stale sequence number', () => {
      // LIVE: same envelope with seqNum == the account's current seqNum
      //   -> still txMalformed, feeCharged 0 (NOT txBadSeq).
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { sorobanData: null, seqNum: seqOf(a) })), [a]),
      );
      expect(out.code).toBe('txMALFORMED');
    });

    it('is reported on the OUTER envelope of a fee bump, not as an inner failure', () => {
      // LIVE: fee bump over an inner with tx.ext.v()==0
      //   -> ERROR AAAAAAAAAAD////wAAAAAA== = feeCharged 0, txMalformed.
      // core: FeeBumpTransactionFrame::checkValidImpl (:281-285) calls
      //       XDRProvidesValidFee, which delegates to the inner tx (:576-583),
      //       and returns a bare txMALFORMED for the whole envelope.
      const a = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(f.publicKey());
      const inner = signed(rawTx(spec(a, { sorobanData: null, fee: BigInt(BASE_FEE) })), [a]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), 500n, inner, [f]),
      );
      expect(out.code).toBe('txMALFORMED');
      expect(out.feeCharged).toBe(0n);
    });
  });

  // =========================================================================
  // 4. AN OPERATION SOURCE THAT DOES NOT EXIST IS AN OPERATION-LEVEL FAILURE
  //
  //    core: OperationFrame::checkSignature (:216-259).
  //      - forApply == true  -> res->code(opNO_ACCOUNT), i.e. the transaction
  //        IS included, txFAILED, the fee IS charged and the sequence number
  //        IS consumed;
  //      - forApply == false with an explicit op.sourceAccount ->
  //        checkSignatureNoAccount, so a signature by the ghost key passes
  //        validation and the transaction reaches the ledger.
  //    classic.ts:398-400 short-circuits with txNO_ACCOUNT, which core reserves
  //    for a missing TRANSACTION source.
  // =========================================================================
  describe('nonexistent operation source', () => {
    it('is txFAILED, not txNO_ACCOUNT, when the ghost key signs', () => {
      // LIVE: tx source A (funded), op source G (never funded), signed by A+G
      //   -> INCLUDED in ledger 17341, status FAILED, txFailed / opNoAccount,
      //      feeCharged 25 770.
      const a = Keypair.random();
      const ghost = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), plain(ghost.publicKey()))] })), [a, ghost]),
      );
      expect(out.code).toBe('txFAILED');
    });

    it('consumes the sequence number and charges the fee for it', () => {
      // The observable consequence of being a txFAILED rather than a rejection.
      const a = Keypair.random();
      const ghost = Keypair.random();
      L.fund(a.publicKey());
      const seqBefore = seqOf(a);
      const balBefore = balOf(a);
      L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), plain(ghost.publicKey()))] })), [a, ghost]),
      );
      expect(seqOf(a)).toBe(seqBefore + 1n);
      expect(balOf(a)).toBeLessThan(balBefore);
    });

    // NOTE: the UNSIGNED variant of this (op source missing, ghost key absent
    // from the signature set -> txFAILED / opBAD_AUTH) is already pinned by
    // classic-edges.test.ts:989. What is new here is that the SIGNED variant
    // is not a rejection at all: core admits it to a ledger and bills for it.
  });

  // =========================================================================
  // 5. PreconditionsV2.extraSigners: AN EMPTY SIGNED-PAYLOAD IS txMALFORMED
  //
  //    core: commonValidPreSeqNum (:1313-1322)
  //        if (signer.type() == SIGNER_KEY_TYPE_ED25519_SIGNED_PAYLOAD &&
  //            signer.ed25519SignedPayload().payload.empty())
  //            -> txMALFORMED
  //    Round 2 pinned the duplicate-extraSigners half of this block; the
  //    empty-payload half is unpinned and equally unimplemented.
  // =========================================================================
  describe('extraSigners XDR validation', () => {
    it('rejects an ed25519SignedPayload extra signer with an empty payload', () => {
      // LIVE: PRECOND_V2{extraSigners:[signedPayload(pk, "")]}
      //   -> ERROR AAAAAAAHoYT////wAAAAAA== = feeCharged 500 100, txMalformed.
      const a = Keypair.random();
      const e = Keypair.random();
      L.fund(a.publicKey());
      const k = xdr.SignerKey.signerKeyTypeEd25519SignedPayload(
        new xdr.SignerKeyEd25519SignedPayload({
          ed25519: e.rawPublicKey(),
          payload: Buffer.alloc(0),
        }),
      );
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ extraSigners: [k] }) })), [a]),
      );
      expect(out.code).toBe('txMALFORMED');
    });
  });

  // =========================================================================
  // 6. withoutClassicChecks() IS DOCUMENTED AS "EVERYTHING OFF"
  //    litestellar.ts:301-304 -- "Everything off: the fastest, least realistic
  //    configuration" -- but it composes only sigverify/sequenceCheck/
  //    timebounds and leaves fee charging on. A test that opted out of the
  //    classic layer entirely still trips over txINSUFFICIENT_BALANCE.
  //    This is a defect against the harness's own contract, not against core.
  // =========================================================================
  describe('withoutClassicChecks()', () => {
    it('really turns every classic check off', () => {
      const svm = new LiteStellar().withoutClassicChecks();
      const d = Keypair.random();
      svm.ledger.fund(d.publicKey());
      const wasmHash = svm.ledger.seedWasm(CODE);
      const dep = svm.ledger.simulateAndSend(
        createContractHostFn(accB64(d.publicKey()), wasmHash),
        accB64(d.publicKey()),
      );
      const addr2 = xdr.ScVal.fromXDR(dep.sent.returnValueXdr!, 'base64').address();
      const hostFn = () => invokeHostFn(addr2, 'put_persistent', [sym('k'), u64(1n)]);
      const a = Keypair.random();
      // Exactly the base reserve: available balance is 0.
      svm.ledger.fund(a.publicKey(), { balance: 10_000_000n });
      const L2 = svm.ledger;
      const seq =
        BigInt(loadAccount(L2, accountIdFromPublicKey(a.publicKey()))!.seqNum().toString()) + 1n;
      const sim = L2.simulate(hostFn(), accB64(a.publicKey()));
      const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
      const env = signed(
        rawTx({
          source: plain(a.publicKey()),
          seqNum: seq,
          fee: RESOURCE_FEE + BigInt(BASE_FEE),
          ops: [ihfOp(hostFn())],
          sorobanData: new xdr.SorobanTransactionData({
            ext: new xdr.SorobanTransactionDataExt(0),
            resources: res,
            resourceFee: new xdr.Int64(RESOURCE_FEE),
          }),
        }),
        [a],
      );
      const out = svm.sendTransaction(env);
      expect(out.code).not.toBe('txINSUFFICIENT_BALANCE');
    });
  });

  // =========================================================================
  // 7. CONTROLS — behaviour that DOES match the live node.
  // =========================================================================
  describe('CONTROL: the other three switches DO reach the fee-bump path', () => {
    // classic.ts:308 (sigverify), :407 (timebounds) and :390 (sequenceCheck)
    // all consult `validation`; only the balance check at :316 and the debit at
    // :327 do not. So `feeCharging` is the ONLY switch a fee bump ignores.
    /** Deploy the same contract into a fresh ledger and return its host fn. */
    const deployInto = (L2: Ledger): (() => xdr.HostFunction) => {
      const d = Keypair.random();
      L2.fund(d.publicKey());
      const wasmHash = L2.seedWasm(CODE);
      const { sent } = L2.simulateAndSend(
        createContractHostFn(accB64(d.publicKey()), wasmHash),
        accB64(d.publicKey()),
      );
      const a2 = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
      return () => invokeHostFn(a2, 'put_persistent', [sym('k'), u64(1n)]);
    };

    const build = (
      svm: LiteStellar,
      a: Keypair,
      hostFn: () => xdr.HostFunction,
      over: Partial<Spec> = {},
    ) => {
      const L2 = svm.ledger;
      const sim = L2.simulate(hostFn(), accB64(a.publicKey()));
      const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
      const seq =
        BigInt(loadAccount(L2, accountIdFromPublicKey(a.publicKey()))!.seqNum().toString()) + 1n;
      return {
        source: plain(a.publicKey()),
        seqNum: over.seqNum ?? seq,
        fee: RESOURCE_FEE,
        ops: [ihfOp(hostFn())],
        sorobanData: new xdr.SorobanTransactionData({
          ext: new xdr.SorobanTransactionDataExt(0),
          resources: res,
          resourceFee: new xdr.Int64(RESOURCE_FEE),
        }),
        cond: over.cond,
      } as Spec;
    };

    it('withSigverify(false) lets an unsigned fee bump through', () => {
      const svm = new LiteStellar().withSigverify(false);
      const hf = deployInto(svm.ledger);
      const a = Keypair.random();
      const f = Keypair.random();
      svm.ledger.fund(a.publicKey());
      svm.ledger.fund(f.publicKey());
      const inner = signed(rawTx(build(svm, a, hf)), []);
      const out = svm.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, inner, []),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('withSequenceCheck(false) lets a stale inner sequence through a fee bump', () => {
      const svm = new LiteStellar().withSequenceCheck(false);
      const hf = deployInto(svm.ledger);
      const a = Keypair.random();
      const f = Keypair.random();
      svm.ledger.fund(a.publicKey());
      svm.ledger.fund(f.publicKey());
      const inner = signed(rawTx(build(svm, a, hf, { seqNum: 999n })), [a]);
      const out = svm.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, inner, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });

    it('withTimebounds(false) lets an expired inner through a fee bump', () => {
      const svm = new LiteStellar().withTimebounds(false);
      const hf = deployInto(svm.ledger);
      const a = Keypair.random();
      const f = Keypair.random();
      svm.ledger.fund(a.publicKey());
      svm.ledger.fund(f.publicKey());
      svm.ledger.setTimestamp(10_000);
      const expired = xdr.Preconditions.precondTime(
        new xdr.TimeBounds({ minTime: new xdr.Uint64(0n), maxTime: new xdr.Uint64(1_000n) }),
      );
      const inner = signed(rawTx(build(svm, a, hf, { cond: expired })), [a]);
      const out = svm.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, inner, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });
  });

  describe('CONTROL: memo / muxed rules per Soroban operation type', () => {
    // LIVE, all five verified on the conformance node:
    //   ExtendFootprintTTL + memoText + muxed tx source + muxed op source -> txSuccess
    //   RestoreFootprint   + memoId   + muxed tx source                   -> txSuccess
    //   InvokeHostFunction + memoText                                     -> txSorobanInvalid
    //   InvokeHostFunction + muxed OP source only                         -> txSorobanInvalid
    //   fee bump with a MUXED fee source                                  -> txFeeBumpInnerSuccess
    // core: validateSorobanMemo (:363-389) returns true for any op type that
    // is not INVOKE_HOST_FUNCTION. classic.ts:378 gates on exactly that, so
    // this whole matrix is already correct -- it is NOT a gap.
    const extendOp = (source?: xdr.MuxedAccount) =>
      new xdr.Operation({
        sourceAccount: source ?? null,
        body: xdr.OperationBody.extendFootprintTtl(
          new xdr.ExtendFootprintTtlOp({ ext: new xdr.ExtensionPoint(0), extendTo: 100_000 }),
        ),
      });
    const muxed = (pk: string) =>
      xdr.MuxedAccount.keyTypeMuxedEd25519(
        new xdr.MuxedAccountMed25519({
          id: new xdr.Uint64(7n),
          ed25519: StrKey.decodeEd25519PublicKey(pk),
        }),
      );
    const empty = () =>
      new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
      });

    it('does not raise txSOROBAN_INVALID for memo + muxed on ExtendFootprintTTL', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              source: muxed(a.publicKey()),
              ops: [extendOp(muxed(a.publicKey()))],
              memo: xdr.Memo.memoText('hi'),
              sorobanData: sorobanData(RESOURCE_FEE, empty()),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).not.toBe('txSOROBAN_INVALID');
    });

    it('does raise txSOROBAN_INVALID for a memo on InvokeHostFunction', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { memo: xdr.Memo.memoText('hi') })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('does raise txSOROBAN_INVALID for a muxed OPERATION source on InvokeHostFunction', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), muxed(a.publicKey()))] })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('accepts a muxed fee-bump fee source', () => {
      const a = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(f.publicKey());
      const inner = signed(rawTx(spec(a, { fee: RESOURCE_FEE })), [a]);
      const out = L.sendTransaction(
        feeBumpEnvelope(muxed(f.publicKey()), RESOURCE_FEE + 200n, inner, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });
  });

  describe('CONTROL: op source != tx source under a fee bump', () => {
    it('sequences the transaction source and leaves the operation source alone', () => {
      // LIVE: tx source A, op source B, both sign, fee bumped by F
      //   -> txFeeBumpInnerSuccess / txSuccess; A.seqNum +1, B.seqNum unchanged.
      const a = Keypair.random();
      const b = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(b.publicKey());
      L.fund(f.publicKey());
      const seqA = seqOf(a);
      const seqB = seqOf(b);
      const inner = signed(
        rawTx(spec(a, { fee: RESOURCE_FEE, ops: [ihfOp(hostFn(), plain(b.publicKey()))] })),
        [a, b],
      );
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, inner, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
      expect(seqOf(a)).toBe(seqA + 1n);
      expect(seqOf(b)).toBe(seqB);
    });
  });
});
