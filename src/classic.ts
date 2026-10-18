/**
 * The classic layer: everything stellar-core validates that the Soroban host
 * does not. Written in TypeScript on purpose — it is the layer most likely to
 * need per-project adjustment, and here it iterates without rebuilding wasm.
 *
 * Scope, deliberately: transaction envelopes, sequence numbers, preconditions
 * (time and ledger bounds, PRECOND_V2), signature weights against thresholds,
 * inclusion/resource fees, and fee bumps.
 * NOT classic operations (Payment, CreateAccount, ChangeTrust) — a Soroban
 * transaction may not contain them anyway (validateSorobanOpsConsistency).
 *
 * Rules verified against stellar-core src/transactions/TransactionFrame.cpp,
 * not from memory. Line references are to that file.
 */
import {
  xdr,
  Keypair,
  StrKey,
  Networks,
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  hash as sha256,
} from '@stellar/stellar-sdk';
import type { Ledger } from './index.js';
import type { NetworkFeeSettings } from './fee-settings.js';

/** Default: testnet's, so an app configured for testnet needs no change. */
export const DEFAULT_PASSPHRASE = Networks.TESTNET;

/** Base inclusion fee per operation, in stroops. */
export const BASE_FEE = 100;
/** Matches the base_reserve in the host's LedgerInfo. */
export const BASE_RESERVE = 5_000_000;

export type TxResultCode =
  | 'txSUCCESS'
  | 'txFAILED'
  | 'txNO_ACCOUNT'
  | 'txBAD_SEQ'
  | 'txBAD_AUTH'
  | 'txBAD_AUTH_EXTRA'
  | 'txTOO_EARLY'
  | 'txTOO_LATE'
  | 'txBAD_MIN_SEQ_AGE_OR_GAP'
  | 'txMISSING_OPERATION'
  | 'txMALFORMED'
  | 'txSOROBAN_INVALID'
  | 'txINSUFFICIENT_FEE'
  | 'txINSUFFICIENT_BALANCE'
  | 'txFEE_BUMP_INNER_SUCCESS'
  | 'txFEE_BUMP_INNER_FAILED';

export interface TxOutcome {
  code: TxResultCode;
  /** Present when the host actually ran. */
  ok: boolean;
  returnValueXdr?: string;
  eventsXdr?: string[];
  changedKeys?: string[];
  removedKeys?: string[];
  /**
   * TransactionResult.feeCharged, as core reports it. For an applied
   * transaction it is what was debited, net of the refund: the non-refundable
   * resource fee, the rent and events fee the operation consumed (nothing if
   * it failed), and the inclusion fee capped at baseFee per operation. For a
   * `rejected` one NOTHING was debited: core seeds the result with
   * getFee(header, baseFee, applying = false) = declared resource fee +
   * baseFee * max(1, ops), or 0 when it rejected the XDR before seeding
   * (createTxError), or the fee it would need for a fee bump that does not
   * raise the rate.
   */
  feeCharged: bigint;
  /**
   * For an applied transaction while fees are charged, the Soroban part of
   * feeCharged as core records it in SorobanTransactionMeta ext v1
   * (totalNonRefundableResourceFeeCharged, totalRefundableResourceFeeCharged,
   * rentFeeCharged). `refundable` includes `rent`.
   */
  sorobanFee?: { nonRefundable: bigint; refundable: bigint; rent: bigint };
  /** Why an InvokeHostFunction operation failed, as its result arm. */
  invokeResult?:
    | 'invokeHostFunctionTrapped'
    | 'invokeHostFunctionResourceLimitExceeded'
    | 'invokeHostFunctionInsufficientRefundableFee';
  /** Populated for fee bumps. */
  innerCode?: TxResultCode;
  error?: string;
  /** Diagnostic text, mirroring core's diagnostic events. */
  detail?: string;
  /**
   * An applied InvokeHostFunction's diagnostic events, as core records them in
   * the meta: the host's, then core's own (a budget failure's, for one).
   */
  diagnosticEventsXdr?: string[];
  /**
   * Rejected by validation before touching the ledger: no fee, no sequence
   * number. stellar-rpc reports these as ERROR at submit, whatever the code —
   * including a txFAILED whose operation failed its signature check.
   */
  rejected?: boolean;
  /** For txFAILED decided by the classic layer rather than by the host. */
  opCode?: 'opBAD_AUTH' | 'opNO_ACCOUNT';
  /** The inner result of an ExtendFootprintTTL / RestoreFootprint operation. */
  footprintOpResult?:
    | 'extendFootprintTtlSuccess'
    | 'extendFootprintTtlMalformed'
    | 'extendFootprintTtlResourceLimitExceeded'
    | 'extendFootprintTtlInsufficientRefundableFee'
    | 'restoreFootprintSuccess'
    | 'restoreFootprintMalformed'
    | 'restoreFootprintResourceLimitExceeded'
    | 'restoreFootprintInsufficientRefundableFee';
}

// ---------------------------------------------------------------------------
// account helpers — the classic state lives in ordinary AccountEntry XDR
// ---------------------------------------------------------------------------

export function accountKey(accountId: xdr.AccountId): xdr.LedgerKey {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
}

export function accountIdFromPublicKey(pk: string): xdr.AccountId {
  return xdr.AccountId.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
}

/** Strip a MuxedAccount down to its underlying AccountId. */
export function muxedToAccountId(m: xdr.MuxedAccount): xdr.AccountId {
  return m.type === 'keyTypeMuxedEd25519'
    ? xdr.AccountId.publicKeyTypeEd25519(m.med25519.ed25519)
    : xdr.AccountId.publicKeyTypeEd25519(m.ed25519);
}

export function isMuxed(m: xdr.MuxedAccount): boolean {
  return m.type === 'keyTypeMuxedEd25519';
}

export function loadAccount(ledger: Ledger, id: xdr.AccountId): xdr.AccountEntry | null {
  const raw = ledger.getEntry(accountKey(id).toXdr('base64'));
  if (!raw) return null;
  return xdr.expectUnionVariant(xdr.LedgerEntry.fromXdr(raw, 'base64').data, 'account').account;
}

export function storeAccount(ledger: Ledger, account: xdr.AccountEntry): void {
  ledger.putEntry(
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: ledger.ledgerSeq,
      data: xdr.LedgerEntryData.account(account),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXdr('base64'),
  );
}

/** The four threshold bytes: [master weight, low, medium, high]. */
const thresholdsOf = (account: xdr.AccountEntry): Uint8Array => account.thresholds.toBytes();

/** Byte equality across Buffer and Uint8Array. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

export interface FundOptions {
  balance?: bigint;
  seqNum?: bigint;
  /** [master, low, medium, high] */
  thresholds?: [number, number, number, number];
  signers?: { key: string; weight: number }[];
}

/** Requirement 5, now with real keys so transactions can actually be signed. */
export function fundAccount(ledger: Ledger, publicKey: string, opts: FundOptions = {}): void {
  const thresholds = opts.thresholds ?? [1, 0, 0, 0];
  const account = new xdr.AccountEntry({
    accountId: accountIdFromPublicKey(publicKey),
    balance: opts.balance ?? 100_000_000_000n,
    seqNum: opts.seqNum ?? 0n,
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.from(thresholds),
    signers: (opts.signers ?? []).map(
      (s) =>
        new xdr.Signer({
          key: xdr.SignerKey.signerKeyTypeEd25519(StrKey.decodeEd25519PublicKey(s.key)),
          weight: s.weight,
        }),
    ),
    ext: xdr.AccountEntryExt.v0(),
  });
  storeAccount(ledger, account);
}

/** Available balance net of the base reserve requirement. */
export function availableBalance(account: xdr.AccountEntry): bigint {
  const reserve = BigInt(2 + account.numSubEntries) * BigInt(BASE_RESERVE);
  return account.balance - reserve;
}

// ---------------------------------------------------------------------------
// signature checking
// ---------------------------------------------------------------------------

const SOROBAN_OP_TYPES = new Set([
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
]);

/**
 * Sum the weights of signers whose signature over `txHash` verifies.
 * Mirrors core: master key weight is thresholds[0], plus any additional signers.
 */
export function signatureWeight(
  account: xdr.AccountEntry,
  signatures: xdr.DecoratedSignature[],
  txHash: Uint8Array,
): number {
  const candidates: { pk: string; weight: number }[] = [
    {
      pk: StrKey.encodeEd25519PublicKey(account.accountId.ed25519.toBytes()),
      weight: thresholdsOf(account)[0],
    },
  ];
  for (const s of account.signers) {
    if (s.key.type !== 'signerKeyTypeEd25519') continue;
    candidates.push({
      pk: StrKey.encodeEd25519PublicKey(s.key.ed25519.toBytes()),
      weight: s.weight,
    });
  }

  let total = 0;
  const used = new Set<string>();
  for (const sig of signatures) {
    for (const c of candidates) {
      if (used.has(c.pk)) continue;
      const kp = Keypair.fromPublicKey(c.pk);
      // Hint is a cheap prefilter; the signature check is what decides.
      if (!sameBytes(kp.signatureHint(), sig.hint.toBytes())) continue;
      if (kp.verify(txHash, sig.signature.toBytes())) {
        used.add(c.pk);
        total += c.weight;
        break;
      }
    }
  }
  return total;
}

/** A signer as stellar-core's SignatureChecker sees it. */
export interface WeightedSigner {
  key: xdr.SignerKey;
  weight: number;
}

/**
 * TransactionFrame::checkSignature's signer list: the master key ONLY when its
 * weight (thresholds[0]) is non-zero, then every account signer, of any type.
 * A weight-0 master key is not a signer at all, so a signature from it is never
 * consumed and the envelope fails with txBAD_AUTH_EXTRA.
 */
export function accountSigners(account: xdr.AccountEntry): WeightedSigner[] {
  const signers: WeightedSigner[] = [];
  const master = thresholdsOf(account)[0];
  if (master) {
    signers.push({
      key: xdr.SignerKey.signerKeyTypeEd25519(account.accountId.ed25519),
      weight: master,
    });
  }
  for (const s of account.signers) signers.push({ key: s.key, weight: s.weight });
  return signers;
}

/** SignatureUtils getHint: the last 4 bytes, or all of them zero-padded if fewer. */
function hintOf(bytes: Uint8Array): Buffer {
  const b = Buffer.from(bytes);
  const hint = Buffer.alloc(4);
  if (b.length < 4) b.copy(hint, 0);
  else b.copy(hint, 0, b.length - 4);
  return hint;
}

/** SignatureUtils doesHintMatch: needs at least 4 bytes, compares the last 4. */
function hintMatches(bytes: Uint8Array, hint: Uint8Array): boolean {
  return bytes.length >= 4 && sameBytes(bytes.subarray(bytes.length - 4), hint);
}

function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  try {
    return Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(publicKey)).verify(message, signature);
  } catch {
    return false; // malformed signature length, as libsodium's check rejects it
  }
}

/**
 * Port of stellar-core's SignatureChecker (src/transactions/SignatureChecker.cpp
 * and SignatureUtils.cpp, v29.0.0). One instance per envelope, shared by every
 * check on it, because it remembers which signatures were consumed.
 *
 * - Signer types are tried in core's order: PRE_AUTH_TX (matched against the
 *   contents hash, no signature needed), HASH_X, ED25519, ED25519_SIGNED_PAYLOAD.
 * - Each signature is matched against at most one remaining signer, after a
 *   hint prefilter; weights are capped at 255.
 * - A check returns the moment the needed weight is reached, so signatures past
 *   that point are NOT consumed by it. That is why a valid but superfluous
 *   signature still ends in txBAD_AUTH_EXTRA.
 * - Weight only accumulates on a match, so an unsigned envelope fails even a
 *   threshold of 0 (core's TxEnvelopeTests SECTION("no signature")); only a
 *   PRE_AUTH_TX signer can satisfy a check with no signature at all.
 */
export class SignatureChecker {
  private readonly used: boolean[];

  constructor(
    private readonly signatures: xdr.DecoratedSignature[],
    private readonly contentsHash: Uint8Array,
  ) {
    this.used = signatures.map(() => false);
  }

  checkSignature(signers: WeightedSigner[], neededWeight: number): boolean {
    const ofType = (name: xdr.SignerKey['type']) => signers.filter((s) => s.key.type === name);
    const cap = (w: number) => Math.min(w, 255);
    let total = 0;

    for (const s of ofType('signerKeyTypePreAuthTx')) {
      if (sameBytes(xdr.expectUnionVariant(s.key, 'signerKeyTypePreAuthTx').preAuthTx.toBytes(), this.contentsHash)) {
        total += cap(s.weight);
        if (total >= neededWeight) return true;
      }
    }

    const verifyAll = (
      candidates: WeightedSigner[],
      verify: (sig: xdr.DecoratedSignature, signer: WeightedSigner) => boolean,
    ): boolean => {
      for (let i = 0; i < this.signatures.length; i++) {
        const at = candidates.findIndex((s) => verify(this.signatures[i], s));
        if (at === -1) continue;
        this.used[i] = true;
        total += cap(candidates[at].weight);
        if (total >= neededWeight) return true;
        candidates.splice(at, 1);
      }
      return false;
    };

    if (
      verifyAll(ofType('signerKeyTypeHashX'), (sig, s) => {
        const hashX = xdr.expectUnionVariant(s.key, 'signerKeyTypeHashX').hashX.toBytes();
        return hintMatches(hashX, sig.hint.toBytes()) && sameBytes(sha256(sig.signature.toBytes()), hashX);
      })
    ) {
      return true;
    }
    if (
      verifyAll(ofType('signerKeyTypeEd25519'), (sig, s) => {
        const ed25519 = xdr.expectUnionVariant(s.key, 'signerKeyTypeEd25519').ed25519.toBytes();
        return (
          hintMatches(ed25519, sig.hint.toBytes()) &&
          verifyEd25519(ed25519, sig.signature.toBytes(), this.contentsHash)
        );
      })
    ) {
      return true;
    }
    return verifyAll(ofType('signerKeyTypeEd25519SignedPayload'), (sig, s) => {
      const sp = xdr.expectUnionVariant(s.key, 'signerKeyTypeEd25519SignedPayload').ed25519SignedPayload;
      const ed25519 = sp.ed25519.toBytes();
      const hint = Buffer.from(hintOf(ed25519).map((b, i) => b ^ hintOf(sp.payload)[i]));
      return sameBytes(hint, sig.hint.toBytes()) && verifyEd25519(ed25519, sig.signature.toBytes(), sp.payload);
    });
  }

  /** SignatureChecker::checkAllSignaturesUsed: false means txBAD_AUTH_EXTRA. */
  checkAllSignaturesUsed(): boolean {
    return this.used.every(Boolean);
  }
}

/**
 * Whether `signatures` over `txHash` give `account` at least `neededWeight`, as
 * TransactionFrame::checkSignature decides it. A one-off check: it does not
 * track consumption across checks the way a whole envelope needs.
 */
export function checkSignature(
  account: xdr.AccountEntry,
  signatures: xdr.DecoratedSignature[],
  txHash: Uint8Array,
  neededWeight: number,
): boolean {
  return new SignatureChecker(signatures, txHash).checkSignature(accountSigners(account), neededWeight);
}

/** PRECOND_V2 extraSigners: every one must sign (TransactionFrame::checkExtraSigners). */
function checkExtraSigners(checker: SignatureChecker, raw: xdr.Transaction): boolean {
  const cond = raw.cond;
  if (cond.type !== 'precondV2') return true;
  const extra = cond.v2.extraSigners;
  if (extra.length === 0) return true;
  return checker.checkSignature(
    extra.map((key) => ({ key, weight: 1 })),
    extra.length,
  );
}

// ---------------------------------------------------------------------------
// the rest of PRECOND_V2 (CAP-21), as TransactionFrame evaluates it
// ---------------------------------------------------------------------------

function preconditionsV2(raw: xdr.Transaction): xdr.PreconditionsV2 | null {
  const cond = raw.cond;
  return cond.type === 'precondV2' ? cond.v2 : null;
}

/** getTimeBounds: PRECOND_TIME's, or the optional ones carried in PRECOND_V2. */
function timeBounds(raw: xdr.Transaction): xdr.TimeBounds | null {
  const cond = raw.cond;
  if (cond.type === 'precondTime') return cond.timeBounds;
  return preconditionsV2(raw)?.timeBounds ?? null;
}

/**
 * The first thing commonValidPreSeqNum checks on a v1 envelope: two identical
 * extraSigners, or an ed25519SignedPayload one with an empty payload, make it
 * txMALFORMED. XDR caps extraSigners at 2, so "identical" compares one pair.
 */
function extraSignersMalformed(raw: xdr.Transaction): string | null {
  const extra = preconditionsV2(raw)?.extraSigners ?? [];
  if (extra.length === 2 && sameBytes(extra[0].toXdr(), extra[1].toXdr())) {
    return 'the two PRECOND_V2 extraSigners are identical';
  }
  for (const s of extra) {
    if (
      s.type === 'signerKeyTypeEd25519SignedPayload' &&
      s.ed25519SignedPayload.payload.length === 0
    ) {
      return 'a PRECOND_V2 ed25519SignedPayload extraSigner has an empty payload';
    }
  }
  return null;
}

/**
 * isTooEarly then isTooLate, each time bounds first and ledger bounds second.
 * `ledger.ledgerSeq` is the ledger the transaction applies in, which is what
 * core validates against at submission (TransactionQueue passes LCL + 1). A
 * zero minTime, maxTime or maxLedger means no bound; maxLedger is exclusive.
 */
function boundsProblem(ledger: Ledger, raw: xdr.Transaction): { code: TxResultCode; detail: string } | null {
  const now = BigInt(ledger.timestamp);
  const seq = ledger.ledgerSeq;
  const tb = timeBounds(raw);
  const lb = preconditionsV2(raw)?.ledgerBounds ?? null;
  const minTime = tb ? tb.minTime : 0n;
  const maxTime = tb ? tb.maxTime : 0n;
  if (minTime !== 0n && minTime > now) {
    return { code: 'txTOO_EARLY', detail: `minTime ${minTime} is after the close time ${now}` };
  }
  if (lb && lb.minLedger > seq) {
    return { code: 'txTOO_EARLY', detail: `minLedger ${lb.minLedger} is after ledger ${seq}` };
  }
  if (maxTime !== 0n && maxTime < now) {
    return { code: 'txTOO_LATE', detail: `maxTime ${maxTime} is before the close time ${now}` };
  }
  if (lb && lb.maxLedger !== 0 && lb.maxLedger <= seq) {
    return { code: 'txTOO_LATE', detail: `maxLedger ${lb.maxLedger} is not after ledger ${seq}` };
  }
  return null;
}

/**
 * isBadSeq past its unconditional first clause. PRECOND_V2 minSeqNum relaxes
 * the strict account seqNum + 1 rule to minSeqNum <= account seqNum < tx seqNum.
 */
function badSequence(raw: xdr.Transaction, currentSeq: bigint, txSeq: bigint): string | null {
  // Present-but-zero still relaxes the rule (core tests the optional, not its value).
  const min = preconditionsV2(raw)?.minSeqNum;
  if (min != null) {
    if (currentSeq < min || currentSeq >= txSeq) {
      return `minSeqNum ${min} needs the account sequence ${currentSeq} in [${min}, ${txSeq})`;
    }
    return null;
  }
  return txSeq === currentSeq + 1n ? null : `expected sequence ${currentSeq + 1n}, got ${txSeq}`;
}

/**
 * isTooEarlyForAccount: minSeqAge against the seqTime, and minSeqLedgerGap
 * against the seqLedger, that the account's last sequence bump stamped into
 * AccountEntry ext v3 (both 0 for an account that has none). Core runs it for
 * every envelope, so with zero bounds it only fails if the clock was moved back
 * past the account's seqTime, which a real network cannot do.
 */
function tooEarlyForAccount(ledger: Ledger, raw: xdr.Transaction, account: xdr.AccountEntry): string | null {
  const v2 = preconditionsV2(raw);
  const minSeqAge = v2 ? v2.minSeqAge : 0n;
  const minSeqLedgerGap = v2 ? v2.minSeqLedgerGap : 0;
  const v3 = accountEntryExtensionV3(account);
  const seqTime = v3 ? v3.seqTime : 0n;
  const seqLedger = v3 ? v3.seqLedger : 0;

  const closeTime = BigInt(ledger.timestamp);
  if (minSeqAge > closeTime || closeTime - minSeqAge < seqTime) {
    return `minSeqAge ${minSeqAge}: the sequence last moved at ${seqTime}, close time is ${closeTime}`;
  }
  const seq = ledger.ledgerSeq;
  if (minSeqLedgerGap > seq || seq - minSeqLedgerGap < seqLedger) {
    return `minSeqLedgerGap ${minSeqLedgerGap}: the sequence last moved in ledger ${seqLedger}, this is ${seq}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the apply path
// ---------------------------------------------------------------------------

/**
 * A validation rejection: nothing in the ledger has changed. `feeCharged` is
 * left 0 for applyTransaction to fill with the nominal fee, unless given.
 */
function fail(code: TxResultCode, detail?: string, feeCharged = 0n): TxOutcome {
  return { code, ok: false, feeCharged, detail, rejected: true };
}

/** Rejections core makes before it seeds a result (createTxError): feeCharged stays 0. */
const unseeded = new WeakSet<TxOutcome>();

function malformed(detail: string): TxOutcome {
  const outcome = fail('txMALFORMED', detail);
  unseeded.add(outcome);
  return outcome;
}

/** stellar-core TransactionFrame.cpp: MAX_RESOURCE_FEE = 1 << 50. */
const MAX_RESOURCE_FEE = 1n << 50n;

/**
 * TransactionFrame::XDRProvidesValidFee: a Soroban transaction (judged by its
 * first operation) must carry SorobanTransactionData with a resource fee in
 * [0, MAX_RESOURCE_FEE]. Checked before anything else, sequence included.
 */
function xdrProvidesValidFee(raw: xdr.Transaction): string | null {
  const first = raw.operations[0];
  if (!first || !SOROBAN_OP_TYPES.has(first.body.type)) return null;
  if (raw.ext.type !== 'sorobanData') return 'a Soroban transaction must carry SorobanTransactionData';
  const resourceFee = raw.ext.sorobanData.resourceFee;
  if (resourceFee < 0n || resourceFee > MAX_RESOURCE_FEE) {
    return `resource fee ${resourceFee} outside [0, 2^50]`;
  }
  return null;
}

/**
 * Switches that turn OFF parts of classic validation, in the spirit of
 * LiteSVM's `withSigverify(false)`. A test about contract logic should not have
 * to satisfy the transaction envelope rules it is not testing.
 */
export interface ValidationOptions {
  /** Verify envelope signatures against account thresholds. Default true. */
  sigverify?: boolean;
  /** Enforce strict seqNum + 1, or the range a PRECOND_V2 minSeqNum allows. Default true. */
  sequenceCheck?: boolean;
  /**
   * Charge fees. Default true. Off, nothing is debited and nothing about the
   * resource fee is checked: neither its declared value against the
   * resources' cost, nor whether it covers the rent and events.
   */
  feeCharging?: boolean;
  /**
   * Enforce the preconditions that read the ledger clock: time bounds, and
   * PRECOND_V2's ledgerBounds, minSeqAge and minSeqLedgerGap. Default true.
   */
  timebounds?: boolean;
}

/**
 * Validate and apply a transaction envelope, exactly as an app would submit it.
 *
 * Fees as stellar-core v29.0.0 charges them: getFee(applying = true) up front
 * (the declared resource fee plus the inclusion fee capped at baseFee per
 * operation), then a refund of the refundable resource fee the operation did
 * not consume on rent and events, all of it if the operation failed.
 */
export function applyTransaction(
  ledger: Ledger,
  envelopeB64: string,
  passphrase: string = DEFAULT_PASSPHRASE,
  validation: ValidationOptions = {},
): TxOutcome {
  const envelope = xdr.TransactionEnvelope.fromXdr(envelopeB64, 'base64');
  const outcome = applyEnvelope(ledger, envelope, passphrase, validation);
  if (outcome.rejected && !unseeded.has(outcome) && outcome.feeCharged === 0n) {
    outcome.feeCharged = nominalFee(envelope) ?? 0n;
  }
  return outcome;
}

function applyEnvelope(
  ledger: Ledger,
  envelope: xdr.TransactionEnvelope,
  passphrase: string,
  validation: ValidationOptions,
): TxOutcome {
  if (envelope.type === 'envelopeTypeTxFeeBump') {
    return applyFeeBump(ledger, envelope, passphrase, validation);
  }
  if (envelope.type !== 'envelopeTypeTx') {
    return malformed('only v1 and fee-bump envelopes are supported');
  }

  const tx = new Transaction(envelope, passphrase);
  const raw = envelope.v1.tx;
  const badFee = xdrProvidesValidFee(raw);
  if (badFee) return malformed(badFee);
  const queueFee = negativeInclusionFee(BigInt(raw.fee), declaredResourceFee(raw));
  if (queueFee) return malformed(queueFee);

  // -- fee source is the tx source for a plain v1 envelope
  const charge =
    validation.feeCharging !== false
      ? {
          payer: muxedToAccountId(raw.sourceAccount),
          upfront: feeToCharge(BigInt(raw.fee), declaredResourceFee(raw), raw.operations.length),
        }
      : null;
  return applyInner(ledger, tx, raw, passphrase, false, validation, envelope.toXdr().length, charge);
}

const declaredResourceFee = (raw: xdr.Transaction): bigint =>
  raw.ext.type === 'sorobanData' ? raw.ext.sorobanData.resourceFee : 0n;

/**
 * TransactionQueue::canAdd (stellar-core v29.0.0 herder/TransactionQueue.cpp
 * :347-352), which a submission meets before checkValid: a negative full or
 * inclusion fee is txMALFORMED with nothing seeded. So a resource fee above the
 * full fee never reaches commonValidPreSeqNum's txSOROBAN_INVALID; a local
 * protocol-29 node answers txMALFORMED, feeCharged 0.
 */
function negativeInclusionFee(fullFee: bigint, resourceFee: bigint): string | null {
  if (fullFee < 0n || fullFee - resourceFee < 0n) {
    return `inclusion fee ${fullFee - resourceFee} is negative: resource fee ${resourceFee} exceeds the full fee ${fullFee}`;
  }
  return null;
}

/**
 * getFee(header, baseFee, applying = true), stellar-core v29.0.0
 * TransactionFrame.cpp:417 and FeeBumpTransactionFrame.cpp:592: the declared
 * resource fee plus the inclusion fee, capped at baseFee * max(1, operations),
 * where a fee bump counts innerOps + 1. The inclusion fee is a bid; a ledger
 * that is not surge pricing charges its base fee. This is what leaves the fee
 * source before the operation runs (processFeeSeqNum).
 */
function feeToCharge(fullFee: bigint, resourceFee: bigint, operations: number): bigint {
  const inclusionFee = fullFee - resourceFee;
  const cap = BigInt(BASE_FEE) * BigInt(Math.max(1, operations));
  return resourceFee + (inclusionFee < cap ? inclusionFee : cap);
}

/** Who pays, and getFee(applying = true) of what they pay for. */
interface FeeCharge {
  payer: xdr.AccountId;
  upfront: bigint;
}

/**
 * getFee(header, baseFee, applying = false): the declared Soroban resource fee
 * plus baseFee * max(1, operations), where a fee bump counts innerOps + 1.
 * What a rejected envelope's result reports as feeCharged; a local protocol-29
 * node reports exactly this for txBAD_AUTH, txBAD_AUTH_EXTRA and txFAILED.
 */
function nominalFee(envelope: xdr.TransactionEnvelope): bigint | undefined {
  let raw: xdr.Transaction;
  if (envelope.type === 'envelopeTypeTxFeeBump') raw = envelope.feeBump.tx.innerTx.v1.tx;
  else if (envelope.type === 'envelopeTypeTx') raw = envelope.v1.tx;
  else return undefined;
  const isBump = envelope.type === 'envelopeTypeTxFeeBump';
  const resourceFee = declaredResourceFee(raw);
  const ops = raw.operations.length + (isBump ? 1 : 0);
  return resourceFee + BigInt(BASE_FEE) * BigInt(Math.max(1, ops));
}

function applyFeeBump(
  ledger: Ledger,
  envelope: xdr.TransactionEnvelopeTxFeeBump,
  passphrase: string,
  validation: ValidationOptions,
): TxOutcome {
  const fb = envelope.feeBump;
  const feeBumpTx = new FeeBumpTransaction(envelope, passphrase);
  const innerEnvelope = xdr.TransactionEnvelope.envelopeTypeTx(fb.tx.innerTx.v1);
  const innerTx = new Transaction(innerEnvelope, passphrase);
  const innerRaw = innerEnvelope.v1.tx;

  // FeeBumpTransactionFrame::checkValidImpl, in its order (stellar-core v29.0.0).
  // XDRProvidesValidFee covers the inner transaction too, so a malformed inner
  // fee is the OUTER envelope's txMALFORMED, not an inner failure.
  const totalFee = fb.tx.fee;
  if (totalFee < 0n) return malformed('negative fee bump fee');
  const badInnerFee = xdrProvidesValidFee(innerRaw);
  if (badInnerFee) return malformed(`inner transaction: ${badInnerFee}`);

  // commonValidPreSeqNum. Inclusion fee = full fee minus the inner Soroban
  // resource fee; a fee bump counts as innerOps + 1 operations, and
  // getMinInclusionFee is baseFee * max(1, operations).
  const resourceFee = declaredResourceFee(innerRaw);
  const innerOps = BigInt(innerRaw.operations.length);
  const minInclusion = (ops: bigint) => BigInt(BASE_FEE) * (ops > 1n ? ops : 1n);
  const inclusionFee = totalFee - resourceFee;
  const queueFee = negativeInclusionFee(totalFee, resourceFee);
  if (queueFee) return malformed(queueFee);
  if (inclusionFee < minInclusion(innerOps + 1n)) {
    return fail(
      'txINSUFFICIENT_FEE',
      `fee bump inclusion fee ${inclusionFee} below baseFee * (innerOps + 1) = ${minInclusion(innerOps + 1n)}`,
    );
  }
  // The bump has to raise the per-operation rate:
  //   outerInclusion * minInclusion(inner) >= innerInclusion * minInclusion(outer).
  // From protocol 23 a Soroban inner tx may have a negative inclusion fee, and
  // then there is nothing to compare.
  const innerInclusion = BigInt(innerRaw.fee) - resourceFee;
  if (innerInclusion >= 0n) {
    const v1 = inclusionFee * minInclusion(innerOps);
    const v2 = innerInclusion * minInclusion(innerOps + 1n);
    if (v1 < v2) {
      // setInsufficientFeeErrorWithFeeCharged(ceil(v2 / minInclusion(inner)))
      const needed = (v2 + minInclusion(innerOps) - 1n) / minInclusion(innerOps);
      return fail('txINSUFFICIENT_FEE', 'the fee bump does not raise the per-operation inclusion fee', needed);
    }
  }

  // A fee bump's fee source MAY be muxed: validateSorobanMemo (TransactionFrame
  // .cpp:363) checks the tx source and the op source, never the fee source.
  const feeSourceId = muxedToAccountId(fb.tx.feeSource);
  const feeAccount = loadAccount(ledger, feeSourceId);
  if (!feeAccount) return fail('txNO_ACCOUNT', 'fee source account does not exist');

  // commonValid: the fee source signs at LOW (a fee bump has no operations of
  // its own), with the OUTER signatures and their own checker.
  const checker =
    validation.sigverify !== false ? new SignatureChecker(feeBumpTx.signatures, feeBumpTx.hash()) : null;
  if (checker && !checker.checkSignature(accountSigners(feeAccount), thresholdsOf(feeAccount)[1])) {
    return fail('txBAD_AUTH', 'fee bump signatures do not satisfy the fee source low threshold');
  }

  const charging = validation.feeCharging !== false;
  if (charging && availableBalance(feeAccount) < totalFee) {
    return fail('txINSUFFICIENT_BALANCE', 'fee source cannot cover the fee bump');
  }

  if (checker && !checker.checkAllSignaturesUsed()) {
    return fail('txBAD_AUTH_EXTRA', 'the fee bump envelope carries a signature no check consumed');
  }

  // The inner transaction is validated without charging its own fee. If it is
  // rejected, the whole fee bump is rejected at submission: nobody pays.
  // Applied, the fee source pays getFee(applying = true) of the BUMP and gets
  // the refund (FeeBumpTransactionFrame::processPostTxSetApply forwards it).
  // The resource fee is priced on the INNER envelope's size: core computes it
  // on the inner TransactionFrame.
  const charge = charging
    ? { payer: feeSourceId, upfront: feeToCharge(totalFee, resourceFee, Number(innerOps) + 1) }
    : null;
  const inner = applyInner(ledger, innerTx, innerRaw, passphrase, true, validation, innerEnvelope.toXdr().length, charge);
  if (inner.rejected) {
    return {
      ...inner,
      code: 'txFEE_BUMP_INNER_FAILED',
      innerCode: inner.code,
      feeCharged: 0n,
    };
  }

  return {
    ...inner,
    code: inner.ok ? 'txFEE_BUMP_INNER_SUCCESS' : 'txFEE_BUMP_INNER_FAILED',
    innerCode: inner.code,
  };
}

function applyInner(
  ledger: Ledger,
  tx: Transaction,
  raw: xdr.Transaction,
  passphrase: string,
  feeBumped: boolean,
  validation: ValidationOptions,
  txSize: number,
  charge: FeeCharge | null,
): TxOutcome {
  const ops = raw.operations;

  // The checks below run in commonValidPreSeqNum's order, then commonValid's
  // (TransactionFrame.cpp, v29.0.0): the order decides which code wins when
  // several apply.
  const badExtraSigners = extraSignersMalformed(raw);
  if (badExtraSigners) return fail('txMALFORMED', badExtraSigners);

  // -- envelope shape (TransactionFrame.cpp:1325, :760) --------------------
  if (ops.length === 0) return fail('txMISSING_OPERATION');

  const opType = ops[0].body.type;
  const sorobanOps = ops.filter((o) => SOROBAN_OP_TYPES.has(o.body.type));
  if (sorobanOps.length === 0) {
    return fail('txMALFORMED', 'classic operations are out of scope for this harness');
  }
  // "Only one operation is allowed per Soroban transaction."
  if (sorobanOps.length !== ops.length || ops.length !== 1) {
    return fail('txMALFORMED', 'a Soroban transaction must contain exactly one operation');
  }

  // -- P25+: no memo, no muxed ENVELOPE source on InvokeHostFunction -------
  // TransactionFrame.cpp:383-386. Note this is only about the classic envelope
  // field. Muxed addresses are fully supported *inside* Soroban as
  // ScAddress::MuxedAccount (scAddressTypeMuxedAccount) -- that is what
  // replaced memos, and it is the host's business, not ours.
  // validateSorobanMemo only applies to INVOKE_HOST_FUNCTION; ExtendFootprintTTL
  // and RestoreFootprint return true early.
  if (opType === 'invokeHostFunction') {
    const memoIsNone = raw.memo.type === 'memoNone';
    const opSource = ops[0].sourceAccount;
    if (!memoIsNone || isMuxed(raw.sourceAccount) || (opSource && isMuxed(opSource))) {
      return fail(
        'txSOROBAN_INVALID',
        'Soroban transactions are not allowed to use memo or muxed source account',
      );
    }
  }

  const sorobanData = raw.ext.type === 'sorobanData' ? raw.ext.sorobanData : null;
  if (!sorobanData) return fail('txSOROBAN_INVALID', 'missing SorobanTransactionData');

  // -- the declared resources against the network's limits ------------------
  // commonValidPreSeqNum (TransactionFrame.cpp:1360), right after the memo
  // check, fee bump or not, and whether or not fees are charged.
  const overLimit = sorobanResourcesProblem(ledger.feeSettings, sorobanData, txSize, opType === 'restoreFootprint');
  if (overLimit) return fail('txSOROBAN_INVALID', overLimit);

  // -- the declared resource fee against what the resources cost ------------
  // commonValidPreSeqNum (TransactionFrame.cpp:1386-1410), next: the resource
  // fee has to cover computeSorobanResourceFee of the DECLARED resources,
  // priced on this envelope's size, with no events yet. The non-refundable
  // part is charged whatever happens; the rest is the most rent and events may
  // cost.
  const resourceFee = sorobanData.resourceFee;
  let nonRefundable = 0n;
  if (charge) {
    const actual = ledger.computeResourceFee(sorobanData, txSize, 0, opType === 'restoreFootprint');
    nonRefundable = actual.nonRefundable;
    if (resourceFee < actual.nonRefundable + actual.refundable) {
      return fail(
        'txSOROBAN_INVALID',
        'transaction `sorobanData.resourceFee` is lower than the actual Soroban resource fee: ' +
          `${resourceFee} < ${actual.nonRefundable + actual.refundable}`,
      );
    }
  }
  const maxRefundable = resourceFee - nonRefundable;

  // -- time and ledger bounds (isTooEarly, isTooLate) ----------------------
  // Still commonValidPreSeqNum, right after the Soroban checks above and
  // before the source account is even loaded, so an expired envelope is
  // txTOO_LATE whatever its sequence number.
  if (validation.timebounds !== false) {
    const bounds = boundsProblem(ledger, raw);
    if (bounds) return fail(bounds.code, bounds.detail);
  }

  // -- source account ------------------------------------------------------
  const sourceId = muxedToAccountId(raw.sourceAccount);
  const account = loadAccount(ledger, sourceId);
  if (!account) return fail('txNO_ACCOUNT', 'source account does not exist');

  // stellar-core hands the OPERATION source to the host as the Soroban invoker
  // (InvokeHostFunctionOpFrame.cpp passes mOpFrame.getSourceID()), falling back
  // to the transaction source only when the operation names none.
  // A missing operation source is not a submit-time error: core checks a
  // signature from that key instead (checkSignatureNoAccount) and fails the
  // operation with opNO_ACCOUNT when it applies.
  const opSourceMuxed = ops[0].sourceAccount;
  const invokerId = opSourceMuxed ? muxedToAccountId(opSourceMuxed) : sourceId;
  const opAccount = opSourceMuxed ? loadAccount(ledger, invokerId) : account;

  // -- sequence number -----------------------------------------------------
  const currentSeq = account.seqNum;
  const txSeq = raw.seqNum;
  // Core's first isBadSeq clause is unconditional: a transaction may never use
  // getStartingSequenceNumber(currentLedger), because CreateAccount hands that
  // very number to accounts created in this ledger.
  if (txSeq === (BigInt(ledger.ledgerSeq) << 32n)) {
    return fail('txBAD_SEQ', 'sequence equals getStartingSequenceNumber(currentLedger)');
  }
  if (validation.sequenceCheck !== false) {
    const bad = badSequence(raw, currentSeq, txSeq);
    if (bad) return fail('txBAD_SEQ', bad);
  }

  // -- minSeqAge / minSeqLedgerGap (isTooEarlyForAccount) ------------------
  if (validation.timebounds !== false) {
    const early = tooEarlyForAccount(ledger, raw, account);
    if (early) return fail('txBAD_MIN_SEQ_AGE_OR_GAP', early);
  }

  // -- signatures, part 1 --------------------------------------------------
  // stellar-core runs three checks over ONE SignatureChecker, all at submission
  // (TransactionFrame::checkValid; OperationFrame::checkValid with forApply =
  // false), so every failure is a rejection with no fee and no sequence number:
  //   1. checkAllTransactionSignatures: tx source at LOW, plus extraSigners
  //      -> txBAD_AUTH
  //   2. each operation's checkSignature at its threshold -> opBAD_AUTH in txFAILED
  //   3. checkAllSignaturesUsed -> txBAD_AUTH_EXTRA
  // Checking only the operation source would leave the transaction source
  // unauthenticated whenever the operation names its own — accepting envelopes
  // the network rejects, which is the one direction a harness must never fail in.
  const checker =
    validation.sigverify !== false ? new SignatureChecker(tx.signatures, tx.hash()) : null;
  if (checker) {
    if (!checker.checkSignature(accountSigners(account), thresholdsOf(account)[1])) {
      return fail(
        'txBAD_AUTH',
        `transaction source signatures do not satisfy low threshold ${thresholdsOf(account)[1]} for ${
          StrKey.encodeEd25519PublicKey(account.accountId.ed25519.toBytes())
        }`,
      );
    }
    if (!checkExtraSigners(checker, raw)) {
      return fail('txBAD_AUTH', 'not every PRECOND_V2 extraSigner signed');
    }
  }

  // -- fees ----------------------------------------------------------------
  const totalFee = BigInt(raw.fee);
  const inclusionFee = totalFee - resourceFee;

  // From protocol 23 a fee-bumped inner tx may carry an insufficient full fee
  // (TransactionFrame.cpp:1368).
  if (!feeBumped && inclusionFee < BigInt(BASE_FEE)) {
    return fail('txINSUFFICIENT_FEE', `inclusion fee ${inclusionFee} below ${BASE_FEE}`);
  }

  // A fee bump checked its own fee source's balance.
  if (charge && !feeBumped) {
    const payerAccount = loadAccount(ledger, charge.payer)!;
    if (availableBalance(payerAccount) < totalFee) {
      return fail('txINSUFFICIENT_BALANCE', 'source cannot cover the fee');
    }
  }

  // -- signatures, part 2 --------------------------------------------------
  // The operation's own threshold: MEDIUM for InvokeHostFunction, LOW for
  // ExtendFootprintTTL / RestoreFootprint (OperationFrame / *OpFrame.cpp
  // getThresholdLevel). Still at submission: a local protocol-29 node answers
  // ERROR txFAILED [opBAD_AUTH] and moves neither the fee nor the sequence.
  if (checker) {
    const level = opType === 'invokeHostFunction' ? 2 : 1;
    const opSigned = opAccount
      ? checker.checkSignature(accountSigners(opAccount), thresholdsOf(opAccount)[level])
      : checker.checkSignature(
          [{ key: xdr.SignerKey.signerKeyTypeEd25519(invokerId.ed25519), weight: 1 }],
          0,
        );
    if (!opSigned) {
      return {
        ...fail(
          'txFAILED',
          `operation source signatures do not satisfy its ${level === 2 ? 'medium' : 'low'} threshold for ${
            StrKey.encodeEd25519PublicKey(invokerId.ed25519.toBytes())
          } (opBAD_AUTH)`,
        ),
        opCode: 'opBAD_AUTH',
      };
    }
  }

  // The operation's own doCheckValidForSoroban, right after its signature
  // check (OperationFrame::checkValid), so still at submission.
  const footprintProblem = footprintOpMalformed(ledger, ops[0], sorobanData);
  if (footprintProblem) {
    return { ...fail('txFAILED', footprintProblem.detail), footprintOpResult: footprintProblem.code };
  }

  if (checker && !checker.checkAllSignaturesUsed()) {
    return fail('txBAD_AUTH_EXTRA', 'the envelope carries a signature no check consumed');
  }

  // -- commit the classic side, then run the host --------------------------
  if (validation.sequenceCheck !== false) bumpSequence(ledger, sourceId, txSeq);
  else bumpSequence(ledger, sourceId, currentSeq + 1n);

  if (charge) debit(ledger, charge.payer, charge.upfront);

  // After the operation, the fee source gets back the refundable fee it did
  // not consume (TransactionFrame::refundSorobanFee). A failed operation
  // consumes none: any error resets the RefundableFeeTracker
  // (MutableTransactionResult.cpp, setError -> resetConsumedFee).
  const settle = (
    outcome: Omit<TxOutcome, 'feeCharged'>,
    consumed: { refundable: bigint; rent: bigint } = { refundable: 0n, rent: 0n },
  ): TxOutcome => {
    if (!charge) return { ...outcome, feeCharged: 0n };
    const refund = maxRefundable - consumed.refundable;
    if (refund > 0n) debit(ledger, charge.payer, -refund);
    return {
      ...outcome,
      feeCharged: charge.upfront - refund,
      sorobanFee: { nonRefundable, refundable: consumed.refundable, rent: consumed.rent },
    };
  };
  const refundableCap = charge ? maxRefundable : undefined;

  if (!opAccount) {
    return settle({
      code: 'txFAILED',
      ok: false,
      opCode: 'opNO_ACCOUNT',
      detail: 'operation source account does not exist (opNO_ACCOUNT)',
    });
  }

  if (opType === 'extendFootprintTtl' || opType === 'restoreFootprint') {
    const extend = opType === 'extendFootprintTtl';
    const applied = extend
      ? applyExtendFootprintTtl(
          ledger,
          xdr.expectUnionVariant(ops[0].body, 'extendFootprintTtl').extendFootprintTtlOp.extendTo,
          sorobanData,
          refundableCap,
        )
      : applyRestoreFootprint(ledger, sorobanData, refundableCap);
    if (applied.overLimit) {
      return settle({
        code: 'txFAILED',
        ok: false,
        footprintOpResult: extend ? 'extendFootprintTtlResourceLimitExceeded' : 'restoreFootprintResourceLimitExceeded',
        detail: applied.overLimit,
      });
    }
    if (applied.short) {
      return settle({
        code: 'txFAILED',
        ok: false,
        footprintOpResult: extend
          ? 'extendFootprintTtlInsufficientRefundableFee'
          : 'restoreFootprintInsufficientRefundableFee',
        detail: applied.short,
      });
    }
    // consumeRefundableSorobanResources(0, rentFee): no events, so the
    // refundable fee consumed is the rent alone.
    return settle(
      {
        code: 'txSUCCESS',
        ok: true,
        footprintOpResult: extend ? 'extendFootprintTtlSuccess' : 'restoreFootprintSuccess',
        changedKeys: applied.changed,
      },
      { refundable: applied.rent, rent: applied.rent },
    );
  }

  const { hostFunction: hostFn, auth } = xdr.expectUnionVariant(ops[0].body, 'invokeHostFunction').invokeHostFunctionOp;
  const resources = sorobanData.resources;

  const sent = ledger.send(
    hostFn,
    invokerId.toXdr('base64'),
    resources.toXdr('base64'),
    auth.map((a) => a.toXdr('base64')),
    [],
    refundableCap,
  );

  return settle(
    {
      code: sent.ok ? 'txSUCCESS' : 'txFAILED',
      ok: sent.ok,
      returnValueXdr: sent.returnValueXdr,
      eventsXdr: sent.eventsXdr,
      changedKeys: sent.changedKeys,
      removedKeys: sent.removedKeys,
      invokeResult: sent.ok ? undefined : (sent.resultCode as TxOutcome['invokeResult']),
      error: sent.error,
      detail: sent.detail,
      diagnosticEventsXdr: sent.diagnosticEventsXdr,
    },
    sent.ok ? { refundable: BigInt(sent.refundableFeeConsumed), rent: BigInt(sent.rentFee) } : undefined,
  );
}

// ---------------------------------------------------------------------------
// the network's resource limits (stellar-core v29.0.0, protocol 23+ rules)
// ---------------------------------------------------------------------------

const isAsciiAlphaNumeric = (b: number) =>
  (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39);

/**
 * isAssetValid<TrustLineAsset> (stellar-core src/util/types.cpp:149): an
 * asset code of ASCII letters and digits, zero-padded at the end only, at least
 * one character for alphanum4 and five for alphanum12. Native and (protocol 18+)
 * pool shares are valid.
 */
function trustLineAssetValid(asset: xdr.TrustLineAsset): boolean {
  const kind = asset.type;
  if (kind === 'assetTypeNative' || kind === 'assetTypePoolShare') return true;
  const code: Uint8Array =
    kind === 'assetTypeCreditAlphanum4'
      ? xdr.expectUnionVariant(asset, 'assetTypeCreditAlphanum4').alphaNum4.assetCode.toBytes()
      : xdr.expectUnionVariant(asset, 'assetTypeCreditAlphanum12').alphaNum12.assetCode.toBytes();
  let zeros = false;
  let chars = 0;
  for (const b of code) {
    if (b === 0) zeros = true;
    else if (zeros || b > 0x7f || !isAsciiAlphaNumeric(b)) return false;
    else chars++;
  }
  return kind === 'assetTypeCreditAlphanum4' ? chars > 0 : chars > 4;
}

/** isIssuer (stellar-core src/util/types.h:69). */
function isIssuerOf(account: xdr.AccountId, asset: xdr.TrustLineAsset): boolean {
  const kind = asset.type;
  if (kind !== 'assetTypeCreditAlphanum4' && kind !== 'assetTypeCreditAlphanum12') return false;
  const issuer =
    kind === 'assetTypeCreditAlphanum4'
      ? xdr.expectUnionVariant(asset, 'assetTypeCreditAlphanum4').alphaNum4.issuer
      : xdr.expectUnionVariant(asset, 'assetTypeCreditAlphanum12').alphaNum12.issuer;
  return sameBytes(issuer.toXdr(), account.toXdr());
}

/**
 * TransactionFrame::checkSorobanResources (TransactionFrame.cpp:778-994): the
 * DECLARED resources against the network's per-transaction limits, then each
 * footprint key, the envelope's size, and the archived-entry indexes. Core's
 * diagnostic text and values, or null. `txSize` is the XDR size of the (inner)
 * envelope: a fee bump's own bytes do not count.
 */
function sorobanResourcesProblem(
  limits: NetworkFeeSettings,
  data: xdr.SorobanTransactionData,
  txSize: number,
  isRestore: boolean,
): string | null {
  const r = data.resources;
  const readOnly = r.footprint.readOnly;
  const readWrite = r.footprint.readWrite;
  const over = (what: string, value: number, limit: number) => `${what}: ${value} > ${limit}`;

  if (r.instructions > limits.txMaxInstructions) {
    return over('transaction instructions resources exceed network config limit', r.instructions, limits.txMaxInstructions);
  }
  if (r.diskReadBytes > limits.txMaxDiskReadBytes) {
    return over('transaction byte-read resources exceed network config limit', r.diskReadBytes, limits.txMaxDiskReadBytes);
  }
  if (r.writeBytes > limits.txMaxWriteBytes) {
    return over('transaction byte-write resources exceed network config limit', r.writeBytes, limits.txMaxWriteBytes);
  }
  // getNumDiskReadEntries (TransactionFrame.cpp:67): every entry a restore
  // names, otherwise the classic keys and the archived entries marked for
  // restoring. Live Soroban state is in memory.
  const archived = data.ext.type === 'resourceExt' ? data.ext.resourceExt.archivedSorobanEntries : [];
  const diskReads = isRestore
    ? readWrite.length
    : [...readOnly, ...readWrite].filter((k) => !isTtlKey(k)).length + archived.length;
  const footprintEntries = readOnly.length + readWrite.length;
  if (footprintEntries > limits.txMaxFootprintEntries) {
    return over(
      'the number of entries in transaction footprint exceeds the network config limit',
      footprintEntries,
      limits.txMaxFootprintEntries,
    );
  }
  if (diskReads > limits.txMaxDiskReadEntries) {
    return over('transaction entry-disk-read resources exceed network config limit', diskReads, limits.txMaxDiskReadEntries);
  }
  if (readWrite.length > limits.txMaxWriteLedgerEntries) {
    return over('transaction entry-write resources exceed network config limit', readWrite.length, limits.txMaxWriteLedgerEntries);
  }

  for (const key of [...readOnly, ...readWrite]) {
    switch (key.type) {
      case 'account':
      case 'contractData':
      case 'contractCode':
        break;
      case 'trustline': {
        const tl = key.trustLine;
        const asset = tl.asset;
        if (!trustLineAssetValid(asset) || asset.type === 'assetTypeNative' || isIssuerOf(tl.accountId, asset)) {
          return 'transaction footprint contains invalid trustline asset';
        }
        break;
      }
      default:
        return `transaction footprint contains unsupported ledger key type: ${xdr.LedgerEntryType[key.type].value}`;
    }
    const keySize = key.toXdr().length;
    if (keySize > limits.maxContractDataKeySizeBytes) {
      return over('transaction footprint key exceeds network config limit', keySize, limits.maxContractDataKeySizeBytes);
    }
  }

  if (txSize > limits.txMaxSizeBytes) {
    return over('total transaction size exceeds network config limit', txSize, limits.txMaxSizeBytes);
  }

  let last: number | undefined;
  for (const index of archived) {
    if (last !== undefined && index <= last) return 'archivedSorobanEntries must be sorted in ascending order';
    last = index;
    if (index >= readWrite.length) {
      return `archivedSorobanEntries index is out of bounds: ${index} >= ${readWrite.length}`;
    }
    if (!isPersistentKey(readWrite[index])) {
      return `archivedSorobanEntries index points to a non-persistent entry: ${index}, key type ${xdr.LedgerEntryType[readWrite[index].type].value}`;
    }
  }
  return null;
}

/**
 * validateContractLedgerEntry (stellar-core TransactionUtils.cpp:2007): the
 * network's cap on a ContractCode or ContractData entry's XDR size, checked at
 * apply on every entry an operation reads or writes. Core's diagnostic, or
 * null.
 */
function contractEntryTooLarge(limits: NetworkFeeSettings, key: xdr.LedgerKey, entrySize: number): string | null {
  if (key.type === 'contractCode' && limits.maxContractSizeBytes < entrySize) {
    return `Wasm size exceeds network config maximum contract size: ${entrySize} > ${limits.maxContractSizeBytes}`;
  }
  if (key.type === 'contractData' && limits.maxContractDataEntrySizeBytes < entrySize) {
    return `ContractData size exceeds network config maximum size: ${entrySize} > ${limits.maxContractDataEntrySizeBytes}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ExtendFootprintTTL / RestoreFootprint (stellar-core v29.0.0)
// ---------------------------------------------------------------------------

const isTtlKey = (k: xdr.LedgerKey) => k.type === 'contractData' || k.type === 'contractCode';

const isPersistentKey = (k: xdr.LedgerKey) =>
  k.type === 'contractCode' ||
  (k.type === 'contractData' && k.contractData.durability.name === 'persistent');

/**
 * ExtendFootprintTTLOpFrame / RestoreFootprintOpFrame::doCheckValidForSoroban:
 * the shape rules, checked at submission. Returns the MALFORMED inner result
 * with core's diagnostic text, or null for any other operation.
 */
function footprintOpMalformed(
  ledger: Ledger,
  op: xdr.Operation,
  sorobanData: xdr.SorobanTransactionData,
): { code: NonNullable<TxOutcome['footprintOpResult']>; detail: string } | null {
  const body = op.body;
  const fp = sorobanData.resources.footprint;
  if (body.type === 'extendFootprintTtl') {
    const malformed = (detail: string) => ({ code: 'extendFootprintTtlMalformed' as const, detail });
    if (fp.readWrite.length > 0) {
      return malformed('read-write footprint must be empty for ExtendFootprintTTL operation');
    }
    if (!fp.readOnly.every(isTtlKey)) {
      return malformed('only entries with TTL (contract data or code entries) can have it extended');
    }
    const extendTo = body.extendFootprintTtlOp.extendTo;
    const max = ledger.archivalSettings.maxEntryTtl - 1;
    if (extendTo > max) return malformed(`TTL extension is too large: ${extendTo} > ${max}`);
    return null;
  }
  if (body.type === 'restoreFootprint') {
    const malformed = (detail: string) => ({ code: 'restoreFootprintMalformed' as const, detail });
    if (fp.readOnly.length > 0) {
      return malformed('read-only footprint must be empty for RestoreFootprint operation');
    }
    if (!fp.readWrite.every(isPersistentKey)) {
      return malformed('only persistent Soroban entries can be restored');
    }
  }
  return null;
}

/** What an ExtendFootprintTTL / RestoreFootprint did, or why it did nothing. */
interface FootprintOpApplied {
  changed: string[];
  /** compute_rent_fee over the TTLs it moved. */
  rent: bigint;
  /** Set when the refundable fee could not cover `rent`: nothing was written. */
  short?: string;
  /** Set when an entry broke a size limit (RESOURCE_LIMIT_EXCEEDED): nothing was written. */
  overLimit?: string;
}

/**
 * Price the TTL moves, then make them only if the refundable fee covers the
 * rent (RefundableFeeTracker::consumeRefundableSorobanResources(0, rentFee));
 * otherwise the operation fails and the ledger is untouched. `maxRefundable`
 * undefined means fees are not being charged.
 */
function moveTtls(
  ledger: Ledger,
  moves: { k: string; entry: string; oldLiveUntil: number; newLiveUntil: number }[],
  maxRefundable: bigint | undefined,
): FootprintOpApplied {
  const rent = ledger.computeRentFee(
    moves.map((m) => ({
      keyB64: m.k,
      size: ledger.entrySizeForRent(m.k)!,
      oldLiveUntil: m.oldLiveUntil,
      newLiveUntil: m.newLiveUntil,
    })),
  );
  if (maxRefundable !== undefined && maxRefundable < rent) {
    return {
      changed: [],
      rent: 0n,
      short: `refundable resource fee was not sufficient to cover the ledger storage rent: ${rent} > ${maxRefundable}`,
    };
  }
  for (const m of moves) ledger.putEntry(m.entry, m.newLiveUntil);
  return { changed: moves.map((m) => m.k), rent };
}

/**
 * ExtendFootprintTTLOpFrame apply (protocol 23+): each live read-only entry
 * whose TTL ends before ledger + extendTo is raised to exactly that; missing,
 * archived and already-long-enough entries are skipped (an archived one must be
 * restored). Each one moved is charged rent for the added ledgers at its rent
 * size (createEntryRentChangeWithoutModification), out of the refundable fee:
 * EXTEND_FOOTPRINT_TTL_INSUFFICIENT_REFUNDABLE_FEE when it falls short. An
 * entry above the network's size limit fails the operation with
 * EXTEND_FOOTPRINT_TTL_RESOURCE_LIMIT_EXCEEDED (ExtendFootprintTTLOpFrame.cpp
 * :165). From protocol 23 the entries are in memory, so the declared
 * diskReadBytes is not checked (the parallel apply helper's
 * checkReadBytesResourceLimit returns true).
 */
function applyExtendFootprintTtl(
  ledger: Ledger,
  extendTo: number,
  sorobanData: xdr.SorobanTransactionData,
  maxRefundable: bigint | undefined,
): FootprintOpApplied {
  const newLiveUntil = ledger.ledgerSeq + extendTo;
  const moves = [];
  for (const key of sorobanData.resources.footprint.readOnly) {
    const k = key.toXdr('base64');
    const entry = ledger.getEntry(k);
    const ttl = ledger.getEntryTtl(k);
    if (!entry || ttl === undefined || ttl < ledger.ledgerSeq) continue; // missing, or not live
    if (ttl >= newLiveUntil) continue;
    const overLimit = contractEntryTooLarge(ledger.feeSettings, key, Buffer.from(entry, 'base64').length);
    if (overLimit) return { changed: [], rent: 0n, overLimit };
    moves.push({ k, entry, oldLiveUntil: ttl, newLiveUntil });
  }
  return moveTtls(ledger, moves, maxRefundable);
}

/**
 * RestoreFootprintOpFrame apply: each archived read-write entry gets TTL
 * ledger + minPersistentTTL - 1 ("including the current ledger"); live and
 * missing ones are skipped. Rent is charged as for a new entry of that size
 * (old size and TTL 0), out of the refundable fee:
 * RESTORE_FOOTPRINT_INSUFFICIENT_REFUNDABLE_FEE when it falls short. Each one
 * restored is read from disk and written back, so (RestoreFootprintOpFrame.cpp
 * :198-232) the entries restored so far may not exceed the declared
 * diskReadBytes, then each must fit the network's entry size limit, then their
 * total may not exceed the declared writeBytes:
 * RESTORE_FOOTPRINT_RESOURCE_LIMIT_EXCEEDED, nothing restored. There is no hot
 * archive here: an archived persistent entry stays in the store, expired.
 */
function applyRestoreFootprint(
  ledger: Ledger,
  sorobanData: xdr.SorobanTransactionData,
  maxRefundable: bigint | undefined,
): FootprintOpApplied {
  const restoredLiveUntil = ledger.ledgerSeq + ledger.archivalSettings.minPersistentTtl - 1;
  const resources = sorobanData.resources;
  const limits = ledger.feeSettings;
  let readBytes = 0;
  let writeBytes = 0;
  const moves = [];
  for (const key of resources.footprint.readWrite) {
    const k = key.toXdr('base64');
    const entry = ledger.getEntry(k);
    const ttl = ledger.getEntryTtl(k);
    if (!entry || ttl === undefined) continue;
    if (ttl >= ledger.ledgerSeq) continue; // live
    const entrySize = Buffer.from(entry, 'base64').length;
    readBytes += entrySize;
    if (resources.diskReadBytes < readBytes) {
      return {
        changed: [],
        rent: 0n,
        overLimit: `operation byte-read resources exceeds amount specified: ${readBytes} > ${resources.diskReadBytes}`,
      };
    }
    writeBytes += entrySize;
    const overLimit = contractEntryTooLarge(limits, key, entrySize);
    if (overLimit) return { changed: [], rent: 0n, overLimit };
    if (resources.writeBytes < writeBytes) {
      return {
        changed: [],
        rent: 0n,
        overLimit: `operation byte-write resources exceeds amount specified: ${writeBytes} > ${resources.writeBytes}`,
      };
    }
    moves.push({ k, entry, oldLiveUntil: 0, newLiveUntil: restoredLiveUntil });
  }
  return moveTtls(ledger, moves, maxRefundable);
}

/**
 * TransactionFrame::processSeqNum + maybeUpdateAccountOnLedgerSeqUpdate: from
 * protocol 19 every sequence bump promotes the account to the AccountEntry
 * ext v1 -> v2 -> v3 chain (prepareAccountEntryExtensionV3, TransactionUtils.cpp)
 * and stamps seqLedger / seqTime with the ledger it applied in. The entry is
 * then 52 bytes larger for good (more with signers), which the host meters as
 * disk_read_bytes whenever the account is in a footprint.
 */
function bumpSequence(ledger: Ledger, id: xdr.AccountId, to: bigint): void {
  const account = loadAccount(ledger, id)!;
  const v3 = prepareAccountEntryExtensionV3(account);
  storeAccount(
    ledger,
    new xdr.AccountEntry({
      ...account,
      seqNum: to,
      ext: withAccountEntryExtensionV3(
        account,
        new xdr.AccountEntryExtensionV3({ ...v3, seqLedger: ledger.ledgerSeq, seqTime: BigInt(ledger.timestamp) }),
      ),
    }),
  );
}

/** hasAccountEntryExtV3 / getAccountEntryExtensionV3: the v3 extension, if the chain reaches it. */
function accountEntryExtensionV3(account: xdr.AccountEntry): xdr.AccountEntryExtensionV3 | null {
  if (account.ext.type !== 'v1') return null;
  const v1 = account.ext.v1;
  if (v1.ext.type !== 'v2') return null;
  const v2 = v1.ext.v2;
  return v2.ext.type === 'v3' ? v2.ext.v3 : null;
}

/**
 * Core's prepareAccountEntryExtensionV1/V2/V3: the v1 and v2 levels as they
 * are, or created zeroed where missing. XDR values are immutable, so the chain
 * is rebuilt around a v3 by `withAccountEntryExtensionV3`.
 */
function accountEntryExtensionChain(account: xdr.AccountEntry): {
  v1: xdr.AccountEntryExtensionV1;
  v2: xdr.AccountEntryExtensionV2;
} {
  const v1 =
    account.ext.type === 'v1'
      ? account.ext.v1
      : new xdr.AccountEntryExtensionV1({
          liabilities: new xdr.Liabilities({ buying: 0n, selling: 0n }),
          ext: xdr.AccountEntryExtensionV1Ext.v0(),
        });
  const v2 =
    v1.ext.type === 'v2'
      ? v1.ext.v2
      : new xdr.AccountEntryExtensionV2({
          numSponsored: 0,
          numSponsoring: 0,
          signerSponsoringIDs: account.signers.map(() => null),
          ext: xdr.AccountEntryExtensionV2Ext.v0(),
        });
  return { v1, v2 };
}

/** The account's v3 extension, or a zeroed one when the chain does not reach it. */
function prepareAccountEntryExtensionV3(account: xdr.AccountEntry): xdr.AccountEntryExtensionV3 {
  return (
    accountEntryExtensionV3(account) ??
    new xdr.AccountEntryExtensionV3({ ext: xdr.ExtensionPoint.v0(), seqLedger: 0, seqTime: 0n })
  );
}

/** The account's ext chain, with whatever was missing created, ending in `v3`. */
function withAccountEntryExtensionV3(
  account: xdr.AccountEntry,
  v3: xdr.AccountEntryExtensionV3,
): xdr.AccountEntryExt {
  const { v1, v2 } = accountEntryExtensionChain(account);
  return xdr.AccountEntryExt.v1(
    new xdr.AccountEntryExtensionV1({
      ...v1,
      ext: xdr.AccountEntryExtensionV1Ext.v2(
        new xdr.AccountEntryExtensionV2({ ...v2, ext: xdr.AccountEntryExtensionV2Ext.v3(v3) }),
      ),
    }),
  );
}

function debit(ledger: Ledger, id: xdr.AccountId, amount: bigint): void {
  const account = loadAccount(ledger, id)!;
  storeAccount(ledger, new xdr.AccountEntry({ ...account, balance: account.balance - amount }));
}
