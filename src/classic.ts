/**
 * The classic layer: everything stellar-core validates that the Soroban host
 * does not. Written in TypeScript on purpose — it is the layer most likely to
 * need per-project adjustment, and here it iterates without rebuilding wasm.
 *
 * Scope, deliberately: transaction envelopes, sequence numbers, timebounds,
 * signature weights against thresholds, inclusion/resource fees, and fee bumps.
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
   * transaction it is what was debited. For a `rejected` one NOTHING was
   * debited: core seeds the result with getFee(header, baseFee, applying =
   * false) = declared resource fee + baseFee * max(1, ops), or 0 when it
   * rejected the XDR before seeding (createTxError), or the fee it would need
   * for a fee bump that does not raise the rate.
   */
  feeCharged: bigint;
  /** Populated for fee bumps. */
  innerCode?: TxResultCode;
  error?: string;
  /** Diagnostic text, mirroring core's diagnostic events. */
  detail?: string;
  /**
   * Rejected by validation before touching the ledger: no fee, no sequence
   * number. stellar-rpc reports these as ERROR at submit, whatever the code —
   * including a txFAILED whose operation failed its signature check.
   */
  rejected?: boolean;
  /** For txFAILED decided by the classic layer rather than by the host. */
  opCode?: 'opBAD_AUTH' | 'opNO_ACCOUNT';
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
  return m.switch().name === 'keyTypeMuxedEd25519'
    ? xdr.AccountId.publicKeyTypeEd25519(m.med25519().ed25519())
    : xdr.AccountId.publicKeyTypeEd25519(m.ed25519());
}

export function isMuxed(m: xdr.MuxedAccount): boolean {
  return m.switch().name === 'keyTypeMuxedEd25519';
}

export function loadAccount(ledger: Ledger, id: xdr.AccountId): xdr.AccountEntry | null {
  const raw = ledger.getEntry(accountKey(id).toXDR('base64'));
  if (!raw) return null;
  return xdr.LedgerEntry.fromXDR(raw, 'base64').data().account();
}

export function storeAccount(ledger: Ledger, account: xdr.AccountEntry): void {
  ledger.putEntry(
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: ledger.ledgerSeq,
      data: xdr.LedgerEntryData.account(account),
      ext: new xdr.LedgerEntryExt(0),
    }).toXDR('base64'),
  );
}

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
    balance: new xdr.Int64(opts.balance ?? 100_000_000_000n),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(opts.seqNum ?? 0n)),
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
    ext: new xdr.AccountEntryExt(0),
  });
  storeAccount(ledger, account);
}

/** Available balance net of the base reserve requirement. */
export function availableBalance(account: xdr.AccountEntry): bigint {
  const reserve = BigInt(2 + account.numSubEntries()) * BigInt(BASE_RESERVE);
  return BigInt(account.balance().toString()) - reserve;
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
  txHash: Buffer,
): number {
  const candidates: { pk: string; weight: number }[] = [
    {
      pk: StrKey.encodeEd25519PublicKey(account.accountId().ed25519()),
      weight: account.thresholds()[0],
    },
  ];
  for (const s of account.signers()) {
    if (s.key().switch().name !== 'signerKeyTypeEd25519') continue;
    candidates.push({
      pk: StrKey.encodeEd25519PublicKey(s.key().ed25519()),
      weight: s.weight(),
    });
  }

  let total = 0;
  const used = new Set<string>();
  for (const sig of signatures) {
    for (const c of candidates) {
      if (used.has(c.pk)) continue;
      const kp = Keypair.fromPublicKey(c.pk);
      // Hint is a cheap prefilter; the signature check is what decides.
      if (!kp.signatureHint().equals(sig.hint())) continue;
      if (kp.verify(txHash, sig.signature())) {
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
  const master = account.thresholds()[0];
  if (master) {
    signers.push({
      key: xdr.SignerKey.signerKeyTypeEd25519(account.accountId().ed25519()),
      weight: master,
    });
  }
  for (const s of account.signers()) signers.push({ key: s.key(), weight: s.weight() });
  return signers;
}

/** SignatureUtils getHint: the last 4 bytes, or all of them zero-padded if fewer. */
function hintOf(bytes: Buffer): Buffer {
  const hint = Buffer.alloc(4);
  if (bytes.length < 4) bytes.copy(hint, 0);
  else bytes.copy(hint, 0, bytes.length - 4);
  return hint;
}

/** SignatureUtils doesHintMatch: needs at least 4 bytes, compares the last 4. */
function hintMatches(bytes: Buffer, hint: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(bytes.length - 4).equals(hint);
}

function verifyEd25519(publicKey: Buffer, signature: Buffer, message: Buffer): boolean {
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
    private readonly contentsHash: Buffer,
  ) {
    this.used = signatures.map(() => false);
  }

  checkSignature(signers: WeightedSigner[], neededWeight: number): boolean {
    const ofType = (name: string) => signers.filter((s) => s.key.switch().name === name);
    const cap = (w: number) => Math.min(w, 255);
    let total = 0;

    for (const s of ofType('signerKeyTypePreAuthTx')) {
      if (s.key.preAuthTx().equals(this.contentsHash)) {
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
      verifyAll(ofType('signerKeyTypeHashX'), (sig, s) =>
        hintMatches(s.key.hashX(), sig.hint()) && sha256(sig.signature()).equals(s.key.hashX()),
      )
    ) {
      return true;
    }
    if (
      verifyAll(ofType('signerKeyTypeEd25519'), (sig, s) =>
        hintMatches(s.key.ed25519(), sig.hint()) &&
        verifyEd25519(s.key.ed25519(), sig.signature(), this.contentsHash),
      )
    ) {
      return true;
    }
    return verifyAll(ofType('signerKeyTypeEd25519SignedPayload'), (sig, s) => {
      const sp = s.key.ed25519SignedPayload();
      const hint = Buffer.from(hintOf(sp.ed25519()).map((b, i) => b ^ hintOf(sp.payload())[i]));
      return hint.equals(sig.hint()) && verifyEd25519(sp.ed25519(), sig.signature(), sp.payload());
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
  txHash: Buffer,
  neededWeight: number,
): boolean {
  return new SignatureChecker(signatures, txHash).checkSignature(accountSigners(account), neededWeight);
}

/** PRECOND_V2 extraSigners: every one must sign (TransactionFrame::checkExtraSigners). */
function checkExtraSigners(checker: SignatureChecker, raw: xdr.Transaction): boolean {
  const cond = raw.cond();
  if (cond.switch().name !== 'precondV2') return true;
  const extra = cond.v2().extraSigners();
  if (extra.length === 0) return true;
  return checker.checkSignature(
    extra.map((key) => ({ key, weight: 1 })),
    extra.length,
  );
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
  const first = raw.operations()[0];
  if (!first || !SOROBAN_OP_TYPES.has(first.body().switch().name)) return null;
  if (raw.ext().switch() !== 1) return 'a Soroban transaction must carry SorobanTransactionData';
  const resourceFee = BigInt(raw.ext().sorobanData().resourceFee().toString());
  if (resourceFee < 0n || resourceFee > MAX_RESOURCE_FEE) {
    return `resource fee ${resourceFee} outside [0, 2^50]`;
  }
  return null;
}

/**
 * Validate and apply a transaction envelope, exactly as an app would submit it.
 *
 * Fee handling note: stellar-core charges the full bid up front and refunds the
 * unused refundable resource fee after execution. Refunds are NOT modelled here;
 * the full `tx.fee` is debited, which is conservative.
 */
/**
 * Switches that turn OFF parts of classic validation, in the spirit of
 * LiteSVM's `withSigverify(false)`. A test about contract logic should not have
 * to satisfy the transaction envelope rules it is not testing.
 */
export interface ValidationOptions {
  /** Verify envelope signatures against account thresholds. Default true. */
  sigverify?: boolean;
  /** Enforce strict seqNum + 1. Default true. */
  sequenceCheck?: boolean;
  /** Debit fees from the source account. Default true. */
  feeCharging?: boolean;
  /** Enforce timebounds against the ledger clock. Default true. */
  timebounds?: boolean;
}

export function applyTransaction(
  ledger: Ledger,
  envelopeB64: string,
  passphrase: string = DEFAULT_PASSPHRASE,
  validation: ValidationOptions = {},
): TxOutcome {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeB64, 'base64');
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
  if (envelope.switch().name === 'envelopeTypeTxFeeBump') {
    return applyFeeBump(ledger, envelope, passphrase, validation);
  }
  if (envelope.switch().name !== 'envelopeTypeTx') {
    return malformed('only v1 and fee-bump envelopes are supported');
  }

  const tx = new Transaction(envelope, passphrase);
  const raw = envelope.v1().tx();
  const badFee = xdrProvidesValidFee(raw);
  if (badFee) return malformed(badFee);

  // -- fee source is the tx source for a plain v1 envelope
  const feeSourceId = muxedToAccountId(raw.sourceAccount());
  return applyInner(ledger, tx, raw, feeSourceId, passphrase, false, validation);
}

/**
 * getFee(header, baseFee, applying = false): the declared Soroban resource fee
 * plus baseFee * max(1, operations), where a fee bump counts innerOps + 1.
 * What a rejected envelope's result reports as feeCharged; a local protocol-29
 * node reports exactly this for txBAD_AUTH, txBAD_AUTH_EXTRA and txFAILED.
 */
function nominalFee(envelope: xdr.TransactionEnvelope): bigint | undefined {
  const isBump = envelope.switch().name === 'envelopeTypeTxFeeBump';
  if (!isBump && envelope.switch().name !== 'envelopeTypeTx') return undefined;
  const raw = isBump ? envelope.feeBump().tx().innerTx().v1().tx() : envelope.v1().tx();
  const resourceFee =
    raw.ext().switch() === 1 ? BigInt(raw.ext().sorobanData().resourceFee().toString()) : 0n;
  const ops = raw.operations().length + (isBump ? 1 : 0);
  return resourceFee + BigInt(BASE_FEE) * BigInt(Math.max(1, ops));
}

function applyFeeBump(
  ledger: Ledger,
  envelope: xdr.TransactionEnvelope,
  passphrase: string,
  validation: ValidationOptions,
): TxOutcome {
  const fb = envelope.feeBump();
  const feeBumpTx = new FeeBumpTransaction(envelope, passphrase);
  const innerEnvelope = xdr.TransactionEnvelope.envelopeTypeTx(fb.tx().innerTx().v1());
  const innerTx = new Transaction(innerEnvelope, passphrase);
  const innerRaw = innerEnvelope.v1().tx();

  // FeeBumpTransactionFrame::checkValidImpl, in its order (stellar-core v29.0.0).
  // XDRProvidesValidFee covers the inner transaction too, so a malformed inner
  // fee is the OUTER envelope's txMALFORMED, not an inner failure.
  const totalFee = BigInt(fb.tx().fee().toString());
  if (totalFee < 0n) return malformed('negative fee bump fee');
  const badInnerFee = xdrProvidesValidFee(innerRaw);
  if (badInnerFee) return malformed(`inner transaction: ${badInnerFee}`);

  // commonValidPreSeqNum. Inclusion fee = full fee minus the inner Soroban
  // resource fee; a fee bump counts as innerOps + 1 operations, and
  // getMinInclusionFee is baseFee * max(1, operations).
  const innerSoroban = innerRaw.ext().switch() === 1 ? innerRaw.ext().sorobanData() : null;
  const resourceFee = innerSoroban ? BigInt(innerSoroban.resourceFee().toString()) : 0n;
  const innerOps = BigInt(innerRaw.operations().length);
  const minInclusion = (ops: bigint) => BigInt(BASE_FEE) * (ops > 1n ? ops : 1n);
  const inclusionFee = totalFee - resourceFee;
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
  const innerInclusion = BigInt(innerRaw.fee().toString()) - resourceFee;
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
  const feeSourceId = muxedToAccountId(fb.tx().feeSource());
  const feeAccount = loadAccount(ledger, feeSourceId);
  if (!feeAccount) return fail('txNO_ACCOUNT', 'fee source account does not exist');

  // commonValid: the fee source signs at LOW (a fee bump has no operations of
  // its own), with the OUTER signatures and their own checker.
  const checker =
    validation.sigverify !== false ? new SignatureChecker(feeBumpTx.signatures, feeBumpTx.hash()) : null;
  if (checker && !checker.checkSignature(accountSigners(feeAccount), feeAccount.thresholds()[1])) {
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
  const inner = applyInner(ledger, innerTx, innerRaw, feeSourceId, passphrase, true, validation);
  if (inner.rejected) {
    return {
      ...inner,
      code: 'txFEE_BUMP_INNER_FAILED',
      innerCode: inner.code,
      feeCharged: 0n,
    };
  }

  if (charging) debit(ledger, feeSourceId, totalFee);

  return {
    ...inner,
    code: inner.ok ? 'txFEE_BUMP_INNER_SUCCESS' : 'txFEE_BUMP_INNER_FAILED',
    innerCode: inner.code,
    feeCharged: charging ? totalFee : 0n,
  };
}

function applyInner(
  ledger: Ledger,
  tx: Transaction,
  raw: xdr.Transaction,
  feeSourceId: xdr.AccountId,
  passphrase: string,
  feeBumped: boolean,
  validation: ValidationOptions,
): TxOutcome {
  const ops = raw.operations();

  // -- envelope shape (TransactionFrame.cpp:1325, :760) --------------------
  if (ops.length === 0) return fail('txMISSING_OPERATION');

  const opType = ops[0].body().switch().name;
  const sorobanOps = ops.filter((o) => SOROBAN_OP_TYPES.has(o.body().switch().name));
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
    const memoIsNone = raw.memo().switch().name === 'memoNone';
    const opSource = ops[0].sourceAccount();
    if (!memoIsNone || isMuxed(raw.sourceAccount()) || (opSource && isMuxed(opSource))) {
      return fail(
        'txSOROBAN_INVALID',
        'Soroban transactions are not allowed to use memo or muxed source account',
      );
    }
  }

  // -- source account ------------------------------------------------------
  const sourceId = muxedToAccountId(raw.sourceAccount());
  const account = loadAccount(ledger, sourceId);
  if (!account) return fail('txNO_ACCOUNT', 'source account does not exist');

  // stellar-core hands the OPERATION source to the host as the Soroban invoker
  // (InvokeHostFunctionOpFrame.cpp passes mOpFrame.getSourceID()), falling back
  // to the transaction source only when the operation names none.
  // A missing operation source is not a submit-time error: core checks a
  // signature from that key instead (checkSignatureNoAccount) and fails the
  // operation with opNO_ACCOUNT when it applies.
  const opSourceMuxed = ops[0].sourceAccount();
  const invokerId = opSourceMuxed ? muxedToAccountId(opSourceMuxed) : sourceId;
  const opAccount = opSourceMuxed ? loadAccount(ledger, invokerId) : account;

  // -- sequence number -----------------------------------------------------
  const currentSeq = BigInt(account.seqNum().toString());
  const txSeq = BigInt(raw.seqNum().toString());
  // Core's first isBadSeq clause is unconditional: a transaction may never use
  // getStartingSequenceNumber(currentLedger), because CreateAccount hands that
  // very number to accounts created in this ledger.
  if (txSeq === (BigInt(ledger.ledgerSeq) << 32n)) {
    return fail('txBAD_SEQ', 'sequence equals getStartingSequenceNumber(currentLedger)');
  }
  if (validation.sequenceCheck !== false && txSeq !== currentSeq + 1n) {
    return fail('txBAD_SEQ', `expected sequence ${currentSeq + 1n}, got ${txSeq}`);
  }

  // -- timebounds ----------------------------------------------------------
  const cond = raw.cond();
  if (validation.timebounds !== false && cond.switch().name === 'precondTime') {
    const tb = cond.timeBounds();
    const now = BigInt(ledger.timestamp);
    const min = BigInt(tb.minTime().toString());
    const max = BigInt(tb.maxTime().toString());
    if (min !== 0n && now < min) return fail('txTOO_EARLY');
    if (max !== 0n && now > max) return fail('txTOO_LATE');
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
    if (!checker.checkSignature(accountSigners(account), account.thresholds()[1])) {
      return fail(
        'txBAD_AUTH',
        `transaction source signatures do not satisfy low threshold ${account.thresholds()[1]} for ${
          StrKey.encodeEd25519PublicKey(account.accountId().ed25519())
        }`,
      );
    }
    if (!checkExtraSigners(checker, raw)) {
      return fail('txBAD_AUTH', 'not every PRECOND_V2 extraSigner signed');
    }
  }

  // -- fees ----------------------------------------------------------------
  const totalFee = BigInt(raw.fee().toString());
  const sorobanData = raw.ext().switch() === 1 ? raw.ext().sorobanData() : null;
  if (!sorobanData) return fail('txSOROBAN_INVALID', 'missing SorobanTransactionData');
  const resourceFee = BigInt(sorobanData.resourceFee().toString());
  const inclusionFee = totalFee - resourceFee;

  // From protocol 23 a fee-bumped inner tx may carry an insufficient full fee
  // (TransactionFrame.cpp:1368).
  if (!feeBumped && inclusionFee < BigInt(BASE_FEE)) {
    return fail('txINSUFFICIENT_FEE', `inclusion fee ${inclusionFee} below ${BASE_FEE}`);
  }

  const payer = feeBumped || validation.feeCharging === false ? null : sourceId;
  if (payer) {
    const payerAccount = loadAccount(ledger, payer)!;
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
      ? checker.checkSignature(accountSigners(opAccount), opAccount.thresholds()[level])
      : checker.checkSignature(
          [{ key: xdr.SignerKey.signerKeyTypeEd25519(invokerId.ed25519()), weight: 1 }],
          0,
        );
    if (!opSigned) {
      return {
        ...fail(
          'txFAILED',
          `operation source signatures do not satisfy its ${level === 2 ? 'medium' : 'low'} threshold for ${
            StrKey.encodeEd25519PublicKey(invokerId.ed25519())
          } (opBAD_AUTH)`,
        ),
        opCode: 'opBAD_AUTH',
      };
    }
    if (!checker.checkAllSignaturesUsed()) {
      return fail('txBAD_AUTH_EXTRA', 'the envelope carries a signature no check consumed');
    }
  }

  // -- commit the classic side, then run the host --------------------------
  if (validation.sequenceCheck !== false) bumpSequence(ledger, sourceId, txSeq);
  else bumpSequence(ledger, sourceId, currentSeq + 1n);

  if (payer) debit(ledger, payer, totalFee);

  if (!opAccount) {
    return {
      code: 'txFAILED',
      ok: false,
      opCode: 'opNO_ACCOUNT',
      feeCharged: feeBumped ? 0n : totalFee,
      detail: 'operation source account does not exist (opNO_ACCOUNT)',
    };
  }

  if (opType !== 'invokeHostFunction') {
    // ExtendFootprintTTL / RestoreFootprint are validated above but not
    // dispatched: the host entry points for them are not wired up in this spike.
    return {
      code: 'txFAILED',
      ok: false,
      feeCharged: feeBumped ? 0n : totalFee,
      detail: `${opType} is not dispatched by this harness yet`,
    };
  }

  const hostFn = ops[0].body().invokeHostFunctionOp().hostFunction();
  const auth = ops[0].body().invokeHostFunctionOp().auth();
  const resources = sorobanData.resources();

  const sent = ledger.send(
    hostFn,
    invokerId.toXDR('base64'),
    resources.toXDR('base64'),
    auth.map((a) => a.toXDR('base64')),
    [],
  );

  return {
    code: sent.ok ? 'txSUCCESS' : 'txFAILED',
    ok: sent.ok,
    returnValueXdr: sent.returnValueXdr,
    eventsXdr: sent.eventsXdr,
    changedKeys: sent.changedKeys,
    removedKeys: sent.removedKeys,
    feeCharged: feeBumped ? 0n : totalFee,
    error: sent.error,
  };
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
  account.seqNum(new xdr.SequenceNumber(new xdr.Int64(to)));
  const v3 = prepareAccountEntryExtensionV3(account);
  v3.seqLedger(ledger.ledgerSeq);
  v3.seqTime(new xdr.TimePoint(xdr.Uint64.fromString(String(ledger.timestamp))));
  storeAccount(ledger, account);
}

/** Core's prepareAccountEntryExtensionV1/V2/V3: create what is missing, zeroed. */
function prepareAccountEntryExtensionV3(account: xdr.AccountEntry): xdr.AccountEntryExtensionV3 {
  if (account.ext().switch() === 0) {
    account.ext(
      new xdr.AccountEntryExt(
        1,
        new xdr.AccountEntryExtensionV1({
          liabilities: new xdr.Liabilities({ buying: new xdr.Int64(0n), selling: new xdr.Int64(0n) }),
          ext: new xdr.AccountEntryExtensionV1Ext(0),
        }),
      ),
    );
  }
  const v1 = account.ext().v1();
  if (v1.ext().switch() === 0) {
    v1.ext(
      new xdr.AccountEntryExtensionV1Ext(
        2,
        new xdr.AccountEntryExtensionV2({
          numSponsored: 0,
          numSponsoring: 0,
          signerSponsoringIDs: account.signers().map(() => null),
          ext: new xdr.AccountEntryExtensionV2Ext(0),
        }),
      ),
    );
  }
  const v2 = v1.ext().v2();
  if (v2.ext().switch() === 0) {
    v2.ext(
      new xdr.AccountEntryExtensionV2Ext(
        3,
        new xdr.AccountEntryExtensionV3({
          ext: new xdr.ExtensionPoint(0),
          seqLedger: 0,
          seqTime: new xdr.TimePoint(xdr.Uint64.fromString('0')),
        }),
      ),
    );
  }
  return v2.ext().v3();
}

function debit(ledger: Ledger, id: xdr.AccountId, amount: bigint): void {
  const account = loadAccount(ledger, id)!;
  const balance = BigInt(account.balance().toString());
  account.balance(new xdr.Int64(balance - amount));
  storeAccount(ledger, account);
}
