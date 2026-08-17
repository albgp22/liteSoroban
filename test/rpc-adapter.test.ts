import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  StrKey,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../src/index.js';
import { attachInProcessRpc } from '../src/fake-rpc.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);
const PASSPHRASE = 'In-Process Test Network';
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });

describe('rpc.Server backed by the in-process ledger', () => {
  let L: Ledger;
  let sourceB64: string;
  let G: string;
  let server: rpc.Server;
  let stats: ReturnType<typeof attachInProcessRpc>;

  beforeEach(() => {
    L = new Ledger();
    sourceB64 = L.fundAccount(1);
    G = StrKey.encodeEd25519PublicKey(xdr.AccountId.fromXDR(sourceB64, 'base64').ed25519());

    // A URL that cannot resolve: if anything reaches the network, it fails loudly.
    server = new rpc.Server('https://in-process.invalid');
    stats = attachInProcessRpc(server, L);
  });

  it('serves getHealth with zero network access', async () => {
    const health = await server.getHealth();
    expect(health.status).toBe('healthy');
    expect(stats.calls.map((c) => c.method)).toContain('getHealth');
  });

  it('serves getAccount from the in-process ledger', async () => {
    const account = await server.getAccount(G);
    expect(account.accountId()).toBe(G);
    // account_entry() seeds seq_num 0, so the next tx uses sequence 1.
    expect(account.sequenceNumber()).toBe('0');
  });

  it('the SDK simulate + assembleTransaction path works end to end', async () => {
    // Deploy through the raw ledger API first.
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(createContractHostFn(sourceB64, wasmHash), sourceB64);
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
    const contractId = Address.fromScAddress(addr).toString();

    // From here on, everything goes through the real SDK.
    const account = await server.getAccount(G);
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(77n)]),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);

    const success = sim as rpc.Api.SimulateTransactionSuccessResponse;
    expect(scValToNative(success.result!.retval)).toBe(null); // put_persistent returns void
    expect(success.transactionData).toBeDefined();

    // assembleTransaction is the SDK code path the app actually depends on.
    const assembled = rpc.assembleTransaction(tx, sim).build();
    // Classic fee (100) + the resource fee carried inside transactionData.
    expect(Number(assembled.fee)).toBeGreaterThan(100);
    expect(contractId.startsWith('C')).toBe(true);

    expect(stats.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['getLedgerEntries', 'simulateTransaction']),
    );
  });

  it('simulation reflects state written earlier in the same test', async () => {
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(createContractHostFn(sourceB64, wasmHash), sourceB64);
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();

    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(123n)]), sourceB64);

    const account = await server.getAccount(G);
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(addr, 'get_persistent', [sym('ctr')]),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();

    const sim = (await server.simulateTransaction(tx)) as rpc.Api.SimulateTransactionSuccessResponse;
    expect(rpc.Api.isSimulationSuccess(sim)).toBe(true);
    expect(scValToNative(sim.result!.retval)).toBe(123n);
  });
});
