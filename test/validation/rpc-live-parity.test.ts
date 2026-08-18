/**
 * DIMENSION: `src/fake-rpc.ts` — the 18-method `rpc.Server` surface — measured
 * against a LIVE protocol-27 stellar-rpc node, not against a spec and not
 * against what the harness happens to return.
 *
 * Every expectation below is a payload that was captured from
 * http://localhost:8000/rpc (stellar-rpc 27.1.1 / captive-core v27.1.0,
 * passphrase "Standalone Network ; February 2017") on 2026-08-17. The captured
 * bytes are quoted inline next to each assertion so the test can be re-derived
 * without the container.
 *
 * These tests are RED by design: each one pins a way an app that works against
 * the fake would behave differently against a real node.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, type Wallet, type Contract } from '../../src/litestellar.js';
import { invokeHostFn } from '../../src/index.js';

const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

const CONTRACT_DATA = fixture('contract_data.wasm');
const ADD_I32 = fixture('add_i32.wasm'); // publishes a contract event on every call

let svm: LiteStellar;
let alice: Wallet;
let server: rpc.Server;
let cd: Contract;

/** Speak raw JSON-RPC to the adapter, so field NAMES and TYPES are visible. */
async function jsonRpc(method: string, params?: unknown): Promise<any> {
  const adapter = (server as any).httpClient.defaults.adapter;
  const res = await adapter({
    url: 'https://in-process.invalid',
    data: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.data.result ?? res.data.error;
}

async function buildTx(op: xdr.Operation, fee = '100') {
  const account = await server.getAccount(alice.publicKey);
  return new TransactionBuilder(account, { fee, networkPassphrase: svm.networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

const invokeOp = (c: Contract, fn: string, args: xdr.ScVal[]) =>
  Operation.invokeHostFunction({ func: invokeHostFn(c.address, fn, args), auth: [] });

/** simulate -> assemble -> sign -> send, the way an app does it. */
async function submit(c: Contract, fn: string, args: xdr.ScVal[]) {
  const tx = await buildTx(invokeOp(c, fn, args));
  const sim = await server.simulateTransaction(tx);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(alice.keypair);
  return server.sendTransaction(assembled);
}

beforeEach(() => {
  svm = new LiteStellar().withNetworkCostParams();
  alice = svm.airdrop();
  server = svm.rpcServer();
  cd = svm.deployContract(CONTRACT_DATA, { as: alice });
});

// ---------------------------------------------------------------------------
// getEvents
// ---------------------------------------------------------------------------

describe('getEvents vs the live node', () => {
  /** One ledger holding one contract event from add_i32. */
  async function emitOne() {
    const add = svm.deployContract(ADD_I32, { as: alice });
    await submit(add, 'add', [sc.i32(7), sc.i32(35)]);
    return add;
  }

  it('event.id uses the real node\'s zero-padded TOID format', async () => {
    // LIVE: "id": "0000034935263989760-0000000000"  (19-digit TOID, dash,
    // 10-digit event index). Apps sort and range-compare these ids as STRINGS
    // precisely because the real format is fixed-width and zero-padded.
    await emitOne();
    const res = await jsonRpc('getEvents', { startLedger: 1, filters: [] });
    expect(res.events.length).toBeGreaterThan(0);
    expect(res.events[0].id).toMatch(/^\d{19}-\d{10}$/);
  });

  it('events carry operationIndex/transactionIndex, the names the SDK declares', async () => {
    // LIVE: {"operationIndex":0,"transactionIndex":0,...}
    // rpc/api.d.ts:271-272 declares exactly `transactionIndex` and
    // `operationIndex` on EventResponse; the fake emits txIndex/opIndex, so a
    // typed app reads `undefined` at runtime with no type error.
    await emitOne();
    const res = await jsonRpc('getEvents', { startLedger: 1, filters: [] });
    const ev = res.events[0];
    expect(typeof ev.operationIndex, JSON.stringify(Object.keys(ev))).toBe('number');
    expect(typeof ev.transactionIndex, JSON.stringify(Object.keys(ev))).toBe('number');
  });

  it('does not offer a pagingToken a real node no longer returns', async () => {
    // LIVE event keys are exactly:
    //   type, ledger, ledgerClosedAt, contractId, id, operationIndex,
    //   transactionIndex, txHash, inSuccessfulContractCall, topic, value
    // `pagingToken` was removed from stellar-rpc. Code that resumes from
    // `event.pagingToken` works here and reads `undefined` against a real node.
    await emitOne();
    const res = await jsonRpc('getEvents', { startLedger: 1, filters: [] });
    expect(Object.keys(res.events[0])).not.toContain('pagingToken');
  });

  it('ledgerClosedAt uses the RFC3339 form the real node emits', async () => {
    // LIVE: "ledgerClosedAt": "2026-08-17T22:41:05Z"  — second precision, no
    // milliseconds. `new Date(...).toISOString()` yields "...:05.000Z", so any
    // exact string comparison or fixture snapshot differs.
    await emitOne();
    const res = await jsonRpc('getEvents', { startLedger: 1, filters: [] });
    expect(res.events[0].ledgerClosedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('pagination.cursor advances the page instead of replaying it', async () => {
    // LIVE: page 1 -> cursor "0000034978213658623-4294967295"; re-issuing with
    // {pagination:{cursor}} returns the NEXT events (empty at the end), never
    // the same page again. The standard app loop
    //   while (true) { const {events, cursor} = await getEvents({...,cursor});
    //                  if (!events.length) break; ... }
    // therefore terminates on a real node and spins forever here.
    const add = svm.deployContract(ADD_I32, { as: alice });
    await submit(add, 'add', [sc.i32(1), sc.i32(1)]);
    await submit(add, 'add', [sc.i32(2), sc.i32(2)]);

    const page1 = await jsonRpc('getEvents', { startLedger: 1, filters: [], pagination: { limit: 1 } });
    expect(page1.events).toHaveLength(1);

    const page2 = await jsonRpc('getEvents', {
      filters: [],
      pagination: { cursor: page1.cursor, limit: 1 },
    });
    const ids1 = page1.events.map((e: any) => e.id);
    const ids2 = page2.events.map((e: any) => e.id);
    expect(ids2, `cursor ${page1.cursor} replayed page 1`).not.toEqual(ids1);
  });

  it('topic filters are applied', async () => {
    // LIVE: filters:[{type:"contract",topics:[[<sym NOPE>,"*","*","*"]]}] -> 0
    // events, while the unfiltered call over the same range returns 3. The fake
    // looks at `contractIds` and `type` only, so `topics` is silently ignored
    // and an app's "only my transfer events" subscription receives everything.
    await emitOne();
    const NOPE = nativeToScVal('NOPE_NOT_A_REAL_TOPIC', { type: 'symbol' }).toXDR('base64');
    const res = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: [{ type: 'contract', topics: [[NOPE]] }],
    });
    expect(res.events).toHaveLength(0);
  });

  it('topic wildcards match by arity, the way the real node matches them', async () => {
    // LIVE: a 4-segment transfer event matches topics:[["*","*","*","*"]] and
    // does NOT match topics:[[<sym transfer>,"*"]] — segment count must equal
    // the event's topic count.
    const add = await emitOne();
    const contractId = add.contractId;
    const unfiltered = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: [{ type: 'contract', contractIds: [contractId] }],
    });
    expect(unfiltered.events.length, 'fixture must emit at least one event').toBeGreaterThan(0);
    const topicCount = unfiltered.events[0].topic.length;

    const wrongArity = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: [
        {
          type: 'contract',
          contractIds: [contractId],
          topics: [Array.from({ length: topicCount + 3 }, () => '*')],
        },
      ],
    });
    expect(
      wrongArity.events,
      `a ${topicCount + 3}-segment pattern matched a ${topicCount}-topic event`,
    ).toHaveLength(0);
  });

  it('rejects a startLedger outside the retention window', async () => {
    // LIVE: {"code":-32602,"message":"startLedger must be positive"} for 0, and
    // {"code":-32600,"message":"startLedger must be within the ledger range: 7 - 8202"}
    // for 1. The fake defaults startLedger to 0 and never range-checks, so a
    // paging bug that a real node reports as an error passes here.
    const zero = await jsonRpc('getEvents', { startLedger: 0, filters: [] });
    expect(zero.code, `startLedger:0 returned ${JSON.stringify(zero).slice(0, 120)}`).toBeDefined();
  });

  it('rejects malformed filters the way the real node does', async () => {
    // LIVE: 6 filters -> {"code":-32602,"message":"maximum 5 filters per request"}
    //       limit 20000 -> {"code":-32602,"message":"limit must not exceed 10000"}
    //       type "diagnostic" -> {"code":-32602,"message":"filter type invalid: ...
    //         type must be either 'system' or 'contract'"}
    const tooMany = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: Array.from({ length: 6 }, () => ({ type: 'contract' })),
    });
    const tooBig = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: [],
      pagination: { limit: 20_000 },
    });
    const badType = await jsonRpc('getEvents', {
      startLedger: 1,
      filters: [{ type: 'diagnostic' }],
    });
    expect(
      [tooMany.code, tooBig.code, badType.code],
      'none of the three malformed requests was rejected',
    ).toEqual([-32602, -32602, -32602]);
  });

  it('serves the protocol-23 fee events a real ledger emits', async () => {
    // LIVE: one Soroban transaction produced THREE events in its ledger —
    // two `fee` events on the native SAC (transactionIndex 0 and 1048575,
    // inSuccessfulContractCall false/true) plus the contract's own event.
    // The fake buffers only `outcome.eventsXdr`, so fee flow is invisible.
    await emitOne();
    const res = await jsonRpc('getEvents', { startLedger: 1, filters: [] });
    const topics = res.events.flatMap((e: any) =>
      e.topic.map((t: string) => {
        const v = xdr.ScVal.fromXDR(t, 'base64');
        return v.switch().name === 'scvSymbol' ? v.sym().toString() : '';
      }),
    );
    expect(topics, JSON.stringify(topics)).toContain('fee');
  });
});

// ---------------------------------------------------------------------------
// getTransaction / getTransactions
// ---------------------------------------------------------------------------

describe('getTransaction vs the live node', () => {
  it('carries diagnosticEventsXdr, which is how an app reads a failure', async () => {
    // LIVE (a FAILED soroban tx): "diagnosticEventsXdr" holds 22 entries,
    // including topics [error, Error(Contract,#14)] with the human message.
    // parsers.js:parseTransactionInfo maps raw.diagnosticEventsXdr onto
    // GetTransactionResponse.diagnosticEventsXdr; the fake never sets it, so
    // `got.diagnosticEventsXdr` is undefined and the contract error code is
    // unrecoverable from the RPC response.
    const put = await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const ok = await jsonRpc('getTransaction', { hash: put.hash });
    expect(ok.status).toBe('SUCCESS');
    expect(Array.isArray(ok.diagnosticEventsXdr), JSON.stringify(Object.keys(ok))).toBe(true);
  });

  it('carries events.transactionEventsXdr (the protocol-23 fee events)', async () => {
    // LIVE: "events": { "transactionEventsXdr": [<fee charged>, <fee refund>],
    //                   "contractEventsXdr": [[...]] }
    // Both a SUCCESS and a FAILED transaction carry the two fee events.
    const put = await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const ok = await jsonRpc('getTransaction', { hash: put.hash });
    expect(Object.keys(ok.events)).toContain('transactionEventsXdr');
    expect(ok.events.transactionEventsXdr.length).toBeGreaterThan(0);
  });

  it('a FAILED transaction reports no contract events', async () => {
    // LIVE (FAILED tx): "events": { "transactionEventsXdr": [...] } — the
    // contractEventsXdr key is ABSENT. Ground truth agrees: e2e_invoke.rs:57
    // "Empty when invocation fails."
    // simulate against a key that exists, then delete it before submitting.
    svm.ledger.simulateAndSend(
      invokeHostFn(cd.address, 'put_persistent', [sc.sym('gone'), sc.u64(1n)]),
      alice.accountIdB64,
    );
    const tx2 = await buildTx(invokeOp(cd, 'get_persistent', [sc.sym('gone')]));
    const sim = await server.simulateTransaction(tx2);
    svm.ledger.simulateAndSend(
      invokeHostFn(cd.address, 'del_persistent', [sc.sym('gone')]),
      alice.accountIdB64,
    );
    const assembled = rpc.assembleTransaction(tx2, sim).build();
    assembled.sign(alice.keypair);
    const sent = await server.sendTransaction(assembled);
    const got = await jsonRpc('getTransaction', { hash: sent.hash });
    expect(got.status).toBe('FAILED');
    expect(
      (got.events.contractEventsXdr ?? []).flat(),
      'a failed transaction must publish no contract events',
    ).toHaveLength(0);
  });
});

describe('sendTransaction vs the live node', () => {
  it('a resubmitted envelope comes back DUPLICATE, not ERROR/txBadSeq', async () => {
    // LIVE:
    //   first: {"status":"PENDING","hash":"3870caf7..."}
    //   dup:   {"status":"DUPLICATE","hash":"3870caf7..."}
    // Every submit-then-poll loop resubmits on a timeout. Against a real node
    // that is a no-op (DUPLICATE -> keep polling); here the second submit is
    // re-validated against the already-bumped sequence and comes back
    // ERROR/txBadSeq, which retry logic reads as "this transaction is dead".
    const tx = await buildTx(invokeOp(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]));
    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(alice.keypair);

    const first = await jsonRpc('sendTransaction', { transaction: assembled.toXDR() });
    expect(first.status).toBe('PENDING');
    const again = await jsonRpc('sendTransaction', { transaction: assembled.toXDR() });
    expect(again.status, JSON.stringify(again)).toBe('DUPLICATE');
  });

  it('the errorResult of a rejected submit carries the fee that was charged', async () => {
    // LIVE txBAD_SEQ: errorResultXdr "AAAAAAABIO7////7AAAAAA==" decodes to
    // feeCharged 73966 / txBadSeq. classic.ts:fail() hardcodes feeCharged 0n,
    // so `sent.errorResult.feeCharged()` reads 0 for every rejection.
    const tx = await buildTx(invokeOp(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]));
    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    // Bump the sequence out from under it.
    svm.ledger.sendTransaction(
      (() => {
        const t = rpc.assembleTransaction(tx, sim).build();
        t.sign(alice.keypair);
        return t.toXDR();
      })(),
    );
    assembled.sign(alice.keypair);
    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    const err = (sent as rpc.Api.SendTransactionResponse).errorResult!;
    expect(err.result().switch().name).toBe('txBadSeq');
    expect(err.feeCharged().toBigInt()).toBeGreaterThan(0n);
  });
});

describe('getTransactions vs the live node', () => {
  it('reports int64 timestamps as numbers and a TOID cursor', async () => {
    // LIVE: "createdAt": 1787006578            (NUMBER in getTransactions,
    //                                           STRING in getTransaction)
    //       "latestLedgerCloseTimestamp": 1787006611   (NUMBER)
    //       "cursor": "35446365097985"                 (a TOID, not a ledger)
    // The fake returns strings and `String(ledger.ledgerSeq)`; an app doing
    // `new Date(tx.createdAt * 1000)` or resuming from `cursor` diverges.
    await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const res = await jsonRpc('getTransactions', { startLedger: 1 });
    expect(typeof res.transactions[0].createdAt).toBe('number');
    expect(typeof res.latestLedgerCloseTimestamp).toBe('number');
    expect(Number(res.cursor)).toBeGreaterThan(svm.ledgerSequence);
  });

  it('honours pagination.limit', async () => {
    // The real node caps the page at `pagination.limit` and hands back a cursor
    // to continue. The fake ignores both, so an app that pages 200 at a time
    // gets the entire history in one response and then loops on the same page.
    await submit(cd, 'put_persistent', [sc.sym('a'), sc.u64(1n)]);
    await submit(cd, 'put_persistent', [sc.sym('b'), sc.u64(2n)]);
    await submit(cd, 'put_persistent', [sc.sym('c'), sc.u64(3n)]);
    const res = await jsonRpc('getTransactions', { startLedger: 1, pagination: { limit: 1 } });
    expect(res.transactions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getLedgers
// ---------------------------------------------------------------------------

describe('getLedgers vs the live node', () => {
  it('does not invent ledgers that have not closed', async () => {
    // LIVE: startLedger 50 past the tip ->
    // {"code":-32600,"message":"start ledger (8329) must be between the oldest
    //  ledger: 7 and the latest ledger: 8279 for this rpc instance"}
    // The fake happily manufactures LedgerHeaders for sequence numbers in the
    // future, so an off-by-N in an app's cursor arithmetic is undetectable.
    const res = await jsonRpc('getLedgers', {
      startLedger: svm.ledgerSequence + 500,
      pagination: { limit: 2 },
    });
    const invented = (res.ledgers ?? []).filter((l: any) => l.sequence > svm.ledgerSequence);
    expect(
      res.code ?? invented.map((l: any) => l.sequence),
      'ledgers past the tip were fabricated instead of rejected',
    ).toBe(-32600);
  });

  it('gives each ledger its own hash and its own close time', async () => {
    // LIVE: {"hash":"4ef93ee7...","sequence":8277,"ledgerCloseTime":"1787006609"}
    //       {"hash":"83eb0f41...","sequence":8278,"ledgerCloseTime":"1787006610"}
    // The fake returns 64 zeros for EVERY hash and the CURRENT timestamp for
    // every ledger. Every hash equality an app could assert — hash vs
    // previousLedgerHash vs bucketListHash vs txSetHash — is trivially true, so
    // a chain-verification bug cannot fail here.
    await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    svm.advanceLedgers(1);
    const res = await jsonRpc('getLedgers', {
      startLedger: svm.ledgerSequence - 2,
      pagination: { limit: 3 },
    });
    const hashes = res.ledgers.map((l: any) => l.hash);
    const times = res.ledgers.map((l: any) => l.ledgerCloseTime);
    expect(new Set(hashes).size, `hashes: ${JSON.stringify(hashes)}`).toBe(hashes.length);
    expect(new Set(times).size, `closeTimes: ${JSON.stringify(times)}`).toBe(times.length);
  });

  it('the synthetic LedgerHeader is not a chain of zeros', async () => {
    // A zero previousLedgerHash and a zero bucketListHash are not merely
    // "unset": they make every cross-field hash comparison succeed. Both the
    // header's own hash and its previousLedgerHash are 32 zero bytes, so
    //   header.previousLedgerHash === previousEntry.hash
    // holds for a chain that was never linked.
    const res = await jsonRpc('getLedgers', {
      startLedger: svm.ledgerSequence,
      pagination: { limit: 1 },
    });
    const entry = xdr.LedgerHeaderHistoryEntry.fromXDR(res.ledgers[0].headerXdr, 'base64');
    const h = entry.header();
    const zero = Buffer.alloc(32);
    expect(h.bucketListHash().equals(zero), 'bucketListHash is 32 zero bytes').toBe(false);
    expect(h.previousLedgerHash().equals(zero), 'previousLedgerHash is 32 zero bytes').toBe(false);
    expect(h.totalCoins().toBigInt(), 'totalCoins is 0, so supply arithmetic reads as zero')
      .toBeGreaterThan(0n);
  });

  it('metadataXdr decodes as the LedgerCloseMeta version protocol 27 emits', async () => {
    // LIVE getLedgers/getLatestLedger metadataXdr both begin "AAAAAg..." — union
    // discriminant 2, LedgerCloseMetaV2. The fake emits V0 (discriminant 0), a
    // pre-protocol-20 shape: `lcm.v2()` throws on it, and V0 has no
    // `evictedKeys`, no `totalByteSizeOfLiveSorobanState`.
    const latest = await jsonRpc('getLatestLedger');
    const lcm = xdr.LedgerCloseMeta.fromXDR(latest.metadataXdr, 'base64');
    expect(lcm.switch()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getLatestLedger / getHealth / getNetwork
// ---------------------------------------------------------------------------

describe('the info methods vs the live node', () => {
  it('getLatestLedger carries closeTime', async () => {
    // LIVE: {"id":"db72124b...","protocolVersion":27,"sequence":7971,
    //        "closeTime":"1787006301","headerXdr":...,"metadataXdr":...}
    // parsers.js:parseRawLatestLedger returns `closeTime: raw.closeTime` and
    // api.d.ts:48 declares it non-optional; the fake omits the field entirely.
    const parsed = await server.getLatestLedger();
    expect((parsed as any).closeTime).toBeDefined();
  });

  it('getLatestLedger.id is the ledger hash, not a placeholder string', async () => {
    // LIVE: "id":"db72124bc0743ce311f55d2b7d220024c5e99dc668ac77951ca00fe1356b9c36"
    // The fake returns the literal string "in-process".
    const latest = await jsonRpc('getLatestLedger');
    expect(latest.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getHealth carries the ledger close times', async () => {
    // LIVE: {"status":"healthy","latestLedger":7981,
    //        "latestLedgerCloseTime":"1787006311","oldestLedger":7,
    //        "oldestLedgerCloseTime":"1786998313","ledgerRetentionWindow":120960}
    const h = await jsonRpc('getHealth');
    expect(Object.keys(h)).toContain('latestLedgerCloseTime');
    expect(Object.keys(h)).toContain('oldestLedgerCloseTime');
  });
});

// ---------------------------------------------------------------------------
// simulateTransaction
// ---------------------------------------------------------------------------

describe('simulateTransaction vs the live node', () => {
  it('an error response still carries the diagnostic events', async () => {
    // LIVE: keys are exactly [error, events, latestLedger]; `events` holds the
    // fn_call diagnostic and the `error` diagnostic whose topic is
    // Error(Contract,#14). That is where every app reads a contract error code
    // out of a failed simulation. The fake returns {error, latestLedger} only,
    // so parsers.js coalesces `events` to [] and the code is lost.
    const tx = await buildTx(invokeOp(cd, 'get_persistent', [sc.sym('missing')]));
    const simRaw = await jsonRpc('simulateTransaction', { transaction: tx.toXDR() });
    expect(typeof simRaw.error).toBe('string');
    expect(Array.isArray(simRaw.events), JSON.stringify(Object.keys(simRaw))).toBe(true);
    expect(simRaw.events.length).toBeGreaterThan(0);

    const sim = (await server.simulateTransaction(tx)) as rpc.Api.SimulateTransactionErrorResponse;
    expect(rpc.Api.isSimulationError(sim)).toBe(true);
    expect(sim.events.length, 'an app cannot recover the contract error code').toBeGreaterThan(0);
  });

  it('a success response carries the host DIAGNOSTIC events, not the contract events', async () => {
    // LIVE (put_persistent, a contract that emits nothing): events.length === 2
    // — the fn_call and fn_return diagnostics. The fake maps the host's
    // CONTRACT events into DiagnosticEvent wrappers instead, so a contract that
    // publishes nothing yields an empty `events` and the fn_call/fn_return tree
    // an app uses for tracing is never present.
    const tx = await buildTx(invokeOp(cd, 'put_persistent', [sc.sym('k'), sc.u64(9n)]));
    const sim = (await server.simulateTransaction(tx)) as rpc.Api.SimulateTransactionSuccessResponse;
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);
    const kinds = sim.events.map((e) => e.event().type().name);
    expect(kinds, `event types: ${JSON.stringify(kinds)}`).toContain('diagnostic');
  });

  it('reports the stateChanges the invocation would make', async () => {
    // LIVE: "stateChanges":[{"type":"created","key":"AAAABgAAAAEl2+cG...",
    //        "before":null,"after":"AAAAAAAAAAYAAAAAAAAAASXb5wa0..."}]
    // The fake hardcodes []. `parseSuccessful` therefore never populates
    // SimulateTransactionSuccessResponse.stateChanges.
    const tx = await buildTx(invokeOp(cd, 'put_persistent', [sc.sym('brand_new'), sc.u64(9n)]));
    const simRaw = await jsonRpc('simulateTransaction', { transaction: tx.toXDR() });
    expect(simRaw.stateChanges.length).toBeGreaterThan(0);
  });

  it('minResourceFee is in the same league as the real network for the same footprint', async () => {
    // Same call, same contract, same footprint, both at protocol 27:
    //   LIVE  instructions 599484, writeBytes 80, diskReadBytes 0
    //         -> minResourceFee 83183, and transactionData.resourceFee 83183
    //   FAKE  instructions 599484, writeBytes 80  (metering is EXACT)
    //         -> minResourceFee 162949   ... 1.96x
    // The fee is the only thing wrong: `100_000 + instructions/10 + writeBytes*100`
    // in fake-rpc.ts is not the protocol-27 fee model, and assembleTransaction
    // stamps it straight onto the envelope, so every fee assertion an app makes
    // is off by ~2x and the flat 100_000 floor dwarfs cheap calls.
    const tx = await buildTx(invokeOp(cd, 'put_persistent', [sc.sym('k'), sc.u64(9n)]));
    const simRaw = await jsonRpc('simulateTransaction', { transaction: tx.toXDR() });
    const data = xdr.SorobanTransactionData.fromXDR(simRaw.transactionData, 'base64');

    // Anchor the comparison: the metering must match the live node exactly, or
    // the fee comparison below would be measuring something else.
    expect(data.resources().instructions()).toBe(599_484);
    expect(data.resources().writeBytes()).toBe(80);

    const LIVE_MIN_RESOURCE_FEE = 83_183;
    const ratio = Number(simRaw.minResourceFee) / LIVE_MIN_RESOURCE_FEE;
    expect(
      ratio,
      `minResourceFee ${simRaw.minResourceFee} vs live ${LIVE_MIN_RESOURCE_FEE}`,
    ).toBeLessThan(1.25);
  });
});

// ---------------------------------------------------------------------------
// the in-process friendbot, and the account it creates
// ---------------------------------------------------------------------------

describe('the in-process friendbot vs a real CreateAccount', () => {
  it('starts the account at getStartingSequenceNumber(ledgerSeq)', async () => {
    // LIVE friendbot at ledger 8025 produced seqNum 34467112550400 == 8025<<32.
    // stellar-core: CreateAccountOpFrame sets
    //   newAccount.seqNum = getStartingSequenceNumber(ledgerSeq) = seq << 32.
    // `ledger.fund` writes seqNum 0, so `requestAirdrop(...).sequenceNumber()`
    // is "0" here and ~3.4e13 on any real network. Every subsequent envelope
    // this harness signs carries a sequence number a real node would reject
    // with txBAD_SEQ.
    const fresh = Keypair.random();
    const account = await server.requestAirdrop(fresh.publicKey());
    const expected = (BigInt(svm.ledgerSequence) << 32n).toString();
    expect(account.sequenceNumber()).toBe(expected);
  });

  it('the account grows the v1/v2/v3 ext chain once it submits a transaction', async () => {
    // LIVE, after 4 transactions:
    //   ext v1 { liabilities, ext v2 { sponsorship, ext v3 { seqLedger 8246,
    //                                                        seqTime 1787006578 } } }
    // core's maybeUpdateAccountOnLedgerSeqUpdate stamps seqLedger/seqTime on
    // every sequence bump from protocol 19. classic.ts:bumpSequence rewrites
    // only seqNum, so the entry stays at ext v0 forever and the PreconditionsV2
    // minSeqAge / minSeqLedgerGap inputs simply do not exist in this ledger.
    await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const entry = await server.getAccountEntry(alice.publicKey);
    expect(entry.seqNum().toString()).not.toBe('0');
    expect(entry.ext().switch(), 'AccountEntry ext is still v0 after a transaction').toBe(1);
    expect(entry.ext().v1().ext().v2().ext().v3().seqLedger()).toBe(svm.ledgerSequence);
  });
});

// ---------------------------------------------------------------------------
// zero sockets
// ---------------------------------------------------------------------------

describe('zero sockets', () => {
  it('a full app flow opens no socket and issues no fetch', async () => {
    // CJS module objects, because ESM namespaces are frozen and cannot be spied.
    const require = createRequire(import.meta.url);
    const net = require('node:net');
    const http = require('node:http');
    const https = require('node:https');
    const attempts: string[] = [];

    const realConnect = net.Socket.prototype.connect;
    const realFetch = globalThis.fetch;
    const realHttpRequest = http.request;
    const realHttpsRequest = https.request;
    (net.Socket.prototype as any).connect = function (...args: any[]) {
      attempts.push(`net.connect ${JSON.stringify(args[0])}`);
      throw new Error('socket blocked by test');
    };
    (globalThis as any).fetch = (...args: any[]) => {
      attempts.push(`fetch ${String(args[0])}`);
      throw new Error('fetch blocked by test');
    };
    (http as any).request = (...args: any[]) => {
      attempts.push(`http.request ${String(args[0])}`);
      throw new Error('http blocked by test');
    };
    (https as any).request = (...args: any[]) => {
      attempts.push(`https.request ${String(args[0])}`);
      throw new Error('https blocked by test');
    };

    try {
      await server.getHealth();
      await server.getNetwork();
      await server.getLatestLedger();
      await server.getVersionInfo();
      await server.getFeeStats();
      await server.getAccount(alice.publicKey);
      await server.requestAirdrop(Keypair.random().publicKey());
      const sent = await submit(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
      await server.pollTransaction(sent.hash, { attempts: 2 });
      await server.getTransactions({ startLedger: 1 });
      await server.getEvents({ startLedger: 1, filters: [] });
      await (server as any).getLedgers({ startLedger: svm.ledgerSequence, pagination: { limit: 1 } });
      await server.getContractInstance(cd.contractId);

      // Control: the same guard MUST catch a server that was never patched, or
      // the empty `attempts` list above would prove nothing.
      const naked = new rpc.Server('https://horizon-testnet.stellar.org');
      await naked.getHealth().catch(() => undefined);
      expect(attempts.length, 'the network guard itself is inert').toBeGreaterThan(0);
      attempts.length = 0;
    } finally {
      (net.Socket.prototype as any).connect = realConnect;
      (globalThis as any).fetch = realFetch;
      (http as any).request = realHttpRequest;
      (https as any).request = realHttpsRequest;
    }

    expect(attempts, `network was reached: ${JSON.stringify(attempts)}`).toEqual([]);
  });

  it('contract.Client.deploy reaches the wire despite options.server', async () => {
    // client.js:84 calls specFromWasmHash(), and client.js:29-35 builds its OWN
    // `new RpcServer(rpcUrl)` with no chance to pass one in — unlike
    // Client.from / Client.fromWasmHash, which both honour options.server.
    // With the RPC url pointed at a real host this opens a socket.
    const require = createRequire(import.meta.url);
    const net = require('node:net');
    const attempts: string[] = [];
    const realConnect = net.Socket.prototype.connect;
    const realFetch = globalThis.fetch;
    net.Socket.prototype.connect = function (...args: any[]) {
      attempts.push(`net.connect ${JSON.stringify(args[0])}`);
      throw new Error('socket blocked by test');
    };
    (globalThis as any).fetch = (...args: any[]) => {
      attempts.push(`fetch ${String(args[0])}`);
      throw new Error('fetch blocked by test');
    };
    try {
      const { contract } = await import('@stellar/stellar-sdk');
      await contract.Client.deploy(null, {
        wasmHash: Buffer.alloc(32).toString('hex'),
        networkPassphrase: svm.networkPassphrase,
        // A REAL host, so a leak is a real socket rather than a DNS failure.
        rpcUrl: 'https://soroban-testnet.stellar.org',
        publicKey: alice.publicKey,
        server: server as any,
      } as any).catch(() => undefined);
    } finally {
      net.Socket.prototype.connect = realConnect;
      (globalThis as any).fetch = realFetch;
    }
    expect(attempts, 'Client.deploy went to the network').toEqual([]);
  });

  it('the app-facing Address helpers never need the network', async () => {
    expect(Address.fromString(cd.contractId).toString()).toBe(cd.contractId);
  });
});
