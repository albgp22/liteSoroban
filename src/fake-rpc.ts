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
import { xdr, rpc, Address, TransactionBuilder, hash as sha256 } from '@stellar/stellar-sdk';
import type { Ledger } from './index.js';
import type { TxOutcome, TxResultCode } from './classic.js';

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

interface SubmittedTx {
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

  (server as any).httpClient.defaults.adapter = async (config: any) => {
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
          friendbotUrl: undefined,
        });

      case 'getLatestLedger':
        return ok({
          id: 'in-process',
          protocolVersion: ledger.protocolVersion,
          sequence: ledger.ledgerSeq,
        });

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
        submitted.set(hashHex, {
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

        const succeeded =
          tx.outcome.code === 'txSUCCESS' || tx.outcome.code === 'txFEE_BUMP_INNER_SUCCESS';
        return ok({
          ...base,
          status: succeeded ? 'SUCCESS' : 'FAILED',
          txHash: params.hash,
          applicationOrder: 1,
          feeBump: tx.feeBump,
          envelopeXdr: tx.envelopeB64,
          resultXdr: tx.resultXdr,
          resultMetaXdr: tx.resultMetaXdr,
          ledger: tx.ledger,
          createdAt: String(tx.createdAt),
        });
      }

      default:
        return {
          data: {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `in-process rpc: unimplemented method ${method}` },
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        };
    }
  };

  return stats;
}

export { accountLedgerKey };
