/**
 * Round-2 classic-layer gaps.
 *
 * EVERY expectation in this file was first observed on a LIVE stellar-core
 * v27.1.0 node (protocol 27, "Standalone Network ; February 2017", the
 * `stellar-conformance` container) by submitting the byte-identical envelope
 * and decoding the returned TransactionResult. The core source that explains
 * each observation is cited alongside. Nothing here was read back out of this
 * harness.
 *
 * Line references are to
 *   core-src/src/transactions/{TransactionFrame,FeeBumpTransactionFrame,
 *                              OperationFrame,SignatureChecker,
 *                              ExtendFootprintTTLOpFrame}.cpp
 *
 * NOTE ON `resourceFee > fee`: master's commonValidPreSeqNum reports
 * txSOROBAN_INVALID for it (:1370). The deployed v27.1.0 answers txMALFORMED
 * with feeCharged 0 — i.e. an XDR-level fee check that fires before the result
 * object is even built. Both disagree with this harness (txINSUFFICIENT_FEE);
 * the assertion below pins the live protocol-27 answer.
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
import {
  accountIdFromPublicKey,
  loadAccount,
  BASE_FEE,
  type TxOutcome,
} from '../../src/classic.js';

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

// ---------------------------------------------------------------------------
// envelope construction at the XDR level
// ---------------------------------------------------------------------------

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

/** PreconditionsV2 with everything defaulted to "no constraint". */
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

const bounds = (min: bigint, max: bigint) =>
  new xdr.TimeBounds({ minTime: new xdr.Uint64(min), maxTime: new xdr.Uint64(max) });

// ---------------------------------------------------------------------------

describe('round-2 layer gaps, each pinned against a live stellar-core v27.1.0', () => {
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
  // A. PRECONDITIONS OTHER THAN PRECOND_TIME
  //
  //    classic.ts:407 gates every precondition check on
  //        cond.switch().name === 'precondTime'
  //    so a PRECOND_V2 envelope skips ALL of them. core reads the same fields
  //    out of PRECOND_V2: TransactionFrame::getTimeBounds (:654-684) returns
  //    cond.v2().timeBounds, getLedgerBounds (:688), getMinSeqNum (:727),
  //    getMinSeqAge (:703), getMinSeqLedgerGap (:715), extraSignersExist(:742).
  // =========================================================================
  describe('PRECOND_V2 preconditions are not evaluated at all', () => {
    it('honours timeBounds carried in PRECOND_V2, not only PRECOND_TIME', () => {
      // LIVE: PRECOND_V2{maxTime:1000} -> txTooLate.
      // core: isTooLate (:1202) reads getTimeBounds(), which handles PRECOND_V2.
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(10_000);
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ timeBounds: bounds(0n, 1_000n) }) })), [a]),
      );
      expect(out.code).toBe('txTOO_LATE');
    });

    it('honours minTime carried in PRECOND_V2', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(10_000);
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ timeBounds: bounds(50_000n, 0n) }) })), [a]),
      );
      expect(out.code).toBe('txTOO_EARLY');
    });

    it('rejects a maxLedger already reached with txTOO_LATE', () => {
      // LIVE: PRECOND_V2{ledgerBounds:{0,5}} at ledger 8115 -> txTooLate.
      // core: isTooLate (:1219) `lb->maxLedger != 0 && lb->maxLedger <= ledgerSeq`.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              cond: v2cond({
                ledgerBounds: new xdr.LedgerBounds({ minLedger: 0, maxLedger: L.ledgerSeq }),
              }),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txTOO_LATE');
    });

    it('rejects a minLedger not yet reached with txTOO_EARLY', () => {
      // LIVE: PRECOND_V2{ledgerBounds:{4e9,0}} -> txTooEarly.
      // core: isTooEarly (:1195) `lb->minLedger > ledgerSeq`.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              cond: v2cond({
                ledgerBounds: new xdr.LedgerBounds({ minLedger: L.ledgerSeq + 1, maxLedger: 0 }),
              }),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txTOO_EARLY');
    });

    it('accepts a sequence-number jump when minSeqNum permits it', () => {
      // LIVE: minSeqNum=cur, seqNum=cur+1000 -> ACCEPTED, and the account's
      // seqNum lands on cur+1000.
      // core: isBadSeq (:1602) `if (minSeqNum) return seqNum < *minSeqNum ||
      //       seqNum >= getSeqNum();`
      const a = Keypair.random();
      L.fund(a.publicKey());
      const cur = seqOf(a);
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              seqNum: cur + 1000n,
              cond: v2cond({ minSeqNum: new xdr.SequenceNumber(new xdr.Int64(cur)) }),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txSUCCESS');
      expect(seqOf(a)).toBe(cur + 1000n);
    });

    it('rejects a minSeqLedgerGap the account cannot satisfy', () => {
      // LIVE: minSeqLedgerGap=100000 at ledger 8115 -> txBadMinSeqAgeOrGap.
      // core: isTooEarlyForAccount (:1258) `minSeqLedgerGap > ledgerSeq`.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ minSeqLedgerGap: L.ledgerSeq + 1 }) })), [a]),
      );
      expect(out.code).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    });

    it('rejects a minSeqAge the account cannot satisfy', () => {
      // core: isTooEarlyForAccount (:1246) `minSeqAge > lowerBoundCloseTime`.
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(1_000);
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ minSeqAge: 2_000n }) })), [a]),
      );
      expect(out.code).toBe('txBAD_MIN_SEQ_AGE_OR_GAP');
    });

    it('requires a signature for every extraSigner', () => {
      // LIVE: extraSigners=[random], not signed -> txBadAuth.
      // core: checkExtraSigners (:480-503) assigns weight 1 to each extra
      //       signer and demands neededWeight == signers.size().
      const a = Keypair.random();
      const extra = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              cond: v2cond({
                extraSigners: [xdr.SignerKey.signerKeyTypeEd25519(extra.rawPublicKey())],
              }),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txBAD_AUTH');
    });

    it('rejects two identical extraSigners with txMALFORMED', () => {
      // LIVE: extraSigners=[k,k] -> txMalformed.
      // core: commonValidPreSeqNum (:1302-1308).
      const a = Keypair.random();
      const extra = Keypair.random();
      const k = xdr.SignerKey.signerKeyTypeEd25519(extra.rawPublicKey());
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { cond: v2cond({ extraSigners: [k, k] }) })), [a, extra]),
      );
      expect(out.code).toBe('txMALFORMED');
    });
  });

  // =========================================================================
  // B. checkSorobanResources — the footprint is never validated
  //    core: commonValidPreSeqNum (:1400-1435) rejects duplicate footprint
  //    keys, and checkSorobanResources (:778) rejects over-limit resources.
  // =========================================================================
  describe('Soroban footprint / resource validation', () => {
    it('rejects the same ledger key listed twice in readOnly', () => {
      // LIVE: duplicate readOnly key -> txSorobanInvalid.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const ro = RESOURCES.footprint().readOnly();
      const dup = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({
          readOnly: [...ro, ro[0]],
          readWrite: RESOURCES.footprint().readWrite(),
        }),
        instructions: RESOURCES.instructions(),
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: RESOURCES.writeBytes(),
      });
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { sorobanData: sorobanData(RESOURCE_FEE, dup) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('rejects a key present in both readOnly and readWrite', () => {
      // LIVE: same key in RO and RW -> txSorobanInvalid.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const rw = RESOURCES.footprint().readWrite();
      expect(rw.length).toBeGreaterThan(0);
      const overlap = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({
          readOnly: [...RESOURCES.footprint().readOnly(), rw[0]],
          readWrite: rw,
        }),
        instructions: RESOURCES.instructions(),
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: RESOURCES.writeBytes(),
      });
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { sorobanData: sorobanData(RESOURCE_FEE, overlap) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });

    it('rejects declared instructions above the network maximum', () => {
      // LIVE: instructions = 1e9 -> txSorobanInvalid.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const huge = new xdr.SorobanResources({
        footprint: RESOURCES.footprint(),
        instructions: 1_000_000_000,
        diskReadBytes: RESOURCES.diskReadBytes(),
        writeBytes: RESOURCES.writeBytes(),
      });
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { sorobanData: sorobanData(RESOURCE_FEE, huge) })), [a]),
      );
      expect(out.code).toBe('txSOROBAN_INVALID');
    });
  });

  // =========================================================================
  // C. TRANSACTION-SOURCE **LOW** THRESHOLD, INDEPENDENT OF THE OPERATION
  //    core: checkAllTransactionSignatures (:526-550) checks the TX SOURCE at
  //    THRESHOLD_LOW; OperationFrame::checkSignature (:217) then checks the OP
  //    SOURCE at its own level. classic.ts:417-426 performs only the second.
  // =========================================================================
  describe('the transaction source must sign even when the operation source did', () => {
    it('rejects an envelope signed only by the operation source', () => {
      // LIVE: tx source A, op source B, only B signs -> txBadAuth.
      const a = Keypair.random();
      const b = Keypair.random();
      L.fund(a.publicKey());
      L.fund(b.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { ops: [ihfOp(hostFn(), plain(b.publicKey()))] })), [b]),
      );
      expect(out.code).toBe('txBAD_AUTH');
    });

    it('rejects it under a fee bump too, as txFEE_BUMP_INNER_FAILED/txBAD_AUTH', () => {
      // LIVE: fee bump over that inner -> txFeeBumpInnerFailed / inner txBadAuth.
      const a = Keypair.random();
      const b = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(b.publicKey());
      L.fund(f.publicKey());
      const inner = signed(
        rawTx(spec(a, { fee: RESOURCE_FEE, ops: [ihfOp(hostFn(), plain(b.publicKey()))] })),
        [b],
      );
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, inner, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_FAILED');
      expect(out.innerCode).toBe('txBAD_AUTH');
    });
  });

  // =========================================================================
  // D. FEE BUMPS: min inclusion fee, and the "is this really a bump" check
  //    core: FeeBumpTransactionFrame::commonValidPreSeqNum (:373-440).
  //    getNumOperations() for a fee bump is inner + 1 (:646), so
  //    getMinInclusionFee is baseFee * 2 for a 1-op Soroban inner tx.
  // =========================================================================
  describe('fee bumps', () => {
    const fund3 = () => {
      const inner = Keypair.random();
      const bumper = Keypair.random();
      L.fund(inner.publicKey());
      L.fund(bumper.publicKey());
      return { inner, bumper };
    };

    it('rejects an inclusion fee below baseFee * (innerOps + 1)', () => {
      // LIVE: outer inclusion fee 199 -> txInsufficientFee (feeCharged 500200).
      const { inner, bumper } = fund3();
      const innerEnv = signed(rawTx(spec(inner, { fee: RESOURCE_FEE })), [inner]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(bumper.publicKey()), RESOURCE_FEE + 199n, innerEnv, [bumper]),
      );
      expect(out.code).toBe('txINSUFFICIENT_FEE');
    });

    it('rejects a "bump" that does not raise the per-operation inclusion fee', () => {
      // LIVE: inner inclusion 500, outer inclusion 999 -> txInsufficientFee,
      //       feeCharged 1000 (the fee that WOULD have been needed).
      // core: v1 = outerIncl * minIncl(inner) = 999 * 100 = 99_900
      //       v2 = innerIncl * minIncl(fb)    = 500 * 200 = 100_000
      //       v1 < v2 -> setInsufficientFeeErrorWithFeeCharged(ceil(v2/100)).
      const { inner, bumper } = fund3();
      const innerEnv = signed(rawTx(spec(inner, { fee: RESOURCE_FEE + 500n })), [inner]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(bumper.publicKey()), RESOURCE_FEE + 999n, innerEnv, [bumper]),
      );
      expect(out.code).toBe('txINSUFFICIENT_FEE');
      expect(out.feeCharged).toBe(1000n);
    });

    it('accepts the exact break-even bump (outer inclusion == 2x inner)', () => {
      // LIVE: inner inclusion 500, outer inclusion 1000 -> accepted.
      const { inner, bumper } = fund3();
      const innerEnv = signed(rawTx(spec(inner, { fee: RESOURCE_FEE + 500n })), [inner]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(bumper.publicKey()), RESOURCE_FEE + 1000n, innerEnv, [bumper]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_SUCCESS');
    });
  });

  // =========================================================================
  // E. UNCONSUMED SIGNATURES -> txBAD_AUTH_EXTRA
  //    core: SignatureChecker::checkAllSignaturesUsed, called from
  //    processSignatures (:1591) on the apply path and from
  //    checkValidWithOptionallyChargedFee (:1922); for fee bumps from
  //    FeeBumpTransactionFrame::checkValidImpl (:323).
  // =========================================================================
  describe('every decorated signature has to be consumed', () => {
    it('rejects a signature from a key that is not a signer', () => {
      // LIVE: source + one random key -> txBadAuthExtra.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, Keypair.random()]));
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });

    it('rejects the same signature supplied twice', () => {
      // LIVE: source signs twice -> txBadAuthExtra.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a, a]));
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });

    it('rejects an extra signature on the FEE BUMP envelope', () => {
      // LIVE: fee bump signed by feeSource + junk -> txBadAuthExtra
      //       (NOT txFeeBumpInnerFailed: the fee bump's own check).
      const a = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(f.publicKey());
      const innerEnv = signed(rawTx(spec(a, { fee: RESOURCE_FEE })), [a]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, innerEnv, [
          f,
          Keypair.random(),
        ]),
      );
      expect(out.code).toBe('txBAD_AUTH_EXTRA');
    });

    it('rejects an extra signature on the INNER envelope of a fee bump', () => {
      // LIVE: -> txFeeBumpInnerFailed / inner txBadAuthExtra.
      const a = Keypair.random();
      const f = Keypair.random();
      L.fund(a.publicKey());
      L.fund(f.publicKey());
      const innerEnv = signed(rawTx(spec(a, { fee: RESOURCE_FEE })), [a, Keypair.random()]);
      const out = L.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, innerEnv, [f]),
      );
      expect(out.code).toBe('txFEE_BUMP_INNER_FAILED');
      expect(out.innerCode).toBe('txBAD_AUTH_EXTRA');
    });
  });

  // =========================================================================
  // F. ExtendFootprintTTL / RestoreFootprint ARE ORDINARY SUCCEEDING OPS
  //    LIVE: both, with an empty footprint, return txSuccess.
  //    core: ExtendFootprintTTLOpFrame::doCheckValidForSoroban (:322) only
  //    demands an empty readWrite footprint and TTL-bearing readOnly keys.
  //    classic.ts:454-463 returns txFAILED for both — and has already bumped
  //    the sequence number and debited the fee by then.
  // =========================================================================
  describe('ExtendFootprintTTL / RestoreFootprint', () => {
    const emptyFootprint = () =>
      new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
      });

    it('ExtendFootprintTTL with an empty footprint succeeds', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              ops: [extendOp()],
              sorobanData: sorobanData(RESOURCE_FEE, emptyFootprint()),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txSUCCESS');
    });

    it('RestoreFootprint with an empty footprint succeeds', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              ops: [restoreOp()],
              sorobanData: sorobanData(RESOURCE_FEE, emptyFootprint()),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).toBe('txSUCCESS');
    });

    it('ExtendFootprintTTL is authorised at LOW, not MEDIUM', () => {
      // LIVE, on an account with masterWeight 1 / LOW 1 / MED 5:
      //   ExtendFootprintTTL  -> txSuccess
      //   InvokeHostFunction  -> txFailed / opBadAuth
      // core: ExtendFootprintTTLOpFrame::getThresholdLevel (:392) -> LOW,
      //       RestoreFootprintOpFrame::getThresholdLevel (:481) -> LOW,
      //       OperationFrame::getThresholdLevel (:205)         -> MEDIUM.
      // classic.ts:418 always uses thresholds[2] (MEDIUM).
      // Asserted as "not txBAD_AUTH" so this pins ONLY the threshold level and
      // not the separate ExtendFootprintTTL-dispatch gap above.
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 5, 5] });
      const out = L.sendTransaction(
        signed(
          rawTx(
            spec(a, {
              ops: [extendOp()],
              sorobanData: sorobanData(RESOURCE_FEE, emptyFootprint()),
            }),
          ),
          [a],
        ),
      );
      expect(out.code).not.toBe('txBAD_AUTH');
    });

    it('CONTROL: InvokeHostFunction on the same account IS medium-gated', () => {
      // LIVE: txFailed / opBadAuth. The harness reports txBAD_AUTH instead of
      // txFAILED (a separate, already-known gap), but it does reject — so the
      // MEDIUM level itself is right for InvokeHostFunction.
      const a = Keypair.random();
      L.fund(a.publicKey(), { thresholds: [1, 1, 5, 5] });
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a]));
      expect(out.ok).toBe(false);
    });
  });

  // =========================================================================
  // G. THE SOURCE AccountEntry IS NOT NORMALISED WHEN THE SEQNUM IS PROCESSED
  //    LIVE: a friendbot account's LedgerEntryData is 84 bytes with ext.v=0;
  //    after ONE transaction it is 136 bytes with ext.v=1 -> v1.ext.v=2 ->
  //    v2.ext.v=3, seqLedger/seqTime set to the closing ledger.
  //    core: processSeqNum (:1527) -> maybeUpdateAccountOnLedgerSeqUpdate
  //    (TransactionUtils.cpp:1980) -> prepareAccountEntryExtensionV3 (:81).
  // =========================================================================
  describe('AccountEntry extension normalisation on sequence bump', () => {
    it('promotes the source account to ext v3 and records seqLedger/seqTime', () => {
      const a = Keypair.random();
      L.fund(a.publicKey());
      const before = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
      expect(before.ext().switch()).toBe(0);

      L.setTimestamp(1_234_567);
      const out = L.sendTransaction(signed(rawTx(spec(a)), [a]));
      expect(out.code).toBe('txSUCCESS');

      const after = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
      expect(after.ext().switch()).toBe(1);
      expect(after.ext().v1().ext().switch()).toBe(2);
      expect(after.ext().v1().ext().v2().ext().switch()).toBe(3);
      const v3 = after.ext().v1().ext().v2().ext().v3();
      expect(v3.seqLedger()).toBe(L.ledgerSeq);
      expect(BigInt(v3.seqTime().toString())).toBe(1_234_567n);
    });

    it('adds exactly the 52 bytes the live network adds', () => {
      // LIVE: LedgerEntryData 84 -> 136 bytes for a signer-less account.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const before = xdr.LedgerEntryData.account(
        loadAccount(L, accountIdFromPublicKey(a.publicKey()))!,
      ).toXDR().length;
      L.sendTransaction(signed(rawTx(spec(a)), [a]));
      const after = xdr.LedgerEntryData.account(
        loadAccount(L, accountIdFromPublicKey(a.publicKey()))!,
      ).toXDR().length;
      expect(before).toBe(84);
      expect(after).toBe(136);
    });
  });

  // =========================================================================
  // H. VALIDATION ORDER, AND resourceFee > fee
  // =========================================================================
  describe('validation order', () => {
    it('reports txMALFORMED with feeCharged 0 when resourceFee exceeds the fee', () => {
      // LIVE (v27.1.0, submitted straight to core's /tx endpoint):
      //   AAAAAAAAAAD////wAAAAAA==  -> feeCharged 0, result code -16 (txMALFORMED).
      // master reports txSOROBAN_INVALID for the same envelope
      // (commonValidPreSeqNum :1370) — either way, not txINSUFFICIENT_FEE.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(signed(rawTx(spec(a, { fee: RESOURCE_FEE - 1n })), [a]));
      expect(out.code).toBe('txMALFORMED');
      expect(out.feeCharged).toBe(0n);
    });

    it('reports txMALFORMED for resourceFee > fee even when the tx is also expired', () => {
      // LIVE: fee=499999 + maxTime in the past -> txMalformed, feeCharged 0.
      const a = Keypair.random();
      L.fund(a.publicKey());
      L.setTimestamp(10_000);
      const out = L.sendTransaction(
        signed(
          rawTx(spec(a, { fee: RESOURCE_FEE - 1n, cond: xdr.Preconditions.precondTime(bounds(0n, 1_000n)) })),
          [a],
        ),
      );
      expect(out.code).toBe('txMALFORMED');
    });

    it('reports txINSUFFICIENT_FEE, not txBAD_SEQ, for a cheap AND stale transaction', () => {
      // core: the inclusion-fee check (:1489) is in commonValidPreSeqNum,
      //       isBadSeq (:1686) runs after it in commonValid.
      const a = Keypair.random();
      L.fund(a.publicKey());
      const out = L.sendTransaction(
        signed(rawTx(spec(a, { fee: RESOURCE_FEE + 99n, seqNum: seqOf(a) })), [a]),
      );
      expect(out.code).toBe('txINSUFFICIENT_FEE');
    });

    it('reports txINSUFFICIENT_FEE, not txNO_ACCOUNT, for a cheap tx from a ghost', () => {
      // core: the source account is only loaded at :1502, after the fee check.
      const ghost = Keypair.random();
      const out = L.sendTransaction(
        signed(rawTx(spec(ghost, { fee: RESOURCE_FEE + 99n, seqNum: 1n })), [ghost]),
      );
      expect(out.code).toBe('txINSUFFICIENT_FEE');
    });
  });

  // =========================================================================
  // I-bis. THE INCLUSION FEE IS A BID, NOT A PRICE
  //    core: TransactionFrame::getFee (:417) when applying returns
  //      declaredSorobanResourceFee + min(getInclusionFee(), baseFee * nOps)
  //    so the charged inclusion fee is CAPPED at baseFee * numOperations
  //    before any refund. classic.ts:452 debits the whole `raw.fee()`.
  //    LIVE: the identical transaction bid at inclusion 100, 10 000 and
  //    1 000 000 was charged 16 706 stroops every time.
  // =========================================================================
  describe('overbidding the inclusion fee', () => {
    it('charges the same regardless of how far the inclusion fee is overbid', () => {
      const a = Keypair.random();
      const b = Keypair.random();
      L.fund(a.publicKey());
      L.fund(b.publicKey());
      const cheap = L.sendTransaction(
        signed(rawTx(spec(a, { fee: RESOURCE_FEE + 100n })), [a]),
      );
      const rich = L.sendTransaction(
        signed(rawTx(spec(b, { fee: RESOURCE_FEE + 1_000_000n })), [b]),
      );
      expect(cheap.code).toBe('txSUCCESS');
      expect(rich.code).toBe('txSUCCESS');
      expect(rich.feeCharged).toBe(cheap.feeCharged);
    });
  });

  // =========================================================================
  // I. THE VALIDATION SWITCHES DO NOT REACH THE FEE-BUMP PATH
  //    classic.ts:316 and :327 run the balance check and the debit
  //    unconditionally; only classic.ts:308 consults `validation`.
  //    This is a defect against the harness's OWN documented contract
  //    (litestellar.ts:294 "Debit fees from the source account. Default true"),
  //    not against stellar-core.
  // =========================================================================
  describe('withFeeCharging(false) and fee bumps', () => {
    it('does not debit the fee source when fee charging is off', () => {
      const svm = new LiteStellar().withFeeCharging(false);
      const a = Keypair.random();
      const f = Keypair.random();
      svm.ledger.fund(a.publicKey());
      svm.ledger.fund(f.publicKey());

      const L2 = svm.ledger;
      const bal = () =>
        BigInt(loadAccount(L2, accountIdFromPublicKey(f.publicKey()))!.balance().toString());
      const before = bal();

      const innerSpec: Spec = {
        source: plain(a.publicKey()),
        seqNum: BigInt(loadAccount(L2, accountIdFromPublicKey(a.publicKey()))!.seqNum().toString()) + 1n,
        fee: RESOURCE_FEE,
        ops: [ihfOp(hostFn())],
        sorobanData: sorobanData(),
      };
      const innerEnv = signed(rawTx(innerSpec), [a]);
      svm.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, innerEnv, [f]),
      );
      expect(bal()).toBe(before);
    });

    it('does not reject a fee bump for insufficient balance when fee charging is off', () => {
      const svm = new LiteStellar().withFeeCharging(false);
      const a = Keypair.random();
      const f = Keypair.random();
      svm.ledger.fund(a.publicKey());
      // Exactly the base reserve: available balance is 0.
      svm.ledger.fund(f.publicKey(), { balance: 10_000_000n });

      const L2 = svm.ledger;
      const innerSpec: Spec = {
        source: plain(a.publicKey()),
        seqNum: BigInt(loadAccount(L2, accountIdFromPublicKey(a.publicKey()))!.seqNum().toString()) + 1n,
        fee: RESOURCE_FEE,
        ops: [ihfOp(hostFn())],
        sorobanData: sorobanData(),
      };
      const innerEnv = signed(rawTx(innerSpec), [a]);
      const out = svm.sendTransaction(
        feeBumpEnvelope(plain(f.publicKey()), RESOURCE_FEE + 200n, innerEnv, [f]),
      );
      expect(out.code).not.toBe('txINSUFFICIENT_BALANCE');
    });
  });
});
