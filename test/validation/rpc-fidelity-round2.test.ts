/**
 * DIMENSION: `src/fake-rpc.ts`, round 2.
 *
 * `test/validation/rpc-live-parity.test.ts` already pins the getEvents id
 * format, the topic filters, the zero LedgerHeader, the fee model and the
 * friendbot starting sequence. This file deliberately does NOT repeat any of
 * those. It covers what that pass left unexamined:
 *
 *   1. requestAirdrop against an account that ALREADY exists.
 *   2. The two fee-bump arms of errorResultXdr — the only two of the 14
 *      TxResultCodes that `rpc-surface.test.ts` never exercises.
 *   3. simulateTransaction for the envelopes that are not a bare
 *      InvokeHostFunction (fee bump, ExtendFootprintTTL, RestoreFootprint).
 *   4. getEvents endLedger.
 *   5. getLedgers cursor arithmetic and timestamp JSON types.
 *   6. getNetwork.protocolVersion's JSON type.
 *   7. The NOT_FOUND shape of getTransaction.
 *   8. Whether resultMetaXdr decodes into anything an app can read.
 *
 * Every "LIVE:" comment is a payload captured from http://localhost:8000/rpc
 * (stellar-rpc 27.1.1 / captive-core v27.1.0, passphrase
 * "Standalone Network ; February 2017") on 2026-08-18, or from that node's
 * friendbot at http://localhost:8000/friendbot.
 *
 * RED by design.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Keypair,
  Operation,
  TransactionBuilder,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, type Wallet, type Contract } from '../../src/litestellar.js';
import { invokeHostFn } from '../../src/index.js';

const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

const CONTRACT_DATA = fixture('contract_data.wasm');
/** Publishes a contract event on every call. */
const ADD_I32 = fixture('add_i32.wasm');

let svm: LiteStellar;
let alice: Wallet;
let server: rpc.Server;
let cd: Contract;

/** Speak raw JSON-RPC to the adapter, so field NAMES and TYPES stay visible. */
async function jsonRpc(method: string, params?: unknown): Promise<any> {
  const adapter = (server as any).httpClient.defaults.adapter;
  const res = await adapter({
    url: 'https://in-process.invalid',
    data: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.data.result ?? res.data.error;
}

const invokeOp = (c: Contract, fn: string, args: xdr.ScVal[]) =>
  Operation.invokeHostFunction({ func: invokeHostFn(c.address, fn, args), auth: [] });

async function buildTx(w: Wallet, op: xdr.Operation, fee = '100') {
  const account = await server.getAccount(w.publicKey);
  return new TransactionBuilder(account, { fee, networkPassphrase: svm.networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

/** simulate -> assemble -> sign -> send, the way an app does it. */
async function submit(w: Wallet, c: Contract, fn: string, args: xdr.ScVal[], extra: Keypair[] = []) {
  const tx = await buildTx(w, invokeOp(c, fn, args));
  const sim = await server.simulateTransaction(tx);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(w.keypair, ...extra);
  return server.sendTransaction(assembled);
}

beforeEach(() => {
  svm = new LiteStellar().withNetworkCostParams();
  alice = svm.airdrop();
  server = svm.rpcServer();
  cd = svm.deployContract(CONTRACT_DATA, { as: alice });
});

// ---------------------------------------------------------------------------
// 1. requestAirdrop against an account that already exists
// ---------------------------------------------------------------------------

describe('requestAirdrop on an ALREADY-FUNDED account', () => {
  it('is refused, the way the real friendbot refuses it', async () => {
    // LIVE, second call for the same G... address:
    //   HTTP 400
    //   {"type":"https://stellar.org/friendbot-errors/bad_request",
    //    "title":"Bad Request","status":400,
    //    "detail":"account already funded to starting balance"}
    // The adapter calls ledger.fund() unconditionally and answers 200, so the
    // "top up my test account" call that fails loudly on every real network
    // silently succeeds here.
    await submit(alice, cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const before = svm.getAccount(alice.publicKey)!;
    const seqBefore = BigInt(before.seqNum().toString());
    expect(seqBefore, 'fixture must have moved the sequence').toBeGreaterThan(0n);

    let refused = false;
    try {
      await server.requestAirdrop(alice.publicKey);
    } catch {
      refused = true;
    }
    expect(refused, 'a second airdrop for a funded account was accepted').toBe(true);
  });

  it('does not rewind the sequence number of an account that has transacted', async () => {
    // A sequence number only ever moves forward on a real network. fundAccount()
    // (classic.ts:113) builds a BRAND NEW AccountEntry — `seqNum: opts.seqNum ?? 0n`
    // — and storeAccount() overwrites the existing one, so every envelope the
    // account already spent becomes replayable.
    await submit(alice, cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const seqBefore = alice.sequence();
    expect(seqBefore).toBeGreaterThan(0n);

    await server.requestAirdrop(alice.publicKey).catch(() => undefined);

    expect(
      alice.sequence(),
      `sequence went ${seqBefore} -> ${alice.sequence()}: already-spent envelopes replay`,
    ).toBeGreaterThanOrEqual(seqBefore);
  });

  it('does not silently strip the signers and thresholds of a multisig account', async () => {
    // The sharpest edge. fundAccount() rebuilds the entry with
    //   thresholds: opts.thresholds ?? [1, 0, 0, 0]
    //   signers:    (opts.signers ?? [])
    // and the adapter passes NEITHER, so one requestAirdrop turns a 2-of-2
    // account into a 1-of-1 account. A transaction that this ledger correctly
    // rejected with txBAD_AUTH a moment earlier is accepted afterwards.
    const cosigner = Keypair.random();
    const multisig = svm.airdrop(100_000_000_000n, {
      thresholds: [1, 1, 2, 2], // master weight 1, medium threshold 2
      signers: [{ key: cosigner.publicKey(), weight: 1 }],
    });

    // Control: with the master key alone the weight is 1 < 2, so this is
    // rejected — proving the multisig policy is genuinely in force.
    const lone = await submit(multisig, cd, 'put_persistent', [sc.sym('m1'), sc.u64(1n)]);
    expect(lone.status, 'fixture is not actually multisig').toBe('ERROR');

    await server.requestAirdrop(multisig.publicKey).catch(() => undefined);

    const after = svm.getAccount(multisig.publicKey)!;
    expect(
      { signers: after.signers().length, thresholds: [...after.thresholds()] },
      'requestAirdrop downgraded a 2-of-2 account to 1-of-1',
    ).toEqual({ signers: 1, thresholds: [1, 1, 2, 2] });
  });

  it('does not turn a rejected single-signature transaction into an accepted one', async () => {
    // The same defect stated as the authorization decision it changes, rather
    // than as the fields it rewrites: the identical lone-master-key envelope is
    // txBAD_AUTH before the airdrop and applies afterwards.
    const cosigner = Keypair.random();
    const multisig = svm.airdrop(100_000_000_000n, {
      thresholds: [1, 1, 2, 2],
      signers: [{ key: cosigner.publicKey(), weight: 1 }],
    });

    const before = await submit(multisig, cd, 'put_persistent', [sc.sym('m2'), sc.u64(1n)]);
    expect(before.status, 'fixture is not actually multisig').toBe('ERROR');

    await server.requestAirdrop(multisig.publicKey).catch(() => undefined);

    const after = await submit(multisig, cd, 'put_persistent', [sc.sym('m2'), sc.u64(1n)]);
    expect(
      after.status,
      'a lone master-key signature was rejected, then accepted after an airdrop',
    ).toBe('ERROR');
  });

  it('does not reset the balance of an account that already holds more', async () => {
    // LIVE friendbot pays a fixed 10,000 XLM starting balance to accounts that
    // do NOT exist and refuses the rest; it never *assigns* a balance. Here the
    // entry is rewritten wholesale, so an account deliberately funded with a
    // large balance is silently trimmed back to 10,000 XLM.
    const whale = svm.airdrop(900_000n * 10_000_000n); // 900,000 XLM
    const before = whale.balance();
    await server.requestAirdrop(whale.publicKey).catch(() => undefined);
    expect(
      whale.balance(),
      `balance went ${before} -> ${whale.balance()}`,
    ).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. the fee-bump arms of errorResultXdr / resultXdr
// ---------------------------------------------------------------------------

describe('fee-bump transaction results', () => {
  /** A signed inner Soroban tx plus a fee bump wrapping it. */
  async function feeBumped() {
    const sponsor = svm.airdrop();
    const tx = await buildTx(alice, invokeOp(cd, 'put_persistent', [sc.sym('fb'), sc.u64(7n)]));
    const sim = await server.simulateTransaction(tx);
    const inner = rpc.assembleTransaction(tx, sim).build();
    inner.sign(alice.keypair);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsor.keypair,
      '2000000',
      inner,
      svm.networkPassphrase,
    );
    bump.sign(sponsor.keypair);
    return { inner, bump };
  }

  it('the InnerTransactionResultPair carries the INNER transaction hash', async () => {
    // GROUND TRUTH, stellar-core MutableTransactionResult.cpp:333
    //   innerResultPair.transactionHash = innerTx.getContentsHash();
    // fake-rpc.ts:83-84 passes the hash of the FEE BUMP instead — the same
    // `txHash` it computed from the outer envelope at line 497. The inner hash
    // is the only handle an app has on the transaction it originally built and
    // may already have persisted, so this substitutes an id that matches
    // nothing the app knows.
    const { inner, bump } = await feeBumped();
    const sent = await jsonRpc('sendTransaction', { transaction: bump.toXDR() });
    expect(sent.status, JSON.stringify(sent)).toBe('PENDING');

    const got = await jsonRpc('getTransaction', { hash: sent.hash });
    const result = xdr.TransactionResult.fromXDR(got.resultXdr, 'base64');
    expect(result.result().switch().name).toBe('txFeeBumpInnerSuccess');

    const carried = result.result().innerResultPair().transactionHash().toString('hex');
    expect(carried, `carried the fee-bump hash ${bump.hash().toString('hex')}`).toBe(
      inner.hash().toString('hex'),
    );
  });

  it('the inner result reports the fee that was charged', async () => {
    // GROUND TRUTH, MutableTransactionResult.cpp:335
    //   innerResult.feeCharged = innerFeeCharged;
    // fake-rpc.ts:86 hardcodes `feeCharged: new xdr.Int64(0n)`, so an app
    // reconciling what a sponsored transaction cost reads 0 for every fee bump.
    const { bump } = await feeBumped();
    const sent = await jsonRpc('sendTransaction', { transaction: bump.toXDR() });
    const got = await jsonRpc('getTransaction', { hash: sent.hash });
    const inner = xdr.TransactionResult.fromXDR(got.resultXdr, 'base64')
      .result()
      .innerResultPair()
      .result();
    expect(inner.feeCharged().toBigInt(), 'inner feeCharged is hardcoded 0').toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// 3. simulateTransaction for envelopes that are not a bare InvokeHostFunction
// ---------------------------------------------------------------------------

describe('simulateTransaction envelope coverage', () => {
  const instanceKey = () =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: cd.address,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

  it('simulates an ExtendFootprintTTL transaction', async () => {
    // LIVE, same op against the standalone node:
    //   {"transactionData":"AAAAAAAA...tug=","minResourceFee":"46824",
    //    "latestLedger":17117}
    // fake-rpc.ts:452 does `op.body().invokeHostFunctionOp()` unconditionally,
    // so the union accessor throws for any other Soroban op. Every state-archival
    // flow starts by simulating exactly this transaction to price it.
    const account = await server.getAccount(alice.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: svm.networkPassphrase,
      sorobanData: new SorobanDataBuilder().setReadOnly([instanceKey()]).build(),
    })
      .addOperation(Operation.extendFootprintTtl({ extendTo: 100_000 }))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationError(sim) ? sim.error : 'ok').toBe('ok');
  });

  it('simulates a RestoreFootprint transaction', async () => {
    // LIVE: {"transactionData":"AAAAAAAA...tqE=","minResourceFee":"46753",
    //        "latestLedger":17117}
    const account = await server.getAccount(alice.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: svm.networkPassphrase,
      sorobanData: new SorobanDataBuilder().setReadWrite([instanceKey()]).build(),
    })
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationError(sim) ? sim.error : 'ok').toBe('ok');
  });

  it('simulates a fee-bump envelope by unwrapping the inner transaction', async () => {
    // LIVE: a fee bump wrapping the ExtendFootprintTTL above simulated fine and
    // returned the INNER transaction's numbers — minResourceFee "46824",
    // identical to simulating the inner tx alone.
    // fake-rpc.ts:449-450 does `env.v1()` on the envelope union, which throws
    // for ENVELOPE_TYPE_TX_FEE_BUMP. `rpc.Server.simulateTransaction` accepts
    // `Transaction | FeeBumpTransaction` in its own signature.
    const account = await server.getAccount(alice.publicKey);
    const inner = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(invokeOp(cd, 'put_persistent', [sc.sym('k'), sc.u64(1n)]))
      .setTimeout(30)
      .build();
    inner.sign(alice.keypair);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      alice.keypair,
      '2000000',
      inner,
      svm.networkPassphrase,
    );

    const sim = await server.simulateTransaction(bump);
    expect(rpc.Api.isSimulationError(sim) ? sim.error : 'ok').toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 4. getEvents endLedger
// ---------------------------------------------------------------------------

describe('getEvents range', () => {
  it('honours endLedger', async () => {
    // LIVE: {"startLedger":7,"endLedger":10,...} returned events from ledgers
    // [7, 9] ONLY, although the node holds events all the way to 16823.
    // fake-rpc.ts:369 reads `params?.startLedger` and nothing else, so the
    // upper bound of a bounded backfill window is silently ignored and the
    // caller is handed events from ledgers it explicitly excluded.
    const add = svm.deployContract(ADD_I32, { as: alice });
    await submit(alice, add, 'add', [sc.i32(1), sc.i32(1)]);
    const firstLedger = svm.ledgerSequence;
    svm.advanceLedgers(5);
    await submit(alice, add, 'add', [sc.i32(2), sc.i32(2)]);

    const res = await jsonRpc('getEvents', {
      startLedger: 1,
      endLedger: firstLedger,
      filters: [],
    });
    const beyond = (res.events ?? []).filter((e: any) => e.ledger > firstLedger);
    expect(
      beyond.map((e: any) => e.ledger),
      `endLedger ${firstLedger} was ignored`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. getLedgers cursor arithmetic and JSON types
// ---------------------------------------------------------------------------

describe('getLedgers paging contract', () => {
  it('the cursor is the LAST ledger returned, not the one after it', async () => {
    // LIVE {"startLedger":16780,"pagination":{"limit":2}}:
    //   ledgers 16780, 16781   ->   "cursor":"16781"
    // i.e. the cursor names the last row, and the next page resumes AFTER it.
    // fake-rpc.ts:423 returns `String(start + count)` = 16782, one too far, so
    // an app that pages with `cursor` drops one ledger at every page boundary.
    const start = svm.ledgerSequence;
    svm.advanceLedgers(5);
    const res = await jsonRpc('getLedgers', { startLedger: start, pagination: { limit: 2 } });
    const last = res.ledgers[res.ledgers.length - 1].sequence;
    expect(res.cursor, `cursor ${res.cursor} skips ledger ${last + 1}`).toBe(String(last));
  });

  it('reports latestLedgerCloseTime/oldestLedgerCloseTime as JSON numbers', async () => {
    // LIVE: "latestLedgerCloseTime":1787036581  and
    //       "oldestLedgerCloseTime":1786998313   -- NUMBERS, while the per-row
    // "ledgerCloseTime":"1787036560" is a STRING. The real API really is
    // inconsistent here; the fake picks the string form for all three, so
    // `res.latestLedgerCloseTime - res.oldestLedgerCloseTime` is NaN-adjacent
    // arithmetic against a real node and string concatenation here.
    const res = await jsonRpc('getLedgers', {
      startLedger: svm.ledgerSequence,
      pagination: { limit: 1 },
    });
    expect({
      latest: typeof res.latestLedgerCloseTime,
      oldest: typeof res.oldestLedgerCloseTime,
      row: typeof res.ledgers[0].ledgerCloseTime,
    }).toEqual({ latest: 'number', oldest: 'number', row: 'string' });
  });
});

// ---------------------------------------------------------------------------
// 6. getNetwork
// ---------------------------------------------------------------------------

describe('getNetwork', () => {
  it('reports protocolVersion as a JSON number', async () => {
    // LIVE: {"friendbotUrl":"http://localhost:8000/friendbot",
    //        "passphrase":"Standalone Network ; February 2017",
    //        "protocolVersion":27}          <- NUMBER
    // fake-rpc.ts:327 emits `String(ledger.protocolVersion)`. Any app gate of
    // the form `if (net.protocolVersion >= 23)` compares a string to a number:
    // "27" >= 23 is true by coercion, but "9" >= 23 would be false and
    // `protocolVersion === 27` is false either way.
    const net = await jsonRpc('getNetwork');
    expect(typeof net.protocolVersion, `got ${JSON.stringify(net.protocolVersion)}`).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 7. getTransaction NOT_FOUND
// ---------------------------------------------------------------------------

describe('getTransaction NOT_FOUND', () => {
  it('echoes the hash that was asked about', async () => {
    // LIVE, unknown hash:
    //   {"latestLedger":17005,"latestLedgerCloseTime":"1787036785",
    //    "oldestLedger":7,"oldestLedgerCloseTime":"1786998313",
    //    "status":"NOT_FOUND",
    //    "txHash":"aaaa...aaaa",          <- echoed
    //    "applicationOrder":0,"feeBump":false,"events":{},
    //    "ledger":0,"createdAt":"0"}
    // fake-rpc.ts:564 returns the four retention fields plus `status` and
    // nothing else.
    //
    // NOTE, verified in the SDK rather than assumed: server.js:756 sets
    // `txHash: hash` from the ARGUMENT, so `server.getTransaction()` masks this
    // particular omission. The divergence is real only for a consumer reading
    // the JSON-RPC payload directly — another SDK, a proxy, a recorded fixture
    // replayed against a real node — which is exactly what this adapter invites
    // by claiming to be stellar-rpc on the wire.
    const unknown = 'a'.repeat(64);
    const got = await jsonRpc('getTransaction', { hash: unknown });
    expect(got.status).toBe('NOT_FOUND');
    expect(got.txHash, `keys: ${JSON.stringify(Object.keys(got))}`).toBe(unknown);
  });

  it('carries the placeholder ledger/createdAt/events fields', async () => {
    // Same LIVE payload as above: `events` is `{}`, not absent, and `ledger`
    // and `createdAt` are present as 0 / "0". Unlike `txHash`, the SDK does NOT
    // backfill these — server.js:751 skips parseTransactionInfo entirely for
    // NOT_FOUND — so `resp.events` is `undefined` here and `{}` on a real node,
    // and `const { contractEventsXdr = [] } = resp.events` throws while the
    // transaction is still pending.
    const got = await jsonRpc('getTransaction', { hash: 'b'.repeat(64) });
    expect(Object.keys(got)).toEqual(
      expect.arrayContaining(['events', 'ledger', 'createdAt', 'applicationOrder', 'feeBump']),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. resultMetaXdr
// ---------------------------------------------------------------------------

describe('the transaction meta a successful submit produces', () => {
  it('records the ledger entries the transaction wrote', async () => {
    // LIVE resultMetaXdr for a CreateAccount decodes to TransactionMetaV4 whose
    // operations[0].changes holds the LedgerEntryChange list (state/created/
    // updated) — that is where every balance-delta and "what did this write"
    // reader looks, including the SDK's own
    // findCreatedAccountSequenceInTransactionMeta.
    // fake-rpc.ts:112-123 builds V4 with `operations: []`, `txChangesBefore: []`
    // and `txChangesAfter: []`, so the meta is structurally valid and
    // semantically empty. The adapter's own friendbot branch (line 279) proves
    // the point: it has to hand-build an operations[] entry precisely because
    // transactionMeta() never produces one.
    const sent = await submit(alice, cd, 'put_persistent', [sc.sym('meta'), sc.u64(1n)]);
    const got = await jsonRpc('getTransaction', { hash: sent.hash });
    const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
    expect(meta.switch()).toBe(4);
    const changes = meta
      .v4()
      .operations()
      .flatMap((o) => o.changes());
    expect(changes.length, 'the meta records no ledger changes at all').toBeGreaterThan(0);
  });

  it('carries the contract events in the meta, not only in the events field', async () => {
    // The adapter reports the same events twice through different channels:
    // `events.contractEventsXdr` (populated) and the meta's
    // operations[i].events (always empty, because operations is empty). An app
    // that reads events out of resultMetaXdr — which is what every pre-RPC-22
    // integration and every Horizon-shaped consumer does — sees none.
    const add = svm.deployContract(ADD_I32, { as: alice });
    const sent = await submit(alice, add, 'add', [sc.i32(7), sc.i32(35)]);
    const got = await jsonRpc('getTransaction', { hash: sent.hash });

    const viaEventsField = (got.events?.contractEventsXdr ?? []).flat().length;
    const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
    const viaMeta = meta
      .v4()
      .operations()
      .flatMap((o) => o.events()).length;

    expect(
      { viaMeta, viaEventsField },
      'the same transaction reports different event counts through the two channels',
    ).toEqual({ viaMeta: viaEventsField, viaEventsField });
  });
});
