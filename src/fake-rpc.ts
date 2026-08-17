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
import { xdr, rpc, Address, StrKey, TransactionBuilder, hash as sha256 } from '@stellar/stellar-sdk';
import type { Ledger } from './index.js';
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
  txTOO_EARLY: 'txTooEarly',
  txTOO_LATE: 'txTooLate',
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
  'txTOO_EARLY',
  'txTOO_LATE',
  'txMISSING_OPERATION',
  'txMALFORMED',
  'txSOROBAN_INVALID',
  'txINSUFFICIENT_FEE',
  'txINSUFFICIENT_BALANCE',
]);

function operationResults(outcome: TxOutcome): xdr.OperationResult[] {
  const returned = outcome.returnValueXdr
    ? sha256(Buffer.from(outcome.returnValueXdr, 'base64'))
    : Buffer.alloc(32);
  const inner = outcome.ok
    ? xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(returned)
    : xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped();
  return [xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(inner))];
}

function transactionResult(outcome: TxOutcome, txHash: Buffer): xdr.TransactionResult {
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
        transactionHash: txHash,
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
  const sorobanMeta = new xdr.SorobanTransactionMetaV2({
    ext: new xdr.SorobanTransactionMetaExt(0),
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
    ledgerVersion: 27,
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

/**
 * Install an in-process JSON-RPC adapter on an existing `rpc.Server`.
 * Returns stats so a test can assert which methods were exercised.
 */
export function attachInProcessRpc(server: rpc.Server, ledger: Ledger): AdapterStats {
  const stats: AdapterStats = { calls: [], networkAttempts: 0 };
  const submitted = new Map<string, SubmittedTx>();
  const eventLog: BufferedEvent[] = [];

  (server as any).httpClient.defaults.adapter = async (config: any) => {
    // requestAirdrop posts to the friendbot URL, which is NOT JSON-RPC. Handle
    // it before assuming a JSON-RPC body, or the destructure below dies
    // unhelpfully on any non-JSON-RPC request.
    if (typeof config.url === 'string' && config.url.startsWith(FRIENDBOT_URL)) {
      stats.calls.push({ method: 'friendbot' });
      const addr = new URL(config.url).searchParams.get('addr');
      if (!addr) throw new Error('friendbot: missing addr');
      ledger.fund(addr, { balance: 10_000n * 10_000_000n });

      // The SDK reads the new account's sequence out of the meta
      // (findCreatedAccountSequenceInTransactionMeta), so the meta has to carry
      // a ledgerEntryCreated change for the AccountEntry — funding alone is not
      // enough to make requestAirdrop work.
      const created = xdr.LedgerEntry.fromXDR(
        ledger.getEntry(
          xdr.LedgerKey.account(
            new xdr.LedgerKeyAccount({
              accountId: xdr.AccountId.publicKeyTypeEd25519(
                StrKey.decodeEd25519PublicKey(addr),
              ),
            }),
          ).toXDR('base64'),
        )!,
        'base64',
      );

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

    switch (method) {
      case 'getHealth':
        return ok({
          status: 'healthy',
          latestLedger: ledger.ledgerSeq,
          oldestLedger: 1,
          ledgerRetentionWindow: ledger.ledgerSeq,
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
          sequence: ledger.ledgerSeq,
          headerXdr: ledgerHeaderXdr(ledger.ledgerSeq, ledger.timestamp),
          metadataXdr: ledgerCloseMetaXdr(ledger.ledgerSeq, ledger.timestamp),
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
          latestLedger: ledger.ledgerSeq,
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
          latestLedger: ledger.ledgerSeq,
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
          .map((t) => rawTransaction(t, ledger.ledgerSeq));
        return ok({
          transactions: txs,
          latestLedger: ledger.ledgerSeq,
          latestLedgerCloseTimestamp: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTimestamp: '0',
          cursor: String(ledger.ledgerSeq),
        });
      }

      case 'getLedgers': {
        const start: number = params?.startLedger ?? ledger.ledgerSeq;
        const count = Math.min(params?.pagination?.limit ?? 1, 200);
        const ledgers = Array.from({ length: count }, (_, i) => ({
          hash: Buffer.alloc(32).toString('hex'),
          sequence: start + i,
          ledgerCloseTime: String(ledger.timestamp),
          headerXdr: ledgerHeaderHistoryEntryXdr(start + i, ledger.timestamp),
          metadataXdr: ledgerCloseMetaXdr(start + i, ledger.timestamp),
        }));
        return ok({
          ledgers,
          latestLedger: ledger.ledgerSeq,
          latestLedgerCloseTime: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTime: '0',
          cursor: String(start + count),
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
              lastModifiedLedgerSeq: ledger.ledgerSeq,
              liveUntilLedgerSeq: ledger.getEntryTtl(k),
            };
          })
          .filter(Boolean);
        return ok({ entries, latestLedger: ledger.ledgerSeq });
      }

      case 'simulateTransaction': {
        const env = xdr.TransactionEnvelope.fromXDR(params.transaction, 'base64');
        const tx = env.v1().tx();
        const op = tx.operations()[0];
        const hostFn = op.body().invokeHostFunctionOp().hostFunction();

        const muxed: any = tx.sourceAccount();
        const ed: Buffer = muxed.switch().name === 'keyTypeMuxedEd25519'
          ? muxed.med25519().ed25519()
          : muxed.ed25519();
        const sourceAccountId = xdr.AccountId.publicKeyTypeEd25519(ed);

        const sim = ledger.simulate(hostFn, sourceAccountId.toXDR('base64'));
        if (!sim.ok) {
          return ok({ error: sim.error, latestLedger: ledger.ledgerSeq });
        }

        const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
        // A crude resource fee. Real fee parity needs soroban-simulation's
        // NetworkConfig; this is enough to exercise the assembly path.
        const resourceFee = 100_000 + sim.instructions / 10 + sim.writeBytes * 100;
        const txData = new xdr.SorobanTransactionData({
          ext: new (xdr as any).SorobanTransactionDataExt(0),
          resources,
          resourceFee: (xdr as any).Int64.fromString(String(Math.ceil(resourceFee))),
        });

        return ok({
          latestLedger: ledger.ledgerSeq,
          minResourceFee: String(Math.ceil(resourceFee)),
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
          results: [{ xdr: sim.returnValueXdr, auth: sim.authXdr }],
          cost: { cpuInsns: String(sim.cpuInsns), memBytes: String(sim.memBytes) },
          stateChanges: [],
        });
      }

      case 'sendTransaction': {
        const envelopeB64: string = params.transaction;
        const tx = TransactionBuilder.fromXDR(envelopeB64, ledger.networkPassphrase);
        const txHash = tx.hash();
        const hashHex = txHash.toString('hex');

        const outcome = ledger.sendTransaction(envelopeB64);
        const resultXdr = transactionResult(outcome, txHash).toXDR('base64');

        // Classic validation failures come back synchronously as ERROR, exactly
        // as stellar-rpc does -- this is what an app's retry logic keys on.
        if (REJECTED_AT_SUBMIT.has(outcome.code)) {
          return ok({
            status: 'ERROR',
            hash: hashHex,
            latestLedger: ledger.ledgerSeq,
            latestLedgerCloseTime: String(ledger.timestamp),
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
        ledger.advanceLedgers(1);

        return ok({
          status: 'PENDING',
          hash: hashHex,
          latestLedger: ledger.ledgerSeq,
          latestLedgerCloseTime: String(ledger.timestamp),
        });
      }

      case 'getTransaction': {
        const tx = submitted.get(params.hash);
        const base = {
          latestLedger: ledger.ledgerSeq,
          latestLedgerCloseTime: String(ledger.timestamp),
          oldestLedger: 1,
          oldestLedgerCloseTime: '0',
        };
        if (!tx) return ok({ ...base, status: 'NOT_FOUND' });
        return ok({ ...base, ...rawTransaction(tx, ledger.ledgerSeq) });
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
