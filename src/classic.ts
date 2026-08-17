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
  feeCharged: bigint;
  /** Populated for fee bumps. */
  innerCode?: TxResultCode;
  error?: string;
  /** Diagnostic text, mirroring core's diagnostic events. */
  detail?: string;
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

/**
 * Faithful port of stellar-core's SignatureChecker::checkSignature.
 *
 * The subtlety that matters: every `return true` in core sits INSIDE the loop
 * over the transaction's signatures. An unsigned transaction therefore falls
 * through to `return false` EVEN WHEN the needed weight is 0 — a threshold of 0
 * means "any one valid signer suffices", not "no signature required".
 * Core's own test TxEnvelopeTests.cpp SECTION("no signature") pins this.
 */
export function checkSignature(
  account: xdr.AccountEntry,
  signatures: xdr.DecoratedSignature[],
  txHash: Buffer,
  neededWeight: number,
): boolean {
  const candidates: { pk: string; weight: number }[] = [
    {
      pk: StrKey.encodeEd25519PublicKey(account.accountId().ed25519()),
      weight: account.thresholds()[0],
    },
  ];
  for (const s of account.signers()) {
    if (s.key().switch().name !== 'signerKeyTypeEd25519') continue;
    candidates.push({ pk: StrKey.encodeEd25519PublicKey(s.key().ed25519()), weight: s.weight() });
  }

  let total = 0;
  const used = new Set<string>();
  for (const sig of signatures) {
    for (const c of candidates) {
      if (used.has(c.pk)) continue;
      const kp = Keypair.fromPublicKey(c.pk);
      if (!kp.signatureHint().equals(sig.hint())) continue;
      if (kp.verify(txHash, sig.signature())) {
        used.add(c.pk);
        total += c.weight;
        if (total >= neededWeight) return true;
        break;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// the apply path
// ---------------------------------------------------------------------------

function fail(code: TxResultCode, detail?: string, feeCharged = 0n): TxOutcome {
  return { code, ok: false, feeCharged, detail };
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

  if (envelope.switch().name === 'envelopeTypeTxFeeBump') {
    return applyFeeBump(ledger, envelope, passphrase, validation);
  }
  if (envelope.switch().name !== 'envelopeTypeTx') {
    return fail('txMALFORMED', 'only v1 and fee-bump envelopes are supported');
  }

  const tx = new Transaction(envelope, passphrase);
  const raw = envelope.v1().tx();

  // -- fee source is the tx source for a plain v1 envelope
  const feeSourceId = muxedToAccountId(raw.sourceAccount());
  return applyInner(ledger, tx, raw, feeSourceId, passphrase, false, validation);
}

function applyFeeBump(
  ledger: Ledger,
  envelope: xdr.TransactionEnvelope,
  passphrase: string,
  validation: ValidationOptions,
): TxOutcome {
  const fb = envelope.feeBump();
  const feeBumpTx = new FeeBumpTransaction(envelope, passphrase);

  const feeSourceMuxed = fb.tx().feeSource();
  // A fee bump's fee source MAY be muxed: validateSorobanMemo (TransactionFrame
  // .cpp:363) checks the tx source and the op source, never the fee source.
  const feeSourceId = muxedToAccountId(feeSourceMuxed);

  const feeAccount = loadAccount(ledger, feeSourceId);
  if (!feeAccount) return fail('txNO_ACCOUNT', 'fee source account does not exist');

  if (validation.sigverify !== false) {
    // thresholds[1] is LOW. A fee bump has no operations, so MEDIUM never applies.
    if (!checkSignature(feeAccount, feeBumpTx.signatures, feeBumpTx.hash(), feeAccount.thresholds()[1])) {
      return fail('txBAD_AUTH', 'fee bump signatures do not satisfy the fee source low threshold');
    }
  }

  const totalFee = BigInt(fb.tx().fee().toString());
  if (availableBalance(feeAccount) < totalFee) {
    return fail('txINSUFFICIENT_BALANCE', 'fee source cannot cover the fee bump');
  }

  const innerEnvelope = xdr.TransactionEnvelope.envelopeTypeTx(fb.tx().innerTx().v1());
  const innerTx = new Transaction(innerEnvelope, passphrase);
  const innerRaw = innerEnvelope.v1().tx();

  const inner = applyInner(ledger, innerTx, innerRaw, feeSourceId, passphrase, true, validation);

  // Charge the fee bump's fee to the fee source regardless of inner outcome.
  debit(ledger, feeSourceId, totalFee);

  return {
    ...inner,
    code: inner.ok ? 'txFEE_BUMP_INNER_SUCCESS' : 'txFEE_BUMP_INNER_FAILED',
    innerCode: inner.code,
    feeCharged: totalFee,
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
  const opSourceMuxed = ops[0].sourceAccount();
  const invokerId = opSourceMuxed ? muxedToAccountId(opSourceMuxed) : sourceId;
  const opAccount = opSourceMuxed ? loadAccount(ledger, invokerId) : account;
  if (!opAccount) return fail('txNO_ACCOUNT', 'operation source account does not exist');

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

  // -- signatures ----------------------------------------------------------
  if (validation.sigverify !== false) {
    if (!checkSignature(opAccount, tx.signatures, tx.hash(), opAccount.thresholds()[2])) {
      return fail(
        'txBAD_AUTH',
        `signatures do not satisfy medium threshold ${opAccount.thresholds()[2]} for ${
          StrKey.encodeEd25519PublicKey(opAccount.accountId().ed25519())
        }`,
      );
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

  // -- commit the classic side, then run the host --------------------------
  if (validation.sequenceCheck !== false) bumpSequence(ledger, sourceId, txSeq);
  else bumpSequence(ledger, sourceId, currentSeq + 1n);
  if (payer) debit(ledger, payer, totalFee);

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

function bumpSequence(ledger: Ledger, id: xdr.AccountId, to: bigint): void {
  const account = loadAccount(ledger, id)!;
  account.seqNum(new xdr.SequenceNumber(new xdr.Int64(to)));
  storeAccount(ledger, account);
}

function debit(ledger: Ledger, id: xdr.AccountId, amount: bigint): void {
  const account = loadAccount(ledger, id)!;
  const balance = BigInt(account.balance().toString());
  account.balance(new xdr.Int64(balance - amount));
  storeAccount(ledger, account);
}
