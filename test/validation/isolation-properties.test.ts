/**
 * PROPERTY-STYLE VALIDATION OF THE CORE ISOLATION PROMISES.
 *
 * Everything random here comes from one hardcoded-seed LCG, so a failure is
 * reproducible by re-running the file. Nothing depends on wall-clock time,
 * `Math.random`, or test ordering.
 *
 * Expected values are derived from the pinned host / stellar-core, not from
 * what this harness returns:
 *
 *   - `LedgerInfo::min_live_until_ledger_checked`
 *     (soroban-env-host-27.0.1/src/ledger_info.rs:16) —
 *     `live_until = sequence_number + min_ttl - 1`, with
 *     `min_persistent_entry_ttl = 100_000` and `min_temp_entry_ttl = 16`
 *     as configured in crates/host-wasm/src/lib.rs `ledger_info()`.
 *   - `Storage::handle_maybe_expired_entry` (src/storage.rs:723) — a temporary
 *     entry whose `live_until < sequence_number` reads back as ABSENT.
 *   - `HerderSCPDriver::checkCloseTime` (core-src/src/herder/HerderSCPDriver.cpp:280)
 *     — `closeTime <= lastCloseTime` is invalid, i.e. the ledger clock is
 *     strictly increasing on a real network.
 *   - `AuthorizationTracker::new_recording` (src/auth.rs:2437-2446) — the auth
 *     nonce is drawn from the base PRNG seed, so it must differ between two
 *     simulations of the same invocation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import type { SimulateResult, SendResult } from '../../src/index.js';
import { accountIdFromPublicKey, accountKey } from '../../src/classic.js';
import { attachInProcessRpc } from '../../src/fake-rpc.js';
import { preFundedWallet, deployToken, establishTrustline } from '../../src/fixtures.js';
import { signAuthEntries, smartAccountEd25519 } from '../../src/auth.js';

// ---------------------------------------------------------------------------
// ground-truth constants (crates/host-wasm/src/lib.rs `ledger_info()`)
// ---------------------------------------------------------------------------
const MIN_PERSISTENT_ENTRY_TTL = 100_000;
const MIN_TEMP_ENTRY_TTL = 16;
/** `advanceLedgers` models a 5-second ledger close interval. */
const SECONDS_PER_LEDGER = 5;
/** `new Ledger()` defaults, from src/index.ts and lib.rs. */
const START_SEQ = 1_000_000;
const START_TS = 1_700_000_000;

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const SMART_ACCOUNT = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/smart_account.wasm', import.meta.url))),
);

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

// ---------------------------------------------------------------------------
// hardcoded-seed LCG (Numerical Recipes constants) — reproducible by design
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  return {
    int: (n: number) => next() % n,
    pick: <T>(xs: readonly T[]): T => xs[next() % xs.length],
    u64: () => BigInt(next()),
  };
}

// ---------------------------------------------------------------------------
// GAP WORKAROUND: the harness cannot enumerate its own entries.
//
// `Ledger` exposes `entryCount()`, `getEntry(key)` and `getEntryTtl(key)` but
// nothing that lists the keys, and the underlying `BTreeMap` is private to the
// wasm side. So a property test cannot ask "is the whole ledger identical?".
// The workaround below accumulates every key the harness itself reports through
// `SendResult.changedKeys` / `removedKeys`, plus the keys we seeded, and treats
// that set as the observable ledger.
// ---------------------------------------------------------------------------
const ABSENT = '<absent>|ttl=<none>';

class KeySet {
  readonly keys = new Set<string>();
  add(...ks: string[]) {
    for (const k of ks) this.keys.add(k);
  }
  observe(sent: SendResult) {
    this.add(...sent.changedKeys, ...sent.removedKeys);
  }
  /** entry XDR + TTL for every key we have ever touched, plus the count. */
  capture(L: Ledger): { count: number; entries: Map<string, string> } {
    const entries = new Map<string, string>();
    for (const k of this.keys) {
      const e = L.getEntry(k);
      entries.set(
        k,
        e === undefined ? ABSENT : `${e}|ttl=${L.getEntryTtl(k) ?? '<none>'}`,
      );
    }
    return { count: L.entryCount(), entries };
  }
}

/**
 * `after` may track MORE keys than `before` — the KeySet grows as later ops
 * report new keys. Every key both captures know about must match exactly, and
 * every key that only `after` knows about must read as absent: that is the
 * "no leak" half of the property.
 */
function expectSameState(
  before: { count: number; entries: Map<string, string> },
  after: { count: number; entries: Map<string, string> },
  what: string,
) {
  expect(after.count, `${what}: entryCount changed`).toBe(before.count);
  for (const [k, v] of before.entries) {
    expect(after.entries.get(k), `${what}: entry ${k.slice(0, 28)}… differs`).toBe(v);
  }
  for (const [k, v] of after.entries) {
    if (before.entries.has(k)) continue;
    expect(v, `${what}: key ${k.slice(0, 28)}… leaked past the snapshot point`).toBe(ABSENT);
  }
}

// ---------------------------------------------------------------------------
// a deterministic world: contract_data.wasm deployed from a seeded account
// ---------------------------------------------------------------------------
interface World {
  L: Ledger;
  source: string;
  addr: xdr.ScAddress;
  seen: KeySet;
}

function freshWorld(): World {
  const L = new Ledger();
  const source = L.fundAccount(1);
  const wasmHash = L.seedWasm(CONTRACT_DATA);

  const seen = new KeySet();
  seen.add(accountKey(xdr.AccountId.fromXDR(source, 'base64')).toXDR('base64'));
  seen.add(
    xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'base64') }),
    ).toXDR('base64'),
  );

  const { sent } = L.simulateAndSend(createContractHostFn(source, wasmHash), source);
  expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
  seen.observe(sent);

  return { L, source, addr: xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address(), seen };
}

// ---------------------------------------------------------------------------
// the random op machine
// ---------------------------------------------------------------------------
const KEY_POOL = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

interface Model {
  persistent: Map<string, bigint>;
  temporary: Map<string, bigint>;
  instance: Map<string, bigint>;
}
const emptyModel = (): Model => ({
  persistent: new Map(),
  temporary: new Map(),
  instance: new Map(),
});

interface Op {
  label: string;
  fn: xdr.HostFunction;
  apply(m: Model): void;
}

/** Draw one op that is guaranteed to succeed against the current model. */
function nextOp(rng: ReturnType<typeof makeRng>, addr: xdr.ScAddress, m: Model): Op {
  const kinds = ['put_persistent', 'put_temporary', 'put_instance', 'del', 'extend'] as const;
  const kind = rng.pick(kinds);
  const k = rng.pick(KEY_POOL);
  const v = rng.u64();

  if (kind === 'del' && m.persistent.size > 0) {
    const victim = [...m.persistent.keys()][rng.int(m.persistent.size)];
    return {
      label: `del_persistent(${victim})`,
      fn: invokeHostFn(addr, 'del_persistent', [sym(victim)]),
      apply: (mm) => void mm.persistent.delete(victim),
    };
  }
  if (kind === 'extend' && m.persistent.size > 0) {
    const target = [...m.persistent.keys()][rng.int(m.persistent.size)];
    // Threshold above the entry's current TTL so the extension really happens,
    // and extend_to strictly above the threshold so the TTL actually moves.
    const threshold = MIN_PERSISTENT_ENTRY_TTL + 10_000 + rng.int(5_000);
    const extendTo = threshold + 20_000 + rng.int(5_000);
    return {
      label: `extend_persistent(${target}, ${threshold}, ${extendTo})`,
      fn: invokeHostFn(addr, 'extend_persistent', [sym(target), u32(threshold), u32(extendTo)]),
      apply: () => {},
    };
  }
  if (kind === 'put_temporary') {
    return {
      label: `put_temporary(${k})`,
      fn: invokeHostFn(addr, 'put_temporary', [sym(k), u64(v)]),
      apply: (mm) => void mm.temporary.set(k, v),
    };
  }
  if (kind === 'put_instance') {
    return {
      label: `put_instance(${k})`,
      fn: invokeHostFn(addr, 'put_instance', [sym(k), u64(v)]),
      apply: (mm) => void mm.instance.set(k, v),
    };
  }
  return {
    label: `put_persistent(${k})`,
    fn: invokeHostFn(addr, 'put_persistent', [sym(k), u64(v)]),
    apply: (mm) => void mm.persistent.set(k, v),
  };
}

interface StepRecord {
  label: string;
  sim: SimulateResult;
  sent: SendResult;
}

function runOps(w: World, rng: ReturnType<typeof makeRng>, m: Model, n: number): StepRecord[] {
  const out: StepRecord[] = [];
  for (let i = 0; i < n; i++) {
    const op = nextOp(rng, w.addr, m);
    const { sim, sent } = w.L.simulateAndSend(op.fn, w.source);
    expect(sent.ok, `${op.label} failed: ${sent.error}`).toBe(true);
    op.apply(m);
    w.seen.observe(sent);
    out.push({ label: op.label, sim, sent });
  }
  return out;
}

/** Read a persistent key back through the host; undefined when absent. */
function readPersistent(w: World, key: string): bigint | undefined {
  const r = w.L.simulate(invokeHostFn(w.addr, 'get_persistent', [sym(key)]), w.source);
  if (!r.ok) return undefined;
  return scValToNative(xdr.ScVal.fromXDR(r.returnValueXdr!, 'base64')) as bigint;
}

/** Trustline LedgerKey for a <=4-character credit asset. */
function trustlineKey(holder: { accountId: xdr.AccountId }, asset: Asset): string {
  const code = asset.getCode();
  expect(code.length).toBeLessThanOrEqual(4);
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: holder.accountId,
      asset: xdr.TrustLineAsset.assetTypeCreditAlphanum4(
        new xdr.AlphaNum4({
          assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(4)], 4),
          issuer: accountIdFromPublicKey(asset.getIssuer()),
        }),
      ),
    }),
  ).toXDR('base64');
}

function contractDataKey(
  addr: xdr.ScAddress,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract: addr, key, durability }),
  ).toXDR('base64');
}

// ===========================================================================
// A. snapshot / restore
// ===========================================================================
describe('property: snapshot/restore is exact', () => {
  it('restores every touched entry byte-for-byte after 20 more random ops', () => {
    const w = freshWorld();
    const rng = makeRng(0xc0ffee);
    const model = emptyModel();

    runOps(w, rng, model, 20);

    const snap = w.L.snapshot();
    const atSnapshot = w.seen.capture(w.L);
    const modelAtSnapshot: Model = {
      persistent: new Map(model.persistent),
      temporary: new Map(model.temporary),
      instance: new Map(model.instance),
    };

    runOps(w, rng, model, 20);
    // The 20 extra ops must actually have moved the ledger, or the test is void.
    const drifted = w.seen.capture(w.L);
    expect(
      drifted.count !== atSnapshot.count ||
        [...atSnapshot.entries].some(([k, v]) => drifted.entries.get(k) !== v),
      'the second batch of ops did not change anything — test would be vacuous',
    ).toBe(true);

    w.L.restore(snap);

    expectSameState(atSnapshot, w.seen.capture(w.L), 'after restore');

    // ...and the host agrees, not just the raw map.
    for (const [k, v] of modelAtSnapshot.persistent) {
      expect(readPersistent(w, k), `persistent ${k} after restore`).toBe(v);
    }
    for (const k of KEY_POOL) {
      if (!modelAtSnapshot.persistent.has(k)) {
        expect(readPersistent(w, k), `persistent ${k} should be absent`).toBeUndefined();
      }
    }
  });

  it('nested snapshots: restoring A leaves B holding what B captured', () => {
    const w = freshWorld();
    const rng = makeRng(0x5eed01);
    const model = emptyModel();

    runOps(w, rng, model, 6);
    const a = w.L.snapshot();
    const atA = w.seen.capture(w.L);

    runOps(w, rng, model, 6);
    const b = w.L.snapshot();
    const atB = w.seen.capture(w.L);

    runOps(w, rng, model, 6);

    expect(a).not.toBe(b);

    w.L.restore(a);
    expectSameState(atA, w.seen.capture(w.L), 'restore(A)');

    // B was taken later; restoring A must not have invalidated it.
    w.L.restore(b);
    expectSameState(atB, w.seen.capture(w.L), 'restore(B) after restore(A)');

    // ...and A is still usable afterwards: snapshots are not consumed.
    w.L.restore(a);
    expectSameState(atA, w.seen.capture(w.L), 'restore(A) again');
  });

  it('restore does not leak: a key written only after the snapshot vanishes', () => {
    const w = freshWorld();
    const rng = makeRng(0xabcdef);
    const model = emptyModel();
    runOps(w, rng, model, 5);

    const snap = w.L.snapshot();

    const leakKey = 'zz_after_snapshot';
    const { sent } = w.L.simulateAndSend(
      invokeHostFn(w.addr, 'put_persistent', [sym(leakKey), u64(777n)]),
      w.source,
    );
    expect(sent.ok).toBe(true);
    const rawKey = contractDataKey(
      w.addr,
      sym(leakKey),
      xdr.ContractDataDurability.persistent(),
    );
    expect(w.L.getEntry(rawKey)).toBeDefined();
    expect(readPersistent(w, leakKey)).toBe(777n);

    w.L.restore(snap);

    // 1. gone from the raw map
    expect(w.L.getEntry(rawKey), 'post-snapshot key survived restore').toBeUndefined();
    expect(w.L.getEntryTtl(rawKey)).toBeUndefined();
    // 2. and invisible to the host on a subsequent simulate
    expect(readPersistent(w, leakKey), 'host still sees the rolled-back key').toBeUndefined();
    const has = w.L.simulate(
      invokeHostFn(w.addr, 'has_persistent', [sym(leakKey)]),
      w.source,
    );
    expect(has.ok, has.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(false);
  });

  it('restore() rolls back ledgerSeq and timestamp, not just the entry map', () => {
    // `snapshot()` is documented as "Snapshot the entire ledger"
    // (crates/host-wasm/src/lib.rs:324). ledgerSeq and timestamp ARE ledger
    // state — they are two of the eight fields of `LedgerInfo`
    // (soroban-env-host-27.0.1/src/ledger_info.rs:22-32) and they decide every
    // TTL and every timebound. A snapshot that omits them is not a snapshot of
    // the ledger.
    const w = freshWorld();
    const rng = makeRng(0x1234);
    runOps(w, rng, emptyModel(), 3);

    const seqAtSnapshot = w.L.ledgerSeq;
    const tsAtSnapshot = w.L.timestamp;
    const snap = w.L.snapshot();

    w.L.advanceLedgers(250_000); // well past a fresh persistent entry's TTL
    expect(w.L.ledgerSeq).toBe(seqAtSnapshot + 250_000);

    w.L.restore(snap);

    expect(w.L.ledgerSeq, 'restore did not roll back ledgerSeq').toBe(seqAtSnapshot);
    expect(w.L.timestamp, 'restore did not roll back timestamp').toBe(tsAtSnapshot);
  });

  it('a restored ledger BEHAVES like the ledger that was snapshotted', () => {
    // The consequence of the gap above, in the form a test author would hit it:
    // roll forward past a TTL, roll back, and the entry is in the map but the
    // host still considers it expired, because the clock stayed in the future.
    const w = freshWorld();
    w.L.simulateAndSend(invokeHostFn(w.addr, 'put_temporary', [sym('t'), u64(42n)]), w.source);
    const tKey = contractDataKey(w.addr, sym('t'), xdr.ContractDataDurability.temporary());

    const snap = w.L.snapshot();
    const liveAtSnapshot = w.L.simulate(
      invokeHostFn(w.addr, 'has_temporary', [sym('t')]),
      w.source,
    );
    expect(scValToNative(xdr.ScVal.fromXDR(liveAtSnapshot.returnValueXdr!, 'base64'))).toBe(true);

    w.L.advanceLedgers(1_000); // past MIN_TEMP_ENTRY_TTL
    w.L.restore(snap);

    // The raw entry really did come back — so any difference is the clock.
    expect(w.L.getEntry(tKey), 'the entry itself was not restored').toBeDefined();
    expect(w.L.getEntryTtl(tKey)).toBe(START_SEQ + MIN_TEMP_ENTRY_TTL - 1);

    const afterRestore = w.L.simulate(
      invokeHostFn(w.addr, 'has_temporary', [sym('t')]),
      w.source,
    );
    expect(afterRestore.ok, afterRestore.error).toBe(true);
    expect(
      scValToNative(xdr.ScVal.fromXDR(afterRestore.returnValueXdr!, 'base64')),
      'a live temporary entry read back as expired after restore',
    ).toBe(true);
  });

  it('restoring an id that was never handed out throws', () => {
    const L = new Ledger();
    expect(() => L.restore(0)).toThrow();
    const id = L.snapshot();
    expect(() => L.restore(id + 1)).toThrow();
  });

  it('simulate() never mutates the ledger, however it ends', () => {
    // lib.rs:341 — "Does NOT mutate the ledger". Recording mode writes into an
    // in-memory storage map (auto-restoring expired persistent entries, and
    // consuming auth nonces) and none of that may reach the store.
    const w = freshWorld();
    runOps(w, makeRng(0x515), emptyModel(), 8);
    // Age the ledger so at least one persistent entry is past its TTL, which is
    // the case that makes recording mode mark it READ-WRITE (storage.rs:748).
    w.L.advanceLedgers(MIN_PERSISTENT_ENTRY_TTL + 10);
    const before = w.seen.capture(w.L);

    for (const k of KEY_POOL) {
      w.L.simulate(invokeHostFn(w.addr, 'get_persistent', [sym(k)]), w.source);
      w.L.simulate(invokeHostFn(w.addr, 'has_persistent', [sym(k)]), w.source);
      w.L.simulate(invokeHostFn(w.addr, 'get_temporary', [sym(k)]), w.source);
    }
    // ...including simulations that would write, and ones that fail outright.
    w.L.simulate(invokeHostFn(w.addr, 'put_persistent', [sym('phantom'), u64(1n)]), w.source);
    w.L.simulate(invokeHostFn(w.addr, 'del_persistent', [sym('nope')]), w.source);
    w.L.simulate(invokeHostFn(w.addr, 'no_such_function', []), w.source);

    expectSameState(before, w.seen.capture(w.L), 'after a batch of simulate() calls');
    expect(
      w.L.getEntry(
        contractDataKey(w.addr, sym('phantom'), xdr.ContractDataDurability.persistent()),
      ),
      'a simulated write reached the store',
    ).toBeUndefined();
  });
});

// ===========================================================================
// B. determinism
// ===========================================================================
describe('property: determinism', () => {
  /** Fully deterministic: seeded account, fixed salt, fixed op stream. */
  function runProgram(): {
    steps: StepRecord[];
    entryCount: number;
    keyDigest: string;
  } {
    const w = freshWorld();
    const rng = makeRng(0xd37e21); // same seed every run
    const steps = runOps(w, rng, emptyModel(), 15);
    return {
      steps,
      entryCount: w.L.entryCount(),
      keyDigest: [...w.seen.keys].sort().join('\n'),
    };
  }

  it('the same op sequence from a fresh Ledger is identical across runs', () => {
    const runs = [runProgram(), runProgram(), runProgram()];

    for (let r = 1; r < runs.length; r++) {
      expect(runs[r].entryCount, `run ${r}: entryCount`).toBe(runs[0].entryCount);
      expect(runs[r].keyDigest, `run ${r}: touched key set`).toBe(runs[0].keyDigest);
      expect(runs[r].steps.length).toBe(runs[0].steps.length);

      for (let i = 0; i < runs[0].steps.length; i++) {
        const a = runs[0].steps[i];
        const b = runs[r].steps[i];
        const at = `run ${r} step ${i} (${a.label})`;

        expect(b.label, `${at}: op stream diverged`).toBe(a.label);
        // instruction counts and metering
        expect(b.sim.instructions, `${at}: sim instructions`).toBe(a.sim.instructions);
        expect(b.sim.cpuInsns, `${at}: sim cpu insns`).toBe(a.sim.cpuInsns);
        expect(b.sim.memBytes, `${at}: sim mem bytes`).toBe(a.sim.memBytes);
        expect(b.sent.cpuInsns, `${at}: send cpu insns`).toBe(a.sent.cpuInsns);
        // footprints
        expect(b.sim.readOnlyKeys, `${at}: read-only footprint`).toEqual(a.sim.readOnlyKeys);
        expect(b.sim.readWriteKeys, `${at}: read-write footprint`).toEqual(a.sim.readWriteKeys);
        expect(b.sim.readBytes, `${at}: disk read bytes`).toBe(a.sim.readBytes);
        expect(b.sim.writeBytes, `${at}: write bytes`).toBe(a.sim.writeBytes);
        // return values and applied changes
        expect(b.sim.returnValueXdr, `${at}: sim return value`).toBe(a.sim.returnValueXdr);
        expect(b.sent.returnValueXdr, `${at}: send return value`).toBe(a.sent.returnValueXdr);
        expect(b.sent.changedKeys, `${at}: changed keys`).toEqual(a.sent.changedKeys);
        expect(b.sent.removedKeys, `${at}: removed keys`).toEqual(a.sent.removedKeys);
        expect(b.sent.eventsXdr, `${at}: events`).toEqual(a.sent.eventsXdr);
      }
    }
  });

  it('replaying the same ops after restore() reproduces the same metering', () => {
    const w = freshWorld();
    const rngA = makeRng(0x99aa);
    runOps(w, rngA, emptyModel(), 5);

    const snap = w.L.snapshot();

    const first = runOps(w, makeRng(0x77bb), emptyModel(), 5);
    w.L.restore(snap);
    const second = runOps(w, makeRng(0x77bb), emptyModel(), 5);

    for (let i = 0; i < first.length; i++) {
      const at = `step ${i} (${first[i].label})`;
      expect(second[i].label).toBe(first[i].label);
      expect(second[i].sim.instructions, `${at}: instructions`).toBe(first[i].sim.instructions);
      expect(second[i].sim.readWriteKeys, `${at}: footprint`).toEqual(first[i].sim.readWriteKeys);
      expect(second[i].sent.changedKeys, `${at}: changed keys`).toEqual(
        first[i].sent.changedKeys,
      );
      expect(second[i].sent.cpuInsns, `${at}: cpu insns`).toBe(first[i].sent.cpuInsns);
    }
  });
});

// ===========================================================================
// C. independence
// ===========================================================================
describe('property: two Ledger instances in one process share nothing', () => {
  it('identical seeded accounts and contract ids, completely separate state', () => {
    const a = freshWorld();
    const b = freshWorld();

    // Same deterministic inputs => literally the same addresses in both.
    expect(b.source).toBe(a.source);
    expect(b.addr.toXDR('base64')).toBe(a.addr.toXDR('base64'));
    expect(b.L.entryCount()).toBe(a.L.entryCount());

    a.L.simulateAndSend(invokeHostFn(a.addr, 'put_persistent', [sym('only_a'), u64(1n)]), a.source);

    expect(readPersistent(a, 'only_a')).toBe(1n);
    expect(readPersistent(b, 'only_a'), 'ledger B saw a write made in ledger A').toBeUndefined();
    expect(b.L.entryCount()).toBeLessThan(a.L.entryCount());
  });

  it('snapshot and restore on one instance do not touch the other', () => {
    const a = freshWorld();
    const b = freshWorld();

    b.L.simulateAndSend(invokeHostFn(b.addr, 'put_persistent', [sym('bkey'), u64(9n)]), b.source);
    const bBefore = b.seen.capture(b.L);

    const snapA = a.L.snapshot();
    a.L.simulateAndSend(invokeHostFn(a.addr, 'put_persistent', [sym('akey'), u64(5n)]), a.source);
    a.L.restore(snapA);

    expectSameState(bBefore, b.seen.capture(b.L), 'ledger B after A snapshot/restore');
    expect(readPersistent(b, 'bkey')).toBe(9n);
    expect(readPersistent(a, 'akey')).toBeUndefined();
  });

  it('interleaving work on a second ledger does not perturb the first metering', () => {
    // Baseline: run the program alone.
    const solo = (() => {
      const w = freshWorld();
      return runOps(w, makeRng(0x4242), emptyModel(), 8);
    })();

    // Now the same program, with an unrelated ledger doing work between steps.
    const w = freshWorld();
    const noise = freshWorld();
    const noiseRng = makeRng(0xfeed);
    const noiseModel = emptyModel();
    const rng = makeRng(0x4242);
    const model = emptyModel();

    const interleaved: StepRecord[] = [];
    for (let i = 0; i < 8; i++) {
      runOps(noise, noiseRng, noiseModel, 1);
      interleaved.push(...runOps(w, rng, model, 1));
    }

    for (let i = 0; i < solo.length; i++) {
      const at = `step ${i} (${solo[i].label})`;
      expect(interleaved[i].label).toBe(solo[i].label);
      expect(interleaved[i].sim.instructions, `${at}: instructions`).toBe(solo[i].sim.instructions);
      expect(interleaved[i].sim.cpuInsns, `${at}: cpu insns`).toBe(solo[i].sim.cpuInsns);
      expect(interleaved[i].sim.readWriteKeys, `${at}: footprint`).toEqual(
        solo[i].sim.readWriteKeys,
      );
      expect(interleaved[i].sent.changedKeys, `${at}: changed keys`).toEqual(
        solo[i].sent.changedKeys,
      );
    }
  });

  it('a snapshot handle issued by one ledger is rejected by another', () => {
    // `snapshot()` returns a bare index into a per-instance Vec (lib.rs:324), so
    // the first snapshot of EVERY ledger is 0. Crossing handles between two
    // ledgers in the same process therefore rolls the wrong ledger back to the
    // wrong state, silently. A handle should not be interchangeable.
    const a = freshWorld();
    const b = freshWorld();

    const handleFromA = a.L.snapshot();

    b.L.simulateAndSend(invokeHostFn(b.addr, 'put_persistent', [sym('b1'), u64(1n)]), b.source);
    b.L.snapshot(); // b now has a snapshot of its own, at a different state
    b.L.simulateAndSend(invokeHostFn(b.addr, 'put_persistent', [sym('b2'), u64(2n)]), b.source);

    expect(
      () => b.L.restore(handleFromA),
      "ledger B accepted ledger A's snapshot handle",
    ).toThrow();
  });

  it('the ledger clock of one instance is independent of the other', () => {
    const a = new Ledger();
    const b = new Ledger();
    a.advanceLedgers(1_000);
    a.setTimestamp(START_TS + 999_999);

    expect(b.ledgerSeq).toBe(START_SEQ);
    expect(b.timestamp).toBe(START_TS);
    expect(a.ledgerSeq).toBe(START_SEQ + 1_000);
  });
});

// ===========================================================================
// D. the recording-auth PRNG
// ===========================================================================
describe('property: recording-auth nonces', () => {
  /**
   * A SAC transfer whose `from` is NOT the transaction source forces an
   * address credential, which is where the recorded nonce lives
   * (soroban-env-host-27.0.1/src/auth.rs:2437).
   */
  function transferNeedingAuth() {
    const L = new Ledger();
    const alice = preFundedWallet(L);
    const carol = preFundedWallet(L); // separate transaction source
    const token = deployToken(L, { code: 'NONCE' });
    token.mint(alice, 1_000n);
    token.trust(carol);
    const fn = invokeHostFn(token.address, 'transfer', [
      xdr.ScVal.scvAddress(alice.address),
      xdr.ScVal.scvAddress(carol.address),
      i128(10n),
    ]);
    return { L, fn, source: carol.accountIdB64 };
  }

  const nonceOf = (authB64: string) =>
    xdr.SorobanAuthorizationEntry.fromXDR(authB64, 'base64')
      .credentials()
      .address()
      .nonce()
      .toString();

  it('two consecutive simulate() calls produce DIFFERENT nonces', () => {
    const { L, fn, source } = transferNeedingAuth();

    const first = L.simulate(fn, source);
    const second = L.simulate(fn, source);
    expect(first.ok, first.error).toBe(true);
    expect(second.ok, second.error).toBe(true);
    expect(first.authXdr).toHaveLength(1);
    expect(second.authXdr).toHaveLength(1);

    expect(
      xdr.SorobanAuthorizationEntry.fromXDR(first.authXdr[0], 'base64')
        .credentials()
        .switch().name,
    ).toBe('sorobanCredentialsAddress');

    // A fixed base seed made the second simulation reuse the first nonce and
    // die with Error(Auth, ExistingValue). This is the regression pin.
    expect(nonceOf(second.authXdr[0])).not.toBe(nonceOf(first.authXdr[0]));
  });

  it('resetPrng() rewinds the counter so nonces repeat exactly', () => {
    const { L, fn, source } = transferNeedingAuth();

    // GAP: `resetPrng` exists on the wasm `SorobanEnv` (lib.rs:196) but is not
    // re-exported by the `Ledger` wrapper in src/index.ts, so a test has to
    // reach through the private field.
    const env = (L as unknown as { env: { resetPrng(): void } }).env;
    expect(typeof env?.resetPrng, 'wasm env does not expose resetPrng').toBe('function');

    env.resetPrng();
    const a = L.simulate(fn, source);
    const b = L.simulate(fn, source);
    env.resetPrng();
    const c = L.simulate(fn, source);

    expect(nonceOf(b.authXdr[0])).not.toBe(nonceOf(a.authXdr[0]));
    expect(nonceOf(c.authXdr[0]), 'resetPrng did not reproduce the first nonce').toBe(
      nonceOf(a.authXdr[0]),
    );
  });

  it('a simulate that records a nonce does not consume it in the store', () => {
    // auth.rs:2446 `consume_nonce` writes a LedgerKeyNonce entry into the
    // recording storage. If that leaked into the store, the second simulation
    // would die with Error(Auth, ExistingValue).
    const { L, fn, source } = transferNeedingAuth();
    const before = L.entryCount();

    for (let i = 0; i < 5; i++) {
      const r = L.simulate(fn, source);
      expect(r.ok, r.error).toBe(true);
    }
    expect(L.entryCount(), 'recorded auth nonces leaked into the ledger').toBe(before);
  });

  it('resetPrng is reachable from the public Ledger API', () => {
    // The PRNG counter is ledger state that determinism depends on. The wasm
    // class exposes `resetPrng` (lib.rs:196) but `Ledger` (src/index.ts) does
    // not forward it, so every test that needs reproducible nonces has to reach
    // through the private `env` field.
    const L = new Ledger();
    expect(
      typeof (L as unknown as Record<string, unknown>).resetPrng,
      'Ledger does not forward resetPrng() from the wasm env',
    ).toBe('function');
  });
});

// ===========================================================================
// E. ledgerSeq / timestamp / TTL
// ===========================================================================
describe('property: ledgerSeq and timestamp drive TTL and timebounds', () => {
  it('advanceLedgers moves seq and clock together, monotonically', () => {
    const L = new Ledger();
    expect(L.ledgerSeq).toBe(START_SEQ);
    expect(L.timestamp).toBe(START_TS);

    const rng = makeRng(0x0ff1ce);
    let seq = L.ledgerSeq;
    let ts = L.timestamp;
    for (let i = 0; i < 12; i++) {
      const n = 1 + rng.int(500);
      L.advanceLedgers(n);
      expect(L.ledgerSeq, 'ledgerSeq must be strictly increasing').toBeGreaterThan(seq);
      expect(L.timestamp, 'timestamp must be strictly increasing').toBeGreaterThan(ts);
      expect(L.ledgerSeq).toBe(seq + n);
      expect(L.timestamp).toBe(ts + n * SECONDS_PER_LEDGER);
      seq = L.ledgerSeq;
      ts = L.timestamp;
    }
  });

  it('new entries get the TTL the host prescribes at the CURRENT ledgerSeq', () => {
    // ledger_info.rs:16 — live_until = sequence_number + min_ttl - 1
    const w = freshWorld();

    w.L.simulateAndSend(invokeHostFn(w.addr, 'put_persistent', [sym('p'), u64(1n)]), w.source);
    w.L.simulateAndSend(invokeHostFn(w.addr, 'put_temporary', [sym('t'), u64(1n)]), w.source);

    const pKey = contractDataKey(w.addr, sym('p'), xdr.ContractDataDurability.persistent());
    const tKey = contractDataKey(w.addr, sym('t'), xdr.ContractDataDurability.temporary());

    expect(w.L.getEntryTtl(pKey)).toBe(START_SEQ + MIN_PERSISTENT_ENTRY_TTL - 1);
    expect(w.L.getEntryTtl(tKey)).toBe(START_SEQ + MIN_TEMP_ENTRY_TTL - 1);

    // Move the clock; a new entry must be dated from the NEW sequence number.
    w.L.advanceLedgers(1_234);
    w.L.simulateAndSend(invokeHostFn(w.addr, 'put_persistent', [sym('p2'), u64(2n)]), w.source);
    const p2Key = contractDataKey(w.addr, sym('p2'), xdr.ContractDataDurability.persistent());
    expect(w.L.getEntryTtl(p2Key)).toBe(START_SEQ + 1_234 + MIN_PERSISTENT_ENTRY_TTL - 1);
    // ...while the old entry keeps the TTL it was born with.
    expect(w.L.getEntryTtl(pKey)).toBe(START_SEQ + MIN_PERSISTENT_ENTRY_TTL - 1);
  });

  it('a temporary entry disappears once ledgerSeq passes its TTL', () => {
    // storage.rs:723 handle_maybe_expired_entry — an expired temporary entry
    // reads back as absent, it is not merely stale.
    const w = freshWorld();
    w.L.simulateAndSend(invokeHostFn(w.addr, 'put_temporary', [sym('t'), u64(42n)]), w.source);

    const live = w.L.simulate(invokeHostFn(w.addr, 'get_temporary', [sym('t')]), w.source);
    expect(live.ok, live.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(live.returnValueXdr!, 'base64'))).toBe(42n);

    // One ledger before expiry it is still there...
    w.L.advanceLedgers(MIN_TEMP_ENTRY_TTL - 1);
    expect(w.L.ledgerSeq).toBe(START_SEQ + MIN_TEMP_ENTRY_TTL - 1);
    const stillLive = w.L.simulate(invokeHostFn(w.addr, 'has_temporary', [sym('t')]), w.source);
    expect(stillLive.ok, stillLive.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(stillLive.returnValueXdr!, 'base64'))).toBe(true);

    // ...one ledger later it is gone.
    w.L.advanceLedgers(1);
    const expired = w.L.simulate(invokeHostFn(w.addr, 'has_temporary', [sym('t')]), w.source);
    expect(expired.ok, expired.error).toBe(true);
    expect(
      scValToNative(xdr.ScVal.fromXDR(expired.returnValueXdr!, 'base64')),
      'expired temporary entry is still visible',
    ).toBe(false);
  });

  it('timebounds are evaluated against the ledger clock, not wall time', () => {
    const L = new Ledger();
    const kp = Keypair.random();
    L.fund(kp.publicKey());
    const server = new rpc.Server('https://in-process.invalid');
    attachInProcessRpc(server, L);

    const wasmHash = L.seedWasm(CONTRACT_DATA);
    const srcB64 = accountIdFromPublicKey(kp.publicKey()).toXDR('base64');
    const { sent } = L.simulateAndSend(createContractHostFn(srcB64, wasmHash), srcB64);
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();

    const buildAt = async (minTime: number, maxTime: number) => {
      const account = await server.getAccount(kp.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: Networks.TESTNET,
        timebounds: { minTime, maxTime },
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeHostFn(addr, 'put_persistent', [sym('tb'), u64(1n)]),
            auth: [],
          }),
        )
        .build();
      const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
      assembled.sign(kp);
      return assembled;
    };

    return (async () => {
      const now = L.timestamp;

      const tooEarly = await buildAt(now + 100, now + 200);
      expect(L.sendTransaction(tooEarly.toEnvelope().toXDR('base64')).code).toBe('txTOO_EARLY');

      const tooLate = await buildAt(now - 200, now - 100);
      expect(L.sendTransaction(tooLate.toEnvelope().toXDR('base64')).code).toBe('txTOO_LATE');

      // Advancing the ledger moves the clock into the first window.
      const inWindow = await buildAt(now + 100, now + 100_000);
      // 100 seconds / 5 s per ledger = 20 ledgers.
      L.advanceLedgers(100 / SECONDS_PER_LEDGER);
      expect(L.timestamp).toBe(now + 100);
      const out = L.sendTransaction(inWindow.toEnvelope().toXDR('base64'));
      expect(out.code, out.detail ?? out.error).toBe('txSUCCESS');
    })();
  });

  it('the ledger clock cannot be moved backwards', () => {
    // stellar-core: HerderSCPDriver.cpp:280 rejects `closeTime <= lastCloseTime`,
    // so a ledger whose close time went backwards cannot exist. A harness that
    // silently accepts it lets a test build a state the network cannot produce
    // (entries dated in the future, timebounds that re-open).
    const L = new Ledger();
    L.advanceLedgers(100);
    const t = L.timestamp;
    expect(() => L.setTimestamp(t - 1)).toThrow();
  });
});

// ===========================================================================
// F. failed sends are atomic
// ===========================================================================
describe('property: a failed or trapped send leaves the ledger unchanged', () => {
  it('a send whose footprint is stripped changes nothing', () => {
    const w = freshWorld();
    const rng = makeRng(0xbead);
    runOps(w, rng, emptyModel(), 6);
    const before = w.seen.capture(w.L);

    const fn = invokeHostFn(w.addr, 'put_persistent', [sym('never'), u64(1n)]);
    const sim = w.L.simulate(fn, w.source);
    expect(sim.ok).toBe(true);
    const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    resources.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));

    let applied = false;
    try {
      applied = w.L.send(fn, w.source, resources.toXDR('base64'), sim.authXdr, []).ok;
    } catch {
      applied = false;
    }
    expect(applied).toBe(false);

    expectSameState(before, w.seen.capture(w.L), 'after a footprint-rejected send');
    expect(
      w.L.getEntry(contractDataKey(w.addr, sym('never'), xdr.ContractDataDurability.persistent())),
      'a rejected send wrote its entry anyway',
    ).toBeUndefined();
  });

  it('a contract-level failure changes nothing', () => {
    const w = freshWorld();
    const rng = makeRng(0xf00d);
    runOps(w, rng, emptyModel(), 6);
    const before = w.seen.capture(w.L);

    // get_persistent on a missing key errors inside the contract.
    const fn = invokeHostFn(w.addr, 'get_persistent', [sym('absent_key')]);
    const sim = w.L.simulate(fn, w.source);
    expect(sim.ok, 'expected the simulation itself to fail').toBe(false);

    // Send it anyway with a plausible (empty) footprint — the host must refuse
    // and must not half-apply.
    let applied = false;
    try {
      const resources = new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 1_000_000,
        diskReadBytes: 10_000,
        writeBytes: 10_000,
      });
      applied = w.L.send(fn, w.source, resources.toXDR('base64'), [], []).ok;
    } catch {
      applied = false;
    }
    expect(applied).toBe(false);
    expectSameState(before, w.seen.capture(w.L), 'after a contract-level failure');
  });

  it('a SAC transfer that fails MID-EXECUTION does not leave the sender debited', () => {
    // `transfer` debits `from` and then credits `to`. Pull the recipient's
    // trustline out between simulate and send: the footprint is still valid, the
    // auth still matches, and the call now fails at the credit — strictly after
    // the debit. This is the only shape in which a partial application could
    // ever be observed, so it is the one worth pinning.
    const L = new Ledger();
    const alice = preFundedWallet(L);
    const bob = preFundedWallet(L);
    const token = deployToken(L, { code: 'ATOM' });
    token.mint(alice, 1_000n);
    token.trust(bob);

    const aliceTl = trustlineKey(alice, token.asset);
    const bobTl = trustlineKey(bob, token.asset);
    expect(token.balanceOf(alice)).toBe(1_000n);

    const fn = invokeHostFn(token.address, 'transfer', [
      xdr.ScVal.scvAddress(alice.address),
      xdr.ScVal.scvAddress(bob.address),
      i128(400n),
    ]);
    const sim = L.simulate(fn, alice.accountIdB64);
    expect(sim.ok, sim.error).toBe(true);

    // Yank the recipient's trustline; the transfer will now fail at the credit.
    expect(L.removeEntry(bobTl)).toBe(true);

    const seen = new KeySet();
    seen.add(
      aliceTl,
      bobTl,
      accountKey(alice.accountId).toXDR('base64'),
      accountKey(bob.accountId).toXDR('base64'),
    );
    const before = seen.capture(L);
    const beforeCount = L.entryCount();

    const sent = L.send(fn, alice.accountIdB64, sim.resourcesXdr, sim.authXdr, []);
    expect(sent.ok, 'expected the transfer to fail at the credit step').toBe(false);
    expect(sent.changedKeys).toEqual([]);
    expect(sent.removedKeys).toEqual([]);

    expect(L.entryCount()).toBe(beforeCount);
    expectSameState(before, seen.capture(L), 'after a mid-execution transfer failure');
    expect(token.balanceOf(alice), 'the sender was debited by a failed transfer').toBe(1_000n);
  });

  it('an over-balance SAC transfer is refused without touching either balance', () => {
    // Simulate a transfer of the full balance (so the recorded auth matches the
    // invocation exactly), then shrink the sender's balance underneath it. The
    // send now fails on insufficient funds, again strictly after the debit
    // attempt, with auth that the host accepts.
    const L = new Ledger();
    const alice = preFundedWallet(L);
    const bob = preFundedWallet(L);
    const token = deployToken(L, { code: 'ATOM' });
    token.mint(alice, 1_000n);
    token.trust(bob);

    const fn = invokeHostFn(token.address, 'transfer', [
      xdr.ScVal.scvAddress(alice.address),
      xdr.ScVal.scvAddress(bob.address),
      i128(1_000n),
    ]);
    const sim = L.simulate(fn, alice.accountIdB64);
    expect(sim.ok, sim.error).toBe(true);

    establishTrustline(L, alice, token.asset, { balance: 100n });
    expect(token.balanceOf(alice)).toBe(100n);

    const seen = new KeySet();
    seen.add(trustlineKey(alice, token.asset), trustlineKey(bob, token.asset));
    const before = seen.capture(L);
    const beforeCount = L.entryCount();

    const sent = L.send(fn, alice.accountIdB64, sim.resourcesXdr, sim.authXdr, []);
    expect(sent.ok, 'expected the transfer to fail on insufficient balance').toBe(false);
    // Not an auth rejection — the host really entered `transfer`.
    expect(sent.error).toContain('Contract');
    expect(sent.changedKeys).toEqual([]);
    expect(sent.removedKeys).toEqual([]);

    expect(L.entryCount()).toBe(beforeCount);
    expectSameState(before, seen.capture(L), 'after an over-balance transfer');
    expect(token.balanceOf(alice)).toBe(100n);
    expect(token.balanceOf(bob)).toBe(0n);
  });

  it('a TRAPPED send (__check_auth unreachable) leaves the ledger unchanged', async () => {
    const L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    const source = accountIdFromPublicKey(deployer.publicKey()).toXDR('base64');

    const admin = Keypair.random();
    const wasmHash = L.seedWasm(SMART_ACCOUNT);
    const adminSigner = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Ed25519'),
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(admin.rawPublicKey()),
        }),
      ]),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
    ]);
    const deployed = L.simulateAndSend(
      createContractHostFn(source, wasmHash, Buffer.alloc(32), [
        xdr.ScVal.scvVec([adminSigner]),
        xdr.ScVal.scvVec([]),
      ]),
      source,
    );
    expect(deployed.sent.ok, deployed.sent.error).toBe(true);
    const addr = xdr.ScVal.fromXDR(deployed.sent.returnValueXdr!, 'base64').address();

    const seen = new KeySet();
    seen.add(accountKey(accountIdFromPublicKey(deployer.publicKey())).toXDR('base64'));
    seen.observe(deployed.sent);

    const newSigner = Keypair.random();
    const fn = invokeHostFn(addr, 'add_signer', [
      xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Ed25519'),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('public_key'),
            val: xdr.ScVal.scvBytes(newSigner.rawPublicKey()),
          }),
        ]),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
      ]),
    ]);

    // A correctly-signed enforcing simulation gives us a footprint wide enough
    // that the host really enters __check_auth on the apply path.
    const recorded = L.simulate(fn, source);
    const signed = await signAuthEntries(L, recorded.authXdr, {
      sign: smartAccountEd25519(admin),
    });
    const enforced = L.simulateWithAuth(fn, source, signed);
    expect(enforced.ok, enforced.error).toBe(true);

    const before = seen.capture(L);
    const beforeCount = L.entryCount();

    // Now send with the UNSIGNED placeholder entries: __check_auth traps
    // (Error(Auth, InvalidAction) / UnreachableCodeReached).
    const trapped = L.send(
      fn,
      source,
      enforced.resourcesXdr,
      recorded.authXdr,
      enforced.restoredRwEntryIndices,
    );
    expect(trapped.ok).toBe(false);
    expect(trapped.error).toContain('Auth');
    expect(trapped.changedKeys).toEqual([]);
    expect(trapped.removedKeys).toEqual([]);

    expect(L.entryCount(), 'the trapped send left entries behind (nonce?)').toBe(beforeCount);
    expectSameState(before, seen.capture(L), 'after a trapped send');

    // The instance still works afterwards, and the signer was NOT added.
    const has = L.simulate(
      invokeHostFn(addr, 'has_signer', [
        xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol('Ed25519'),
          xdr.ScVal.scvBytes(newSigner.rawPublicKey()),
        ]),
      ]),
      source,
    );
    expect(has.ok, has.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(has.returnValueXdr!, 'base64'))).toBe(false);
  });
});
