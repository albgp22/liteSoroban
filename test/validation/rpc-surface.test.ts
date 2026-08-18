/**
 * DIMENSION: the fake `rpc.Server` surface, and the full app-shaped flow.
 *
 * Everything here goes through the REAL SDK. Nothing pokes at `fake-rpc.ts`'s
 * internals: the question is only ever "does `rpc.Server`, the object an app
 * actually holds, behave the way stellar-rpc makes it behave".
 *
 * Expected values are derived from:
 *   - the SDK's own parsers (`rpc/parsers.js`) and declared response types
 *     (`rpc/api.d.ts`), which are the contract every app codes against;
 *   - the pinned host (soroban-env-host 27.0.1) for TTLs and events;
 *   - stellar-core's TransactionFrame rules for the classic failure codes;
 * never from what the harness happens to return.
 *
 * The base fixture is `contract_data.wasm` because it emits NO contract events;
 * `add_i32.wasm` does emit one, and that difference turns out to matter a great
 * deal (see the `events` block).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Account,
  Address,
  Asset,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  StrKey,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { attachInProcessRpc } from '../../src/fake-rpc.js';
import { accountKey, accountIdFromPublicKey } from '../../src/classic.js';
import { preFundedWallet, establishTrustline, type Wallet } from '../../src/fixtures.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const CONTRACT_DATA = fixture('contract_data.wasm');
const ADD_I32 = fixture('add_i32.wasm');

const RPC_URL = 'https://in-process.invalid';
const ZERO_HASH = '00'.repeat(32);

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });

let L: Ledger;
let server: rpc.Server;
let stats: ReturnType<typeof attachInProcessRpc>;
let w: Wallet;
let wasmHash: string;
let contractAddr: xdr.ScAddress;
let contractId: string;

/** Deploy a wasm through the raw ledger API and return its address. */
function deploy(code: Uint8Array, salt = 0): { hash: string; addr: xdr.ScAddress } {
  const hash = L.seedWasm(code);
  const saltBuf = Buffer.alloc(32);
  saltBuf[0] = salt;
  const { sent } = L.simulateAndSend(
    createContractHostFn(w.accountIdB64, hash, saltBuf),
    w.accountIdB64,
  );
  if (!sent.ok) throw new Error(`deploy failed: ${sent.error}`);
  return { hash, addr: xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address() };
}

beforeEach(() => {
  L = new Ledger();
  // thresholds [1,1,1,1]: a default account has medium threshold 0, so its
  // transactions need no signature at all and every signature bug hides.
  w = preFundedWallet(L, { thresholds: [1, 1, 1, 1] });

  server = new rpc.Server(RPC_URL);
  stats = attachInProcessRpc(server, L);

  const d = deploy(CONTRACT_DATA);
  wasmHash = d.hash;
  contractAddr = d.addr;
  contractId = Address.fromScAddress(contractAddr).toString();
});

function op(fn: string, args: xdr.ScVal[], addr: xdr.ScAddress = contractAddr) {
  return Operation.invokeHostFunction({ func: invokeHostFn(addr, fn, args), auth: [] });
}

async function build(operation: xdr.Operation, fee = '100') {
  const account = await server.getAccount(w.publicKey);
  return new TransactionBuilder(account, { fee, networkPassphrase: L.networkPassphrase })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

/** A real, simulation-derived SorobanTransactionData, for hand-built envelopes. */
async function simulatedData(): Promise<xdr.SorobanTransactionData> {
  const sim = (await server.simulateTransaction(
    await build(op('put_persistent', [sym('ctr'), u64(1n)])),
  )) as rpc.Api.SimulateTransactionSuccessResponse;
  expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);
  return sim.transactionData.build();
}

/**
 * SorobanTransactionData built from the RAW host simulation, bypassing
 * `server.simulateTransaction` entirely. Needed for contracts whose simulation
 * response the SDK cannot currently parse (see the `events` block), so those
 * tests still measure what they claim to measure.
 */
function rawSorobanData(hostFn: xdr.HostFunction): xdr.SorobanTransactionData {
  const sim = L.simulate(hostFn, w.accountIdB64);
  expect(sim.ok, sim.error).toBe(true);
  return new xdr.SorobanTransactionData({
    ext: new (xdr as any).SorobanTransactionDataExt(0),
    resources: xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64'),
    resourceFee: (xdr as any).Int64.fromString('2000000'),
  } as any);
}

const codeKey = (hash = wasmHash) =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, 'base64') }));

// ---------------------------------------------------------------------------
// 1. every implemented method, judged on the SDK-PARSED response
// ---------------------------------------------------------------------------

describe('implemented methods, as the SDK parses them', () => {
  it('getHealth reports the ledger the harness is actually on', async () => {
    const health = await server.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.latestLedger).toBe(L.ledgerSeq);
    expect(health.oldestLedger).toBe(1);
    expect(typeof health.ledgerRetentionWindow).toBe('number');
    expect(stats.calls.map((c) => c.method)).toContain('getHealth');
  });

  it('getNetwork reports the passphrase transactions are actually validated against', async () => {
    // An app does `const { passphrase } = await server.getNetwork()` and then
    // signs with it. If this disagrees with the passphrase the ledger checks
    // signatures against, every signed transaction is rejected.
    const net = await server.getNetwork();
    expect(net.passphrase).toBe(L.networkPassphrase);
  });

  it('getLatestLedger parses into Api.GetLatestLedgerResponse', async () => {
    // parsers.js:211 parseRawLatestLedger REQUIRES headerXdr and metadataXdr and
    // decodes them into xdr.LedgerHeader / xdr.LedgerCloseMeta.
    const latest = await server.getLatestLedger();
    expect(latest.sequence).toBe(L.ledgerSeq);
    expect(latest.headerXdr).toBeInstanceOf(xdr.LedgerHeader);
    expect(latest.metadataXdr).toBeInstanceOf(xdr.LedgerCloseMeta);
  });

  it('getLedgerEntries returns LedgerEntryData with the key round-tripped', async () => {
    const key = accountKey(w.accountId);
    const res = await server.getLedgerEntries(key);

    expect(res.latestLedger).toBe(L.ledgerSeq);
    expect(res.entries).toHaveLength(1);

    const entry = res.entries[0];
    expect(entry.val.switch().name).toBe('account');
    expect(StrKey.encodeEd25519PublicKey(entry.val.account().accountId().ed25519())).toBe(
      w.publicKey,
    );
    expect(entry.key.toXDR('base64')).toBe(key.toXDR('base64'));
  });

  it('getLedgerEntries carries liveUntilLedgerSeq for a TTL-bearing entry', async () => {
    const key = codeKey();
    const res = await server.getLedgerEntries(key);
    expect(res.entries).toHaveLength(1);

    // Host truth: seed_wasm writes ttl = ledger_seq + 100_000 (lib.rs), which is
    // also the host's min_persistent_entry_ttl.
    expect(res.entries[0].liveUntilLedgerSeq).toBe(L.getEntryTtl(key.toXDR('base64')));
    expect(res.entries[0].liveUntilLedgerSeq).toBeGreaterThan(L.ledgerSeq);
  });

  it('getLedgerEntries reports the ENTRY lastModifiedLedgerSeq, not the current ledger', async () => {
    const key = accountKey(w.accountId);
    const stored = xdr.LedgerEntry.fromXDR(L.getEntry(key.toXDR('base64'))!, 'base64');
    const writtenAt = stored.lastModifiedLedgerSeq();

    L.advanceLedgers(500);

    const res = await server.getLedgerEntries(key);
    // Real RPC echoes the entry's own lastModifiedLedgerSeq; that is how an app
    // tells "unchanged since ledger N" from "written this ledger".
    expect(res.entries[0].lastModifiedLedgerSeq).toBe(writtenAt);
    expect(res.entries[0].lastModifiedLedgerSeq).not.toBe(L.ledgerSeq);
  });

  it('getLedgerEntries omits keys that do not exist', async () => {
    const missing = accountKey(accountIdFromPublicKey(Keypair.random().publicKey()));
    const res = await server.getLedgerEntries(missing);
    expect(res.entries).toEqual([]);
    expect(res.latestLedger).toBe(L.ledgerSeq);
  });

  it('getLedgerEntries returns only the present entries of a mixed batch', async () => {
    const missing = accountKey(accountIdFromPublicKey(Keypair.random().publicKey()));
    const res = await server.getLedgerEntries(accountKey(w.accountId), missing, codeKey());
    expect(res.entries.map((e) => e.val.switch().name)).toEqual(['account', 'contractCode']);
  });

  it('simulateTransaction parses into a success response with a decoded retval', async () => {
    L.simulateAndSend(
      invokeHostFn(contractAddr, 'put_persistent', [sym('ctr'), u64(77n)]),
      w.accountIdB64,
    );

    const sim = await server.simulateTransaction(await build(op('get_persistent', [sym('ctr')])));
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);

    const s = sim as rpc.Api.SimulateTransactionSuccessResponse;
    expect(s.result!.retval.switch().name).toBe('scvU64');
    expect(scValToNative(s.result!.retval)).toBe(77n);
    expect(s.result!.auth).toEqual([]);

    expect(typeof s.minResourceFee).toBe('string');
    const data = s.transactionData.build();
    expect(BigInt(s.minResourceFee)).toBe(data.resourceFee().toBigInt());
    expect(data.resources().instructions()).toBeGreaterThan(0);
    // The footprint must at least cover the contract instance and its code.
    expect(data.resources().footprint().readOnly().length).toBeGreaterThanOrEqual(2);
    expect(s.latestLedger).toBe(L.ledgerSeq);
    expect((s as unknown as { _parsed: boolean })._parsed).toBe(true);
  });

  it('simulateTransaction parses into an error response for a call that cannot run', async () => {
    const sim = await server.simulateTransaction(await build(op('no_such_function', [])));
    expect(rpc.Api.isSimulationError(sim)).toBe(true);
    expect((sim as rpc.Api.SimulateTransactionErrorResponse).error.length).toBeGreaterThan(0);
  });

  it('getTransaction returns NOT_FOUND for an unknown hash', async () => {
    const got = await server.getTransaction(ZERO_HASH);
    expect(got.status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);
    expect(got.txHash).toBe(ZERO_HASH);
    expect(got.latestLedger).toBe(L.ledgerSeq);
    // NOT_FOUND must carry no transaction body at all.
    expect((got as unknown as Record<string, unknown>).envelopeXdr).toBeUndefined();
    expect((got as unknown as Record<string, unknown>).resultXdr).toBeUndefined();
    expect((got as unknown as Record<string, unknown>).returnValue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. the full app-shaped flow
// ---------------------------------------------------------------------------

describe('the full app-shaped flow', () => {
  it('getAccount -> build -> simulate -> assemble -> sign -> send -> poll -> decoded returnValue', async () => {
    const balanceBefore = w.balance();

    // 1. getAccount
    const account = await server.getAccount(w.publicKey);
    expect(account.accountId()).toBe(w.publicKey);
    expect(account.sequenceNumber()).toBe('0');

    // 2. build
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: L.networkPassphrase })
      .addOperation(op('put_persistent', [sym('ctr'), u64(77n)]))
      .setTimeout(30)
      .build();

    // 3. simulate
    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);

    // 4. assembleTransaction
    const assembled = rpc.assembleTransaction(tx, sim).build();
    const resourceFee = (sim as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee;
    expect(BigInt(assembled.fee)).toBe(100n + BigInt(resourceFee));
    expect(assembled.toEnvelope().v1().tx().ext().switch()).toBe(1);

    // 5. sign — the account has medium threshold 1, so this is load-bearing
    assembled.sign(w.keypair);
    expect(assembled.signatures).toHaveLength(1);

    // 6. sendTransaction
    const sent = await server.sendTransaction(assembled);
    expect(sent.status, JSON.stringify(sent)).toBe('PENDING');
    expect(sent.hash).toBe(assembled.hash().toString('hex'));
    expect((sent as unknown as Record<string, unknown>).errorResult).toBeUndefined();

    // 7. pollTransaction
    const got = await server.pollTransaction(sent.hash, { attempts: 3 });
    expect(got.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
    const ok = got as rpc.Api.GetSuccessfulTransactionResponse;

    // 8. the SDK-parsed shape
    expect(ok.txHash).toBe(sent.hash);
    expect(ok.feeBump).toBe(false);
    expect(ok.applicationOrder).toBe(1);
    expect(ok.resultXdr.result().switch().name).toBe('txSuccess');
    expect(ok.resultXdr.feeCharged().toBigInt()).toBe(BigInt(assembled.fee));
    expect(ok.envelopeXdr.v1().tx().seqNum().toString()).toBe('1');
    expect(ok.resultMetaXdr.switch()).toBe(4);
    // put_persistent returns void, and that is what the meta must say.
    expect(ok.resultMetaXdr.v4().sorobanMeta()!.returnValue().switch().name).toBe('scvVoid');

    // 9. the ledger really moved
    expect(w.sequence()).toBe(1n);
    expect(w.balance()).toBe(balanceBefore - BigInt(assembled.fee));

    // 10. read it back through the same flow: the value the contract returns
    //     must be the value the first transaction wrote.
    const readAccount = await server.getAccount(w.publicKey);
    expect(readAccount.sequenceNumber()).toBe('1');
    const readTx = new TransactionBuilder(readAccount, {
      fee: '100',
      networkPassphrase: L.networkPassphrase,
    })
      .addOperation(op('get_persistent', [sym('ctr')]))
      .setTimeout(30)
      .build();
    const readSim = await server.simulateTransaction(readTx);
    const readAssembled = rpc.assembleTransaction(readTx, readSim).build();
    readAssembled.sign(w.keypair);
    const readSent = await server.sendTransaction(readAssembled);
    const readGot = (await server.pollTransaction(readSent.hash, {
      attempts: 3,
    })) as rpc.Api.GetSuccessfulTransactionResponse;

    expect(readGot.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
    expect(scValToNative(readGot.returnValue!)).toBe(77n);
    // ...and decoded straight out of the meta, the way an app that keeps the
    // raw meta (for indexing, or for a receipt) would read it.
    expect(scValToNative(readGot.resultMetaXdr.v4().sorobanMeta()!.returnValue())).toBe(77n);
  });

  it('the passphrase from getNetwork can be used to build and sign a transaction', async () => {
    // The whole flow again, but with the passphrase discovered the way an app
    // discovers it instead of hardcoded from the harness.
    const { passphrase } = await server.getNetwork();
    const account = await server.getAccount(w.publicKey);

    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase })
      .addOperation(op('put_persistent', [sym('ctr'), u64(1n)]))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(w.keypair);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status, JSON.stringify(sent)).toBe('PENDING');
  });

  it('getTransaction reports int64 timestamps as numbers, per Api.RawGetTransactionResponse', async () => {
    const tx = await build(op('put_persistent', [sym('ctr'), u64(1n)]));
    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(w.keypair);
    const sent = await server.sendTransaction(assembled);

    const got = (await server.getTransaction(sent.hash)) as rpc.Api.GetSuccessfulTransactionResponse;
    // api.d.ts: createdAt: number, latestLedgerCloseTime: number. An app doing
    // `new Date(tx.createdAt * 1000)` gets NaN from a string.
    expect(typeof got.createdAt).toBe('number');
    expect(typeof got.latestLedgerCloseTime).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 3. error paths
// ---------------------------------------------------------------------------

describe('sendTransaction ERROR: classic failures surface as errorResult', () => {
  /** Build an envelope by hand, so validation-stage failures can be reached. */
  function raw(
    account: Account,
    data: xdr.SorobanTransactionData,
    opts: {
      fee?: string;
      memo?: Memo;
      timebounds?: { minTime: number | string; maxTime: number | string };
      ops?: number;
    } = {},
  ) {
    const builder = new TransactionBuilder(account, {
      fee: opts.fee ?? '100',
      networkPassphrase: L.networkPassphrase,
      sorobanData: data,
      ...(opts.memo ? { memo: opts.memo } : {}),
      ...(opts.timebounds ? { timebounds: opts.timebounds } : {}),
    });
    for (let i = 0; i < (opts.ops ?? 1); i++) {
      builder.addOperation(op('put_persistent', [sym('ctr'), u64(1n)]));
    }
    if (!opts.timebounds) builder.setTimeout(30);
    return builder.build();
  }

  async function expectError(tx: ReturnType<typeof raw>, arm: string) {
    const sent = await server.sendTransaction(tx);
    expect(sent.status, JSON.stringify(sent)).toBe('ERROR');
    expect(sent.hash).toBe(tx.hash().toString('hex'));
    const err = (sent as rpc.Api.SendTransactionResponse).errorResult;
    expect(err, 'errorResult must be a decoded xdr.TransactionResult').toBeDefined();
    expect(err!.result().switch().name).toBe(arm);
    return sent;
  }

  it('txBAD_SEQ', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '41'), data); // ledger is at seq 0
    tx.sign(w.keypair);
    await expectError(tx, 'txBadSeq');
    expect(w.sequence()).toBe(0n);
  });

  it('txNO_ACCOUNT', async () => {
    const data = await simulatedData();
    const stranger = Keypair.random();
    const tx = raw(new Account(stranger.publicKey(), '0'), data);
    tx.sign(stranger);
    await expectError(tx, 'txNoAccount');
  });

  it('txBAD_AUTH', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data);
    tx.sign(Keypair.random()); // a valid signature from the wrong signer
    await expectError(tx, 'txBadAuth');
    expect(w.sequence()).toBe(0n);
  });

  it('txTOO_LATE', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data, {
      timebounds: { minTime: 0, maxTime: L.timestamp - 1 },
    });
    tx.sign(w.keypair);
    await expectError(tx, 'txTooLate');
  });

  it('txTOO_EARLY', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data, {
      timebounds: { minTime: L.timestamp + 3600, maxTime: L.timestamp + 7200 },
    });
    tx.sign(w.keypair);
    await expectError(tx, 'txTooEarly');
  });

  it('txINSUFFICIENT_FEE', async () => {
    const data = await simulatedData();
    // total = 50 + resourceFee, so the inclusion fee is 50, below BASE_FEE.
    const tx = raw(new Account(w.publicKey, '0'), data, { fee: '50' });
    tx.sign(w.keypair);
    await expectError(tx, 'txInsufficientFee');
  });

  it('txINSUFFICIENT_BALANCE', async () => {
    const data = await simulatedData();
    // 2 base reserves (2 * 5_000_000 stroops) are locked, so this account has
    // 50 stroops available — far less than the resource fee.
    const poor = preFundedWallet(L, { xlm: 10_000_050n, thresholds: [1, 1, 1, 1] });
    const tx = raw(new Account(poor.publicKey, '0'), data);
    tx.sign(poor.keypair);
    await expectError(tx, 'txInsufficientBalance');
  });

  it('txSOROBAN_INVALID: a memo on an InvokeHostFunction transaction', async () => {
    // TransactionFrame.cpp:383-386 — no memo on a Soroban invocation from P25.
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data, { memo: Memo.text('hello') });
    tx.sign(w.keypair);
    await expectError(tx, 'txSorobanInvalid');
  });

  it('txMALFORMED: more than one operation', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data, { ops: 2 });
    tx.sign(w.keypair);
    await expectError(tx, 'txMalformed');
  });

  it('txMISSING_OPERATION', async () => {
    const data = await simulatedData();
    const tx = raw(new Account(w.publicKey, '0'), data, { ops: 0 });
    tx.sign(w.keypair);
    await expectError(tx, 'txMissingOperation');
  });
});

describe('a transaction that simulates green and applies red', () => {
  it('getTransaction reports FAILED with a decodable trapped operation result', async () => {
    L.simulateAndSend(
      invokeHostFn(contractAddr, 'put_persistent', [sym('ctr'), u64(77n)]),
      w.accountIdB64,
    );

    const account = await server.getAccount(w.publicKey);
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: L.networkPassphrase })
      .addOperation(op('get_persistent', [sym('ctr')]))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);

    // ...and now the world moves on before the transaction is submitted.
    L.simulateAndSend(invokeHostFn(contractAddr, 'del_persistent', [sym('ctr')]), w.accountIdB64);

    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(w.keypair);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status, JSON.stringify(sent)).toBe('PENDING');

    const got = await server.pollTransaction(sent.hash, { attempts: 3 });
    expect(got.status).toBe(rpc.Api.GetTransactionStatus.FAILED);

    const failed = got as rpc.Api.GetFailedTransactionResponse;
    expect(failed.resultXdr.result().switch().name).toBe('txFailed');
    const opResult = failed.resultXdr.result().results()[0];
    expect(opResult.tr().invokeHostFunctionResult().switch().name).toBe(
      'invokeHostFunctionTrapped',
    );
    // A failed transaction still costs its fee and burns the sequence number.
    expect(w.sequence()).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// 4. events — the host emits them; the RPC surface has to carry them
// ---------------------------------------------------------------------------

describe('events', () => {
  let addAddr: xdr.ScAddress;

  beforeEach(() => {
    // add_i32.wasm publishes a contract event on every call.
    addAddr = deploy(ADD_I32, 1).addr;
    const probe = L.simulate(invokeHostFn(addAddr, 'add', [i32(7), i32(35)]), w.accountIdB64);
    expect(probe.ok, probe.error).toBe(true);
    expect(probe.eventsXdr.length, 'fixture must emit an event for this block to mean anything')
      .toBeGreaterThan(0);
  });

  it('simulateTransaction.events decode as DiagnosticEvent, which is what parsers.js does', async () => {
    // parsers.js:176 — events: sim.events?.map(e => xdr.DiagnosticEvent.fromXDR(e, 'base64'))
    const sim = (await server.simulateTransaction(
      await build(op('add', [i32(7), i32(35)], addAddr)),
    )) as rpc.Api.SimulateTransactionSuccessResponse;

    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);
    expect(sim.events.length).toBeGreaterThan(0);
    expect(sim.events[0]).toBeInstanceOf(xdr.DiagnosticEvent);
    const topics = sim.events
      .flatMap((e) => e.event().body().v0().topics())
      .map((t) => scValToNative(t));
    expect(topics).toContain('add');
  });

  it('getTransaction surfaces the contract events the host emitted', async () => {
    // Built from the RAW host simulation so this test is not blocked by the
    // simulateTransaction parsing failure above.
    const hostFn = invokeHostFn(addAddr, 'add', [i32(7), i32(35)]);
    const account = await server.getAccount(w.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: L.networkPassphrase,
      sorobanData: rawSorobanData(hostFn),
    })
      .addOperation(op('add', [i32(7), i32(35)], addAddr))
      .setTimeout(30)
      .build();
    tx.sign(w.keypair);

    const sent = await server.sendTransaction(tx);
    expect(sent.status, JSON.stringify(sent)).toBe('PENDING');
    const got = (await server.pollTransaction(sent.hash, {
      attempts: 3,
    })) as rpc.Api.GetSuccessfulTransactionResponse;
    expect(got.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
    expect(scValToNative(got.returnValue!)).toBe(42);

    // Api.TransactionEvents — how an app confirms what a transaction did.
    const topics = got.events.contractEventsXdr
      .flat()
      .flatMap((e) => e.body().v0().topics())
      .map((t) => scValToNative(t));
    expect(topics).toContain('add');
  });

  it('the transaction meta carries the operation events', async () => {
    const hostFn = invokeHostFn(addAddr, 'add', [i32(7), i32(35)]);
    const account = await server.getAccount(w.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: L.networkPassphrase,
      sorobanData: rawSorobanData(hostFn),
    })
      .addOperation(op('add', [i32(7), i32(35)], addAddr))
      .setTimeout(30)
      .build();
    tx.sign(w.keypair);

    const sent = await server.sendTransaction(tx);
    const got = (await server.pollTransaction(sent.hash, {
      attempts: 3,
    })) as rpc.Api.GetSuccessfulTransactionResponse;

    // TransactionMetaV4.operations[i].events is where contract events live in
    // P23+ meta; an indexer replaying meta reads them from there.
    const ops = got.resultMetaXdr.v4().operations();
    expect(ops).toHaveLength(1);
    expect(ops[0].events().length).toBeGreaterThan(0);
  });

  it('getEvents serves the events the ledger already holds', async () => {
    const hostFn = invokeHostFn(addAddr, 'add', [i32(7), i32(35)]);
    const account = await server.getAccount(w.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: L.networkPassphrase,
      sorobanData: rawSorobanData(hostFn),
    })
      .addOperation(op('add', [i32(7), i32(35)], addAddr))
      .setTimeout(30)
      .build();
    tx.sign(w.keypair);
    await server.sendTransaction(tx);

    const res = await server.getEvents({
      startLedger: L.ledgerSeq - 1,
      filters: [{ type: 'contract', contractIds: [Address.fromScAddress(addAddr).toString()] }],
    });
    expect(res.events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. GAP INVENTORY — call every rpc.Server method
// ---------------------------------------------------------------------------

type Probe = [name: string, run: () => Promise<unknown>];

const UNIMPLEMENTED_RE = /unimplemented method/;

async function runInventory() {
  // Give the account a trustline so the trustline-backed probes are asking
  // about something that exists, rather than measuring a correct "not found".
  const issuer = preFundedWallet(L);
  const asset = new Asset('TEST', issuer.publicKey);
  establishTrustline(L, w, asset, { balance: 5_000n });

  const tx = await build(op('put_persistent', [sym('ctr'), u64(1n)]));
  const sim = await server.simulateTransaction(tx);
  const signedTx = rpc.assembleTransaction(tx, sim).build();
  signedTx.sign(w.keypair);

  const probes: Probe[] = [
    ['getHealth', () => server.getHealth()],
    ['getNetwork', () => server.getNetwork()],
    ['getLatestLedger', () => server.getLatestLedger()],
    ['getLedgerEntries', () => server.getLedgerEntries(accountKey(w.accountId))],
    ['getLedgerEntry', () => server.getLedgerEntry(accountKey(w.accountId))],
    ['getAccount', () => server.getAccount(w.publicKey)],
    ['getAccountEntry', () => server.getAccountEntry(w.publicKey)],
    ['getTrustline', () => server.getTrustline(w.publicKey, asset)],
    ['getClaimableBalance', () => server.getClaimableBalance('00'.repeat(36))],
    ['getAssetBalance', () => server.getAssetBalance(w.publicKey, asset)],
    [
      'getContractData',
      () => server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance()),
    ],
    ['getContractInstance', () => server.getContractInstance(contractId)],
    ['getContractWasmByContractId', () => server.getContractWasmByContractId(contractId)],
    ['getContractWasmByHash', () => server.getContractWasmByHash(wasmHash, 'base64')],
    ['getSACBalance', () => server.getSACBalance(contractId, Asset.native(), L.networkPassphrase)],
    ['getContractMethods', () => server.getContractMethods(contractId, L.networkPassphrase)],
    [
      'queryContract',
      () => server.queryContract(contractId, 'has_persistent', { key: 'ctr' }, L.networkPassphrase),
    ],
    [
      'simulateTransaction',
      async () => server.simulateTransaction(await build(op('put_persistent', [sym('a'), u64(1n)]))),
    ],
    [
      'prepareTransaction',
      async () => server.prepareTransaction(await build(op('put_persistent', [sym('a'), u64(1n)]))),
    ],
    ['getTransaction', () => server.getTransaction(ZERO_HASH)],
    ['pollTransaction', () => server.pollTransaction(ZERO_HASH, { attempts: 1 })],
    ['getTransactions', () => server.getTransactions({ startLedger: L.ledgerSeq - 1 })],
    ['getEvents', () => server.getEvents({ startLedger: L.ledgerSeq - 1, filters: [] })],
    ['getLedgers', () => server.getLedgers({ startLedger: L.ledgerSeq - 1 })],
    ['getFeeStats', () => server.getFeeStats()],
    ['getVersionInfo', () => server.getVersionInfo()],
    ['requestAirdrop', () => server.requestAirdrop(w.publicKey)],
    ['fundAddress', () => server.fundAddress(w.publicKey)],
    // last: it mutates the ledger
    ['sendTransaction', () => server.sendTransaction(signedTx)],
  ];

  const table: Record<string, string> = {};
  for (const [name, run] of probes) {
    try {
      await run();
      table[name] = 'ok';
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? JSON.stringify(e));
      table[name] = UNIMPLEMENTED_RE.test(msg) ? 'UNIMPLEMENTED' : `throws: ${msg.slice(0, 110)}`;
    }
  }
  return table;
}

describe('gap inventory: every rpc.Server method', () => {
  it('INVENTORY: pins which methods answer -32601 "unimplemented method"', async () => {
    const table = await runInventory();
    console.log('\nrpc.Server surface inventory:\n' + JSON.stringify(table, null, 2));

    const unimplemented = Object.keys(table)
      .filter((k) => table[k] === 'UNIMPLEMENTED')
      .sort();
    // fake-rpc.ts implements exactly 7 JSON-RPC methods; every other method the
    // SDK can reach either rides on getLedgerEntries or hits the -32601 arm.
    expect(unimplemented).toEqual([
      'getEvents',
      'getFeeStats',
      'getLedgers',
      'getTransactions',
      'getVersionInfo',
    ]);

    // getClaimableBalance is excluded from the strict check below: nothing in
    // the ledger has one, so "not found" is the correct answer, not a gap.
    expect(table.getClaimableBalance).toMatch(/not found/);
  });

  it('every JSON-RPC method the SDK can call is served in-process', async () => {
    const table = await runInventory();
    const unimplemented = Object.keys(table).filter((k) => table[k] === 'UNIMPLEMENTED');
    expect(unimplemented).toEqual([]);
  });

  it('every method that asks about state the ledger really holds answers', async () => {
    const table = await runInventory();
    const shouldWork = [
      'getHealth',
      'getNetwork',
      'getLatestLedger',
      'getLedgerEntries',
      'getLedgerEntry',
      'getAccount',
      'getAccountEntry',
      'getTrustline',
      'getAssetBalance',
      'getContractData',
      'getContractInstance',
      'getContractWasmByContractId',
      'getContractWasmByHash',
      'getSACBalance',
      'getContractMethods',
      'queryContract',
      'simulateTransaction',
      'prepareTransaction',
      'getTransaction',
      'pollTransaction',
      'sendTransaction',
    ];
    const broken = shouldWork.filter((k) => table[k] !== 'ok').map((k) => `${k}: ${table[k]}`);
    expect(broken).toEqual([]);
  });

  it('requestAirdrop creates a funded account, the way SDK-based test code does', async () => {
    // An in-process ledger can fund an account for free; a drop-in rpc.Server
    // should therefore be able to answer the SDK's friendbot path.
    const stranger = Keypair.random().publicKey();
    const account = await server.requestAirdrop(stranger);
    expect(account.accountId()).toBe(stranger);
  });
});

// ---------------------------------------------------------------------------
// 6. zero network access
// ---------------------------------------------------------------------------

type WithClient = { httpClient: { defaults: { adapter: (c: { url: string }) => Promise<unknown> } } };

function recordUrls(): string[] {
  const client = (server as unknown as WithClient).httpClient;
  const installed = client.defaults.adapter;
  const urls: string[] = [];
  client.defaults.adapter = async (config: { url: string }) => {
    urls.push(config.url);
    return installed(config);
  };
  return urls;
}

describe('zero network access', () => {
  it('the RPC URL is genuinely unroutable, so a leak could not silently succeed', async () => {
    const naked = new rpc.Server(RPC_URL); // no adapter attached
    await expect(naked.getHealth()).rejects.toThrow();
  });

  it('every request every method makes is served in-process', async () => {
    // If any SDK path built its own transport, its request would never appear
    // here — it would have gone to the network instead.
    const urls = recordUrls();

    const tx = await build(op('put_persistent', [sym('ctr'), u64(1n)]));
    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(w.keypair);
    const sent = await server.sendTransaction(assembled);
    await server.pollTransaction(sent.hash, { attempts: 2 });
    await server.getHealth();
    await server.getContractInstance(contractId);
    await server.getContractMethods(contractId, L.networkPassphrase);
    await server.queryContract(contractId, 'has_persistent', { key: 'ctr' }, L.networkPassphrase);

    expect(urls.length).toBeGreaterThan(5);
    expect([...new Set(urls)]).toEqual([`${RPC_URL}/`]);
    // NOTE: AdapterStats.networkAttempts is never incremented anywhere in
    // fake-rpc.ts, so this zero is structural, not evidence. The url list above
    // is the evidence.
    expect(stats.networkAttempts).toBe(0);
  });

  it('an explicit friendbot URL is intercepted, not fetched', async () => {
    // requestAirdrop posts to friendbotUrl through the SAME httpClient, so the
    // adapter must handle a non-JSON-RPC POST rather than let it reach the wire.
    const urls = recordUrls();
    const stranger = Keypair.random().publicKey();

    const err = await server
      .requestAirdrop(stranger, 'https://friendbot.invalid')
      .then(() => null, (e) => e);
    expect(err, 'a friendbot POST must not succeed against an unroutable host').not.toBeNull();
    console.log('requestAirdrop(explicit friendbot) rejected with:', String(err?.message ?? err));

    // It reached OUR adapter, so no socket was opened.
    expect(urls.some((u) => u.startsWith('https://friendbot.invalid'))).toBe(true);
    // ...and it failed inside the adapter, not in DNS/TCP.
    expect(String(err?.message ?? err)).not.toMatch(/ENOTFOUND|EAI_AGAIN|fetch failed/i);
  });
});
