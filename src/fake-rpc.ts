/**
 * THROWAWAY SPIKE — a `rpc.Server` whose JSON-RPC is served by the in-process
 * host instead of the network.
 *
 * The seam is `server.httpClient.defaults.adapter`, a public typed field the
 * SDK honours at fetch-client.js:312 (`finalConfig.adapter || this.defaults.adapter`).
 * Nothing about the app's construction of `rpc.Server` has to change beyond the
 * URL, and no socket is ever opened.
 *
 * Deliberately partial: enough methods to carry the simulate path. A real
 * harness would cover the full 12-method surface plus sendTransaction/poll.
 */
import {
  xdr,
  rpc,
  Address,
  StrKey,
  TransactionBuilder,
  FeeBumpTransaction,
  hash as sha256,
} from '@stellar/stellar-sdk';
import { HOST_PROTOCOL, type Ledger } from './index.js';
import type { TxOutcome, TxResultCode } from './classic.js';

/** A stand-in friendbot endpoint; the adapter answers it without a socket. */
export const FRIENDBOT_URL = 'https://in-process.invalid/friendbot';

export interface AdapterStats {
  calls: { method: string }[];
  networkAttempts: number;
}

/** Our result codes -> the XDR union arm names (all confirmed present in v16.2.0). */
const CODE_ARM: Record<TxResultCode, string> = {
  txSUCCESS: 'txSuccess',
  txFAILED: 'txFailed',
  txNO_ACCOUNT: 'txNoAccount',
  txBAD_SEQ: 'txBadSeq',
  txBAD_AUTH: 'txBadAuth',
  txBAD_AUTH_EXTRA: 'txBadAuthExtra',
  txTOO_EARLY: 'txTooEarly',
  txTOO_LATE: 'txTooLate',
  txBAD_MIN_SEQ_AGE_OR_GAP: 'txBadMinSeqAgeOrGap',
  txMISSING_OPERATION: 'txMissingOperation',
  txMALFORMED: 'txMalformed',
  txSOROBAN_INVALID: 'txSorobanInvalid',
  txINSUFFICIENT_FEE: 'txInsufficientFee',
  txINSUFFICIENT_BALANCE: 'txInsufficientBalance',
  txFEE_BUMP_INNER_SUCCESS: 'txFeeBumpInnerSuccess',
  txFEE_BUMP_INNER_FAILED: 'txFeeBumpInnerFailed',
};

/** Codes stellar-rpc reports synchronously from sendTransaction as ERROR. */
const REJECTED_AT_SUBMIT = new Set<TxResultCode>([
  'txNO_ACCOUNT',
  'txBAD_SEQ',
  'txBAD_AUTH',
  'txBAD_AUTH_EXTRA',
  'txTOO_EARLY',
  'txTOO_LATE',
  'txBAD_MIN_SEQ_AGE_OR_GAP',
  'txMISSING_OPERATION',
  'txMALFORMED',
  'txSOROBAN_INVALID',
  'txINSUFFICIENT_FEE',
  'txINSUFFICIENT_BALANCE',
]);

function operationResults(outcome: TxOutcome): xdr.OperationResult[] {
  // Decided by the classic layer before the host ran: a bare op result code.
  if (outcome.opCode === 'opBAD_AUTH') return [xdr.OperationResult.opBadAuth()];
  if (outcome.opCode === 'opNO_ACCOUNT') return [xdr.OperationResult.opNoAccount()];
  if (outcome.footprintOpResult) {
    const extend = outcome.footprintOpResult.startsWith('extend');
    const R: any = extend ? xdr.ExtendFootprintTtlResult : xdr.RestoreFootprintResult;
    const tr: any = xdr.OperationResultTr;
    return [
      xdr.OperationResult.opInner(
        tr[extend ? 'extendFootprintTtl' : 'restoreFootprint'](R[outcome.footprintOpResult]()),
      ),
    ];
  }
  const returned = outcome.returnValueXdr
    ? sha256(Buffer.from(outcome.returnValueXdr, 'base64'))
    : Buffer.alloc(32);
  const inner = outcome.ok
    ? xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(returned)
    : (xdr.InvokeHostFunctionResult as any)[outcome.invokeResult ?? 'invokeHostFunctionTrapped']();
  return [xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(inner))];
}

/** `innerHash`: for a fee bump, the InnerTransactionResultPair names the INNER tx. */
function transactionResult(outcome: TxOutcome, innerHash: Buffer): xdr.TransactionResult {
  const arm = CODE_ARM[outcome.code];
  const R: any = xdr.TransactionResultResult;

  let result: xdr.TransactionResultResult;
  if (arm === 'txSuccess' || arm === 'txFailed') {
    result = R[arm](operationResults(outcome));
  } else if (arm === 'txFeeBumpInnerSuccess' || arm === 'txFeeBumpInnerFailed') {
    const innerCode = outcome.innerCode ?? (outcome.ok ? 'txSUCCESS' : 'txFAILED');
    const innerArm = CODE_ARM[innerCode];
    const IR: any = xdr.InnerTransactionResultResult;
    const innerResult =
      innerArm === 'txSuccess' || innerArm === 'txFailed'
        ? IR[innerArm](operationResults(outcome))
        : IR[innerArm]();
    result = R[arm](
      new xdr.InnerTransactionResultPair({
        transactionHash: innerHash,
        result: new xdr.InnerTransactionResult({
          feeCharged: new xdr.Int64(0n),
          result: innerResult,
          ext: new xdr.InnerTransactionResultExt(0),
        }),
      }),
    );
  } else {
    result = R[arm]();
  }

  return new xdr.TransactionResult({
    feeCharged: new xdr.Int64(outcome.feeCharged),
    result,
    ext: new xdr.TransactionResultExt(0),
  });
}

/** TransactionMetaV4 carrying the return value, which is what the SDK reads. */
function transactionMeta(outcome: TxOutcome): xdr.TransactionMeta {
  const returnValue = outcome.returnValueXdr
    ? xdr.ScVal.fromXDR(outcome.returnValueXdr, 'base64')
    : xdr.ScVal.scvVoid();
  // Core's fee breakdown (TransactionMetaBuilder::setNonRefundableResourceFee
  // and maybeSetRefundableFeeMeta), which is where an app reads what the
  // resources and the rent cost.
  const fee = outcome.sorobanFee;
  const sorobanMeta = new xdr.SorobanTransactionMetaV2({
    ext: fee
      ? new xdr.SorobanTransactionMetaExt(
          1,
          new xdr.SorobanTransactionMetaExtV1({
            ext: new xdr.ExtensionPoint(0),
            totalNonRefundableResourceFeeCharged: new xdr.Int64(fee.nonRefundable),
            totalRefundableResourceFeeCharged: new xdr.Int64(fee.refundable),
            rentFeeCharged: new xdr.Int64(fee.rent),
          }),
        )
      : new xdr.SorobanTransactionMetaExt(0),
    returnValue,
  });
  return new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta,
      events: [],
      diagnosticEvents: [],
    }),
  );
}

/**
 * The SDK's parseRawLatestLedger unconditionally decodes headerXdr and
 * metadataXdr, so getLatestLedger is unusable without them even though nothing
 * downstream reads their contents. These are structurally valid placeholders.
 */
function ledgerHeaderXdr(seq: number, closeTime: number): string {
  const zero32 = Buffer.alloc(32);
  return new xdr.LedgerHeader({
    ledgerVersion: HOST_PROTOCOL,
    previousLedgerHash: zero32,
    scpValue: new xdr.StellarValue({
      txSetHash: zero32,
      closeTime: new xdr.TimePoint(xdr.Uint64.fromString(String(closeTime))),
      upgrades: [],
      ext: new xdr.StellarValueExt(xdr.StellarValueType.stellarValueBasic()),
    }),
    txSetResultHash: zero32,
    bucketListHash: zero32,
    ledgerSeq: seq,
    totalCoins: new xdr.Int64(0n),
    feePool: new xdr.Int64(0n),
    inflationSeq: 0,
    idPool: new xdr.Uint64(0n),
    baseFee: 100,
    baseReserve: 5_000_000,
    maxTxSetSize: 1000,
    skipList: [zero32, zero32, zero32, zero32],
    ext: new xdr.LedgerHeaderExt(0),
  }).toXDR('base64');
}

function ledgerCloseMetaXdr(seq: number, closeTime: number): string {
  return new xdr.LedgerCloseMeta(
    0,
    new xdr.LedgerCloseMetaV0({
      ledgerHeader: new xdr.LedgerHeaderHistoryEntry({
        hash: Buffer.alloc(32),
        header: xdr.LedgerHeader.fromXDR(ledgerHeaderXdr(seq, closeTime), 'base64'),
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      }),
      txSet: new xdr.TransactionSet({ previousLedgerHash: Buffer.alloc(32), txes: [] }),
      txProcessing: [],
      upgradesProcessing: [],
      scpInfo: [],
    }),
  ).toXDR('base64');
}

function rawTransaction(tx: SubmittedTx, latestLedger: number) {
  const succeeded =
    tx.outcome.code === 'txSUCCESS' || tx.outcome.code === 'txFEE_BUMP_INNER_SUCCESS';
  return {
    status: succeeded ? 'SUCCESS' : 'FAILED',
    txHash: tx.hash,
    applicationOrder: 1,
    feeBump: tx.feeBump,
    envelopeXdr: tx.envelopeB64,
    resultXdr: tx.resultXdr,
    resultMetaXdr: tx.resultMetaXdr,
    ledger: tx.ledger,
    createdAt: String(tx.createdAt),
    events: { contractEventsXdr: [tx.outcome.eventsXdr ?? []] },
  };
}

/**
 * getLedgers wants a LedgerHeaderHistoryEntry where getLatestLedger wants a bare
 * LedgerHeader. That inconsistency is in the RPC API itself, not here.
 */
function ledgerHeaderHistoryEntryXdr(seq: number, closeTime: number): string {
  return new xdr.LedgerHeaderHistoryEntry({
    hash: Buffer.alloc(32),
    header: xdr.LedgerHeader.fromXDR(ledgerHeaderXdr(seq, closeTime), 'base64'),
    ext: new xdr.LedgerHeaderHistoryEntryExt(0),
  }).toXDR('base64');
}

/** One buffered contract event, in the shape getEvents returns. */
interface BufferedEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  inSuccessfulContractCall: boolean;
  topic: string[];
  value: string;
  txHash: string;
  opIndex: number;
  txIndex: number;
}

interface SubmittedTx {
  hash: string;
  outcome: TxOutcome;
  envelopeB64: string;
  resultXdr: string;
  resultMetaXdr: string;
  ledger: number;
  createdAt: number;
  feeBump: boolean;
}

function accountLedgerKey(accountId: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Address.fromString(accountId).toScAddress().accountId() }),
  );
}

export interface InProcessRpcOptions {
  /**
   * How a submitted envelope is applied. Defaults to `ledger.sendTransaction`:
   * full classic validation, every check on. `LiteStellar.rpcServer()` passes
   * its own `sendTransaction` so the `withSigverify` / `withSequenceCheck` /
   * `withFeeCharging` / `withTimebounds` switches reach this path too.
   */
  submit?: (envelopeB64: string) => TxOutcome;
}

/** The error axios rejects with for a non-2xx response; the SDK reads `.response`. */
function httpError(config: unknown, status: number, statusText: string, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    config,
    response: { status, statusText, data, headers: {}, config },
  });
}

/**
 * Install an in-process JSON-RPC adapter on an existing `rpc.Server`.
 * Returns stats so a test can assert which methods were exercised.
 */
export function attachInProcessRpc(
  server: rpc.Server,
  ledger: Ledger,
  opts: InProcessRpcOptions = {},
): AdapterStats {
  const submit = opts.submit ?? ((envelopeB64: string) => ledger.sendTransaction(envelopeB64));
  const stats: AdapterStats = { calls: [], networkAttempts: 0 };
  const submitted = new Map<string, SubmittedTx>();
  const eventLog: BufferedEvent[] = [];
  // `ledger.ledgerSeq` is the open ledger: the one a submission is validated
  // against and applied in, which stellar-core's TransactionQueue takes as LCL
  // + 1. A node reports the last closed ledger, one before it, as latest
  // (stellar-rpc get_latest_ledger.go, send_transaction.go `LastLedger`), and
  // preflights in it (simulate_transaction.go `LedgerSeq: latestLedger`). Its
  // close time is the timestamp the open ledger validates and applies at.
  const lastClosed = () => ledger.ledgerSeq - 1;

  (server as any).httpClient.defaults.adapter = async (config: any) => {
    // requestAirdrop posts to the friendbot URL, which is NOT JSON-RPC. Handle
    // it before assuming a JSON-RPC body, or the destructure below dies
    // unhelpfully on any non-JSON-RPC request.
    if (typeof config.url === 'string' && config.url.startsWith(FRIENDBOT_URL)) {
      stats.calls.push({ method: 'friendbot' });
      const addr = new URL(config.url).searchParams.get('addr');
      if (!addr) throw new Error('friendbot: missing addr');
      const accountKey = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({
          accountId: xdr.AccountId.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(addr)),
        }),
      ).toXDR('base64');

      // Friendbot creates NEW accounts and refuses an existing one. Observed
      // live: HTTP 400, "account already funded to starting balance". Funding
      // it anyway would rebuild its AccountEntry: sequence back to 0, signers
      // and thresholds gone, every envelope it already spent replayable.
      if (ledger.getEntry(accountKey)) {
        throw httpError(config, 400, 'Bad Request', {
          type: 'https://stellar.org/friendbot-errors/bad_request',
          title: 'Bad Request',
          status: 400,
          detail: 'account already funded to starting balance',
        });
      }
      ledger.fund(addr, { balance: 10_000n * 10_000_000n });

      // The SDK reads the new account's sequence out of the meta
      // (findCreatedAccountSequenceInTransactionMeta), so the meta has to carry
      // a ledgerEntryCreated change for the AccountEntry — funding alone is not
      // enough to make requestAirdrop work.
      const created = xdr.LedgerEntry.fromXDR(ledger.getEntry(accountKey)!, 'base64');

      return {
        data: {
          hash: '0'.repeat(64),
          result_meta_xdr: new xdr.TransactionMeta(
            4,
            new xdr.TransactionMetaV4({
              ext: new xdr.ExtensionPoint(0),
              txChangesBefore: [],
              operations: [
                new xdr.OperationMetaV2({
                  ext: new xdr.ExtensionPoint(0),
                  changes: [xdr.LedgerEntryChange.ledgerEntryCreated(created)],
                  events: [],
                }),
              ],
              txChangesAfter: [],
              sorobanMeta: null,
              events: [],
              diagnosticEvents: [],
            }),
          ).toXDR('base64'),
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }

    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    const { id, method, params } = body;
    stats.calls.push({ method });

    const ok = (result: unknown) => ({
      data: { jsonrpc: '2.0', id, result },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    // stellar-rpc reports a JSON-RPC error with HTTP 200, like `ok`.
    const rpcError = (code: number, message: string, data?: string) => ({
      data: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });

    switch (method) {
      case 'getHealth':
        return ok({
          status: 'healthy',
          latestLedger: lastClosed(),
          oldestLedger: 1,
          ledgerRetentionWindow: lastClosed(),
        });

      case 'getNetwork':
        // MUST be the passphrase signatures are actually validated against; an
        // app that discovers it via getNetwork would otherwise sign over the
        // wrong network id and every signature would verify against nothing.
        return ok({
          passphrase: ledger.networkPassphrase,
          protocolVersion: String(ledger.protocolVersion),
          friendbotUrl: FRIENDBOT_URL,
        });

      case 'getLatestLedger':
        return ok({
          id: 'in-process',
          protocolVersion: ledger.protocolVersion,
          sequence: lastClosed(),
          headerXdr: ledgerHeaderXdr(lastClosed(), ledger.timestamp),
          metadataXdr: ledgerCloseMetaXdr(lastClosed(), ledger.timestamp),
        });

      case 'getVersionInfo':
        return ok({
          version: 'liteSoroban (in-process)',
          commitHash: '0'.repeat(40),
          buildTimestamp: '1970-01-01T00:00:00Z',
          captiveCoreVersion: `soroban-env-host in-process, protocol ${ledger.protocolVersion}`,
          protocolVersion: ledger.protocolVersion,
        });

      case 'getFeeStats':
        // No fee market in process: everything is the base fee.
        return ok({
          sorobanInclusionFee: {
            max: '100', min: '100', mode: '100', p10: '100', p20: '100', p30: '100',
            p40: '100', p50: '100', p60: '100', p70: '100', p80: '100', p90: '100',
            p95: '100', p99: '100', transactionCount: '0', ledgerCount: 1,
          },
          inclusionFee: {
            max: '100', min: '100', mode: '100', p10: '100', p20: '100', p30: '100',
            p40: '100', p50: '100', p60: '100', p70: '100', p80: '100', p90: '100',
            p95: '100', p99: '100', transactionCount: '0', ledgerCount: 1,
          },
          latestLedger: lastClosed(),
        });

      case 'getEvents': {
        // Everything applied through sendTransaction is buffered, so an app's
        // normal way of consuming Soroban events works unchanged.
        const startLedger: number = params?.startLedger ?? 0;
        const filters: any[] = params?.filters ?? [];
        const matches = eventLog.filter((e) => {
          if (e.ledger < startLedger) return false;
          if (filters.length === 0) return true;
          return filters.some((f) => {
            if (f.contractIds?.length && !f.contractIds.includes(e.contractId)) return false;
            if (f.type && f.type !== e.type) return false;
            return true;
          });
        });
        const limit: number | undefined = params?.pagination?.limit;
        const page = limit ? matches.slice(0, limit) : matches;
        return ok({
          events: page,
          latestLedger: lastClosed(),
          oldestLedger: 1,
          latestLedgerCloseTime: String(ledger.timestamp),
          oldestLedgerCloseTime: '0',
          cursor: page.length ? page[page.length - 1].pagingToken : '',
        });
      }

      case 'getTransactions': {
        const start: number = params?.startLedger ?? 0;
        const txs = [...submitted.values()]
          .filter((t) => t.ledger >= start)
          .map((t) => rawTransaction(t, lastClosed()));
        return ok({
          transactions: txs,
          latestLedger: lastClosed(),
          latestLedgerCloseTimestamp: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTimestamp: '0',
          cursor: String(lastClosed()),
        });
      }

      case 'getLedgers': {
        const latest = lastClosed();
        const start: number = params?.startLedger ?? latest;
        // Only closed ledgers exist. A start past the latest is refused, with
        // the code and message a local stellar-rpc 29.0.1 answers (go-stellar-sdk
        // protocols/rpc ValidatePagination); a page stops at the latest, and the
        // cursor is the last ledger returned (get_ledgers.go).
        if (start < 1 || start > latest) {
          return rpcError(
            -32600,
            `start ledger (${start}) must be between the oldest ledger: 1 and the latest ledger: ${latest} for this rpc instance`,
          );
        }
        const count = Math.min(params?.pagination?.limit ?? 1, 200, latest - start + 1);
        const ledgers = Array.from({ length: count }, (_, i) => ({
          hash: Buffer.alloc(32).toString('hex'),
          sequence: start + i,
          ledgerCloseTime: String(ledger.timestamp),
          headerXdr: ledgerHeaderHistoryEntryXdr(start + i, ledger.timestamp),
          metadataXdr: ledgerCloseMetaXdr(start + i, ledger.timestamp),
        }));
        return ok({
          ledgers,
          latestLedger: latest,
          latestLedgerCloseTime: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTime: '0',
          cursor: String(start + count - 1),
        });
      }

      case 'getLedgerEntries': {
        const keys: string[] = params.keys;
        const entries = keys
          .map((k) => {
            const entryXdr = ledger.getEntry(k);
            if (!entryXdr) return null;
            // The RPC wire format carries LedgerEntryData (the inner union),
            // NOT the full LedgerEntry -- see the SDK's parseRawLedgerEntries,
            // which does xdr.LedgerEntryData.fromXDR(rawEntry.xdr).
            const data = xdr.LedgerEntry.fromXDR(entryXdr, 'base64').data();
            return {
              key: k,
              xdr: data.toXDR('base64'),
              // Not tracked per entry; the latest ledger at least never
              // names one that has not closed.
              lastModifiedLedgerSeq: lastClosed(),
              liveUntilLedgerSeq: ledger.getEntryTtl(k),
            };
          })
          .filter(Boolean);
        return ok({ entries, latestLedger: lastClosed() });
      }

      case 'simulateTransaction': {
        const env = xdr.TransactionEnvelope.fromXDR(params.transaction, 'base64');
        const tx = env.v1().tx();
        const op = tx.operations()[0];

        // ExtendFootprintTTL / RestoreFootprint: soroban-simulation's
        // simulate_extend_ttl_op / simulate_restore_op over the transaction's
        // own footprint, read-only and read-write respectively (stellar-rpc
        // lib/preflight/src/shared.rs).
        const opName = op.body().switch().name;
        if (opName === 'extendFootprintTtl' || opName === 'restoreFootprint') {
          const fp = tx.ext().switch() === 1 ? tx.ext().sorobanData().resources().footprint() : null;
          const keys = (fp ? (opName === 'extendFootprintTtl' ? fp.readOnly() : fp.readWrite()) : []).map(
            (k) => k.toXDR('base64'),
          );
          const footprintSim =
            opName === 'extendFootprintTtl'
              ? ledger.simulateExtendTtl(keys, op.body().extendFootprintTtlOp().extendTo(), lastClosed())
              : ledger.simulateRestore(keys, lastClosed());
          if (!footprintSim.ok) return ok({ error: footprintSim.error, latestLedger: lastClosed() });
          const resources = xdr.SorobanResources.fromXDR(footprintSim.resourcesXdr!, 'base64');
          const fee = String(footprintSim.minResourceFee);
          const txData = new xdr.SorobanTransactionData({
            ext: new (xdr as any).SorobanTransactionDataExt(0),
            resources,
            resourceFee: (xdr as any).Int64.fromString(fee),
          });
          return ok({
            latestLedger: lastClosed(),
            minResourceFee: fee,
            transactionData: txData.toXDR('base64'),
          });
        }

        const hostFn = op.body().invokeHostFunctionOp().hostFunction();

        const muxed: any = tx.sourceAccount();
        const ed: Buffer = muxed.switch().name === 'keyTypeMuxedEd25519'
          ? muxed.med25519().ed25519()
          : muxed.ed25519();
        const sourceAccountId = xdr.AccountId.publicKeyTypeEd25519(ed);

        // The envelope's auth entries are the whole point of a re-simulation:
        // ignoring them means an INVALID signature simulates green, because
        // plain recording mode never runs __check_auth. Honour them when present.
        const suppliedAuth = op.body().invokeHostFunctionOp().auth();

        // resourceConfig.instructionLeeway (the SDK's `cpuInstructions`) raises
        // the +50_000 instruction padding to max(50_000, leeway). stellar-rpc
        // defaults it to 0 (go-stellar-sdk protocols/rpc) and decodes it as a
        // Go uint64; preflight then takes it with u32::try_from. Both failure
        // shapes below are what a local stellar-rpc 29.0.1 answers, verbatim.
        const rawLeeway = params.resourceConfig?.instructionLeeway ?? 0;
        const leeway = Number(rawLeeway);
        if (!Number.isInteger(leeway) || leeway < 0 || leeway > Number.MAX_SAFE_INTEGER) {
          return rpcError(
            -32602,
            'invalid parameters',
            `json: cannot unmarshal number ${rawLeeway} into Go struct field ` +
              'ResourceConfig.resourceConfig.instructionLeeway of type uint64',
          );
        }
        if (leeway > 0xffff_ffff) {
          return ok({ error: 'number too large to fit in target type', latestLedger: lastClosed() });
        }
        const sim =
          suppliedAuth.length > 0
            ? ledger.simulateWithAuth(
                hostFn,
                sourceAccountId.toXDR('base64'),
                suppliedAuth.map((a) => a.toXDR('base64')),
                leeway,
                lastClosed(),
              )
            : ledger.simulate(hostFn, sourceAccountId.toXDR('base64'), leeway, lastClosed());
        if (!sim.ok) {
          return ok({ error: sim.error, latestLedger: lastClosed() });
        }

        const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
        // soroban-simulation's own fee for these resources, priced with the
        // ledger's fee settings (see Ledger.setFeeSettings).
        const resourceFee = String(sim.minResourceFee);
        const txData = new xdr.SorobanTransactionData({
          ext: new (xdr as any).SorobanTransactionDataExt(0),
          resources,
          resourceFee: (xdr as any).Int64.fromString(resourceFee),
        });

        return ok({
          latestLedger: lastClosed(),
          minResourceFee: resourceFee,
          transactionData: txData.toXDR('base64'),
          // The RPC contract for this field is DiagnosticEvent, not
          // ContractEvent — the SDK does DiagnosticEvent.fromXDR here, and a
          // raw ContractEvent makes it die with "Bad union switch: 1".
          events: sim.eventsXdr.map((e: string) =>
            new xdr.DiagnosticEvent({
              inSuccessfulContractCall: true,
              event: xdr.ContractEvent.fromXDR(e, 'base64'),
            }).toXDR('base64'),
          ),
          results: [
            {
              xdr: sim.returnValueXdr,
              auth: suppliedAuth.length > 0
                ? suppliedAuth.map((a) => a.toXDR('base64'))
                : sim.authXdr,
            },
          ],
          cost: { cpuInsns: String(sim.cpuInsns), memBytes: String(sim.memBytes) },
          stateChanges: [],
        });
      }

      case 'sendTransaction': {
        const envelopeB64: string = params.transaction;
        const tx = TransactionBuilder.fromXDR(envelopeB64, ledger.networkPassphrase);
        const txHash = tx.hash();
        const hashHex = txHash.toString('hex');

        // The response names the ledger that was latest when the envelope
        // arrived (send_transaction.go reads LastLedger before submitting).
        const latestAtSubmit = {
          latestLedger: lastClosed(),
          latestLedgerCloseTime: String(ledger.timestamp),
        };
        const outcome = submit(envelopeB64);
        const innerHash = tx instanceof FeeBumpTransaction ? tx.innerTransaction.hash() : txHash;
        const resultXdr = transactionResult(outcome, innerHash).toXDR('base64');

        // Classic validation failures come back synchronously as ERROR, exactly
        // as stellar-rpc does -- this is what an app's retry logic keys on. That
        // includes a txFAILED whose operation failed its signature check.
        if (outcome.rejected || REJECTED_AT_SUBMIT.has(outcome.code)) {
          return ok({
            status: 'ERROR',
            hash: hashHex,
            ...latestAtSubmit,
            errorResultXdr: resultXdr,
          });
        }

        // Anything that actually executed is PENDING here and resolved by
        // getTransaction, so the app's submit-then-poll loop runs for real.
        for (const [i, evtB64] of (outcome.eventsXdr ?? []).entries()) {
          const evt = xdr.ContractEvent.fromXDR(evtB64, 'base64');
          const cid = evt.contractId();
          eventLog.push({
            type: 'contract',
            ledger: ledger.ledgerSeq,
            ledgerClosedAt: new Date(ledger.timestamp * 1000).toISOString(),
            contractId: cid ? Address.contract(cid).toString() : '',
            id: `${ledger.ledgerSeq}-${eventLog.length}`,
            pagingToken: `${ledger.ledgerSeq}-${eventLog.length}`,
            inSuccessfulContractCall: true,
            topic: evt.body().v0().topics().map((t) => t.toXDR('base64')),
            value: evt.body().v0().data().toXDR('base64'),
            txHash: hashHex,
            opIndex: 0,
            txIndex: i,
          });
        }

        submitted.set(hashHex, {
          hash: hashHex,
          outcome,
          envelopeB64,
          resultXdr,
          resultMetaXdr: transactionMeta(outcome).toXDR('base64'),
          ledger: ledger.ledgerSeq,
          createdAt: ledger.timestamp,
          feeBump: outcome.code.startsWith('txFEE_BUMP'),
        });
        // The ledger it applied in closes: getLatestLedger now reports it.
        ledger.advanceLedgers(1);

        return ok({
          status: 'PENDING',
          hash: hashHex,
          ...latestAtSubmit,
        });
      }

      case 'getTransaction': {
        const tx = submitted.get(params.hash);
        const base = {
          latestLedger: lastClosed(),
          latestLedgerCloseTime: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTime: '0',
        };
        if (!tx) return ok({ ...base, status: 'NOT_FOUND' });
        return ok({ ...base, ...rawTransaction(tx, lastClosed()) });
      }

      default:
        // Throwing a real Error matters: the SDK surfaces a raw JSON-RPC error
        // object otherwise, and `catch (e) { if (e instanceof Error) ... }` in
        // an app's retry logic silently fails to match it.
        throw new Error(`in-process rpc: unimplemented method ${method}`);
    }
  };

  return stats;
}

export { accountLedgerKey };
