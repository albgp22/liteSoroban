/**
 * ROUND-2 ADVERSARIAL AUDIT of the observability surface
 * (diagnostics, stateHash, allKeys, memBytes, ttlChangedKeys, non-throwing send).
 *
 * Round 1's audit lives in `observability-round1.test.ts` and its RED tests are
 * still red. This file does NOT repeat them. It covers what round 1 did not:
 *
 *   1. Whether `enable_diagnostics: true` — hardcoded in
 *      crates/host-wasm/src/lib.rs, where a real validator defaults it OFF —
 *      inflates metering.  ANSWER: it does not. Proved twice over, and pinned
 *      here as a regression fence.
 *   2. changedKeys / removedKeys / ttlChangedKeys: the harness collapses the
 *      host's `LedgerEntryChange` (a STATE description) into a DIFF, and the
 *      three buckets it produces are each wrong in a different direction.
 *   3. Diagnostics completeness measured against a LIVE protocol-27 node
 *      rather than against the host function that fills the vector.
 *   4. stateHash vs the clock, on a path that has nothing to do with TTLs.
 *
 * GROUND TRUTH USED
 *
 *   host  e2e_invoke.rs:183 get_ledger_changes — emits one `LedgerEntryChange`
 *         for EVERY key in `storage.map`, not for the ones that changed.
 *         `encoded_new_value` is `Some(current bytes)` for every read-write key
 *         that exists, whether or not those bytes differ from the old ones, and
 *         `None` for a read-write key that does not exist, whether or not it
 *         ever did.  `ttl_change` is `Some(..)` for every ContractData /
 *         ContractCode key regardless of `read_only`.
 *
 *   host  budget.rs:1345 with_shadow_mode / host.rs:722 with_debug_mode —
 *         every diagnostic charge is routed to the SHADOW budget, and
 *         e2e_invoke.rs:957 extract_diagnostic_events is explicitly unmetered.
 *
 *   core  src/rust/src/soroban_proto_any.rs:537 — on EVERY failed invocation
 *         (top-level host error and in-invocation error alike) stellar-core
 *         appends a `host_fn_failed` diagnostic event carrying the error code.
 *
 *   live  stellar-rpc 27.1.1 / captive-core v27.1.0 at http://localhost:8000,
 *         passphrase "Standalone Network ; February 2017", captured 2026-08-18.
 *         Payloads quoted inline at each assertion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, type Contract, type Wallet } from '../../src/litestellar.js';
import { Ledger, invokeHostFn, uploadWasmHostFn } from '../../src/index.js';
import { PROTOCOL_27_COST_PARAMS } from '../../src/cost-params.js';

const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

const CONTRACT_DATA = fixture('contract_data.wasm');
/** soroban_test_wasms::ADD_I32 — the exact blob upstream's e2e tests use. */
const E2E_ADD_I32 = fixture('e2e_add_i32.wasm');

const topicsOf = (d: xdr.DiagnosticEvent): string[] =>
  d.event().body().v0().topics().map((t: any) => {
    switch (t.switch().name) {
      case 'scvSymbol': return t.sym().toString();
      case 'scvError': return `Error(${t.error().switch().name})`;
      default: return t.switch().name;
    }
  });

const firstTopic = (d: xdr.DiagnosticEvent) => topicsOf(d)[0];

const keyLabel = (k: string): string => {
  const lk = xdr.LedgerKey.fromXDR(k, 'base64');
  if (lk.switch().name === 'contractData') {
    const kk = lk.contractData().key();
    const name = kk.switch().name === 'scvSymbol' ? kk.sym().toString() : kk.switch().name;
    return `data:${name}`;
  }
  return lk.switch().name;
};

let svm: LiteStellar;
let c: Contract;

beforeEach(() => {
  svm = new LiteStellar();
  c = svm.deployContract(CONTRACT_DATA);
});

/** simulate -> send against the low-level Ledger, so the raw buckets are visible. */
function roundTrip(fn: string, args: xdr.ScVal[]) {
  const hostFn = invokeHostFn(c.address, fn, args);
  const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
  const sent = svm.ledger.send(
    hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
  );
  return { hostFn, sim, sent };
}

// ---------------------------------------------------------------------------
// 1. Diagnostics are metering-neutral. This is the load-bearing question about
//    the round-1 surface and the answer is GREEN — keep it that way.
// ---------------------------------------------------------------------------

describe('enable_diagnostics is hardcoded true — does that cost budget?', () => {
  /**
   * NO. Three independent lines of evidence:
   *
   * (a) READING the host. Every diagnostic charge goes through
   *     `Host::with_debug_mode` (host.rs:688), which calls
   *     `budget.with_shadow_mode(f)` (budget.rs:1345) — that flips
   *     `is_in_shadow_mode`, so `BudgetImpl::charge` (budget.rs:~245) adds to
   *     `shadow_total_count`, never to `total_count`.
   *     `get_cpu_insns_consumed` / `get_mem_bytes_consumed` report
   *     `total_count`. `extract_diagnostic_events` (e2e_invoke.rs:957) carries
   *     the comment "diagnostic events should be non-metered".
   *
   * (b) RUNNING the pinned host natively, twice per scenario, diagnostics off
   *     vs on (soroban-env-host 27.0.1, wasm32 host code compiled for the host
   *     triple instead, same e2e_invoke entry points):
   *
   *       recording upload add_i32          off/on  cpu 1766282  mem 1442234  Δ0
   *       recording invoke put_persistent   off/on  cpu  949073  mem 1182055  Δ0  (2 events on)
   *       enforcing invoke put_persistent   off/on  cpu 1567797  mem 1279426  Δ0  (2 events on)
   *       recording FAILING get_persistent  off/on  cpu  921565  mem 1153908  Δ0  (2 events on)
   *       upstream e2e_tests.rs:855 upload  off/on  cpu 1767593  mem 1442169  Δ0
   *
   * (c) The number below. Upstream's `expect!["1767593"]` at
   *     e2e_tests.rs:894 was produced by calling
   *     `invoke_host_function_recording_helper` with its first argument —
   *     `enable_diagnostics` — set to `false`. The harness passes `true` and
   *     lands on the same integer.
   *
   * A real node therefore is NOT charging less than this harness reports
   * because it runs with diagnostics off. If an instruction count here
   * disagrees with mainnet, the cause is the cost table or the module cache,
   * not this flag.
   */
  it('no: the harness reproduces upstream numbers produced with diagnostics OFF', () => {
    const L = new Ledger({ ledgerSeq: 1_000_000 });
    L.setTimestamp(12_345_678); // default_ledger_info()
    const source = xdr.AccountId.publicKeyTypeEd25519(Buffer.alloc(32, 123)).toXDR('base64');

    const sim = L.simulate(uploadWasmHostFn(E2E_ADD_I32), source);

    expect(sim.instructions).toBe(1767593); // expect!["1767593"], diagnostics OFF upstream
    expect(sim.writeBytes).toBe(684); //      expect!["684"]
    // The native diagnostics-OFF run of the same scenario, to the byte.
    expect(Number(sim.cpuInsns)).toBe(1767593);
    expect(Number(sim.memBytes)).toBe(1442169);
  });

  it('no: mem_bytes is the non-shadow dimension, so diagnostics cannot show up in it', () => {
    // Diagnostics DO consume shadow memory (InternalDiagnosticEvent allocation,
    // externalize_args, the events Vec). If memBytes were the shadow counter or
    // the sum, an invocation that emits diagnostic events would report more
    // memory than the identical one that does not. Natively measured: identical
    // (1182055 both ways for put_persistent, with 0 vs 2 events).
    const { sim, sent } = roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    expect(sim.diagnosticEventsXdr.length).toBe(2);
    expect(sent.diagnosticEventsXdr.length).toBe(2);
    expect(Number(sim.memBytes)).toBeGreaterThan(0);
    expect(Number(sent.memBytes)).toBeGreaterThan(Number(sim.memBytes)); // enforcing parses the module
  });
});

// ---------------------------------------------------------------------------
// 2. changedKeys / removedKeys / ttlChangedKeys.
//
//    `get_ledger_changes` returns the POST-STATE of every footprint key the
//    host touched. It is not a diff. lib.rs:730-763 reads it as one anyway.
// ---------------------------------------------------------------------------

describe('changedKeys / removedKeys / ttlChangedKeys vs get_ledger_changes', () => {
  it('RED: changedKeys names a key whose bytes did not change', () => {
    roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const before = svm.stateHash();

    // Write the SAME value again. Nothing about the ledger moves.
    const { sent } = roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);

    expect(sent.ok).toBe(true);
    // stateHash is the harness's own witness that nothing changed...
    expect(svm.stateHash()).toBe(before);
    // ...yet the key is reported as changed, because `encoded_new_value` is
    // `Some(..)` for every read-write key that exists, changed or not.
    expect(sent.changedKeys.map(keyLabel)).toEqual([]);
  });

  it('RED: removedKeys names a key that never existed', () => {
    const keysBefore = svm.allKeys();
    const before = svm.stateHash();

    // Delete a key that is not in the ledger. The host records it in the
    // read-write footprint, storage maps it to None, and get_ledger_changes
    // emits a change with `encoded_new_value: None` — which lib.rs:758 reads
    // as "removed".
    const { sim, sent } = roundTrip('del_persistent', [sc.sym('nevermade')]);

    expect(sent.ok).toBe(true);
    expect(sim.readWriteKeys.length).toBe(1);
    // It was never in the ledger before...
    expect(keysBefore.map(keyLabel)).not.toContain('data:nevermade');
    // ...it is not in the ledger after, and nothing was removed.
    expect(svm.stateHash()).toBe(before);
    expect(sent.removedKeys.map(keyLabel)).toEqual([]);
  });

  it('RED: ttlChangedKeys misses a TTL bump on a read-write entry', () => {
    roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);

    const hostFn = invokeHostFn(c.address, 'extend_persistent', [
      sc.sym('k'), sc.u32(300_000), sc.u32(600_000),
    ]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);

    // Recording mode puts a rent extension in the READ-ONLY footprint. Move it
    // to read-write, which any submitter may legitimately do (read-write is a
    // superset of the permission read-only grants) and which the host accepts.
    const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const ro = res.footprint().readOnly();
    const i = ro.findIndex((k) => keyLabel(k.toXDR('base64')) === 'data:k');
    const dataKey = ro[i].toXDR('base64');
    res.footprint(new xdr.LedgerFootprint({
      readOnly: ro.filter((_, j) => j !== i),
      readWrite: [ro[i]],
    }));

    const ttlBefore = svm.ledger.getEntryTtl(dataKey)!;
    const sent = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, res.toXDR('base64'), sim.authXdr, [],
    );
    const ttlAfter = svm.ledger.getEntryTtl(dataKey)!;

    expect(sent.ok).toBe(true);
    expect(ttlAfter).toBeGreaterThan(ttlBefore); // 1099999 -> 1600000

    // The entry's VALUE was untouched — this is exactly the case the
    // `ttl_changed_keys` doc comment describes ("TTL bumps applied to entries
    // that were otherwise untouched"). It is reported in the wrong bucket.
    expect(sent.ttlChangedKeys.map(keyLabel)).toEqual(['data:k']);
  });

  it('RED: with the read-write footprint, changedKeys claims a value change that did not happen', () => {
    // The other half of the same defect: the only signal the caller gets for
    // the TTL bump above is a `changedKeys` entry, which asserts the entry's
    // CONTENTS changed. They did not.
    roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const hostFn = invokeHostFn(c.address, 'extend_persistent', [
      sc.sym('k'), sc.u32(300_000), sc.u32(600_000),
    ]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const ro = res.footprint().readOnly();
    const i = ro.findIndex((k) => keyLabel(k.toXDR('base64')) === 'data:k');
    const dataKey = ro[i].toXDR('base64');
    res.footprint(new xdr.LedgerFootprint({
      readOnly: ro.filter((_, j) => j !== i),
      readWrite: [ro[i]],
    }));

    const entryBefore = svm.ledger.getEntry(dataKey);
    const sent = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, res.toXDR('base64'), sim.authXdr, [],
    );

    expect(sent.ok).toBe(true);
    expect(svm.ledger.getEntry(dataKey)).toBe(entryBefore); // byte-identical
    expect(sent.changedKeys.map(keyLabel)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Diagnostics completeness, measured against the live node.
// ---------------------------------------------------------------------------

describe('diagnostics vs a live protocol-27 node', () => {
  /**
   * Captured 2026-08-18 from http://localhost:8000/rpc, contract_data.wasm
   * deployed on a standalone protocol-27 network, getTransaction() on a
   * FAILED `get_persistent("missing")`:
   *
   *   diagnostic inSuccess=false topics=[fn_call, bytes(32), get_persistent]
   *   diagnostic inSuccess=false topics=[error, Error(sceStorage)]
   *   diagnostic inSuccess=false topics=[error, Error(sceStorage)]
   *   diagnostic inSuccess=false topics=[log]
   *   diagnostic inSuccess=false topics=[host_fn_failed, Error(sceStorage)]   <-- core
   *   ...20 x diagnostic inSuccess=false topics=[core_metrics, <name>]        <-- core
   *
   * The first four come from the host and the harness reproduces them exactly,
   * in the same order. The fifth is stellar-core's, appended at
   * soroban_proto_any.rs:537 on EVERY failing invocation — top-level host error
   * and in-invocation error alike — and it is the only event that carries the
   * transaction-level error code in machine-readable form.
   */
  it('RED: a failed send omits the host_fn_failed event a real node appends', () => {
    // Make the failure happen at APPLY only, the way a real submitted
    // transaction fails: simulate a read that succeeds, then send a read of a
    // key outside the footprint.
    roundTrip('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const okFn = invokeHostFn(c.address, 'get_persistent', [sc.sym('k')]);
    const sim = svm.ledger.simulate(okFn, svm.payer.accountIdB64);
    const badFn = invokeHostFn(c.address, 'get_persistent', [sc.sym('missing')]);
    const sent = svm.ledger.send(badFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, []);

    expect(sent.ok).toBe(false);
    const diags = sent.diagnosticEventsXdr.map((b) => xdr.DiagnosticEvent.fromXDR(b, 'base64'));

    // The host's own four, in the node's order — this part is faithful.
    expect(diags.map(firstTopic)).toEqual(['fn_call', 'error', 'error', 'log']);
    // The node's fifth is missing, so nothing in the result names the
    // transaction-level error except a Rust Debug string.
    expect(diags.map(firstTopic)).toContain('host_fn_failed');
  });

  /**
   * Same node, `put_persistent` submitted with `sorobanData.resources.
   * instructions` starved to 100_000 against a simulated 599_484. Result code
   * `invokeHostFunctionResourceLimitExceeded`, and getTransaction() returns 21
   * diagnostic events led by:
   *
   *   diagnostic inSuccess=false [host_fn_failed, Error(sceBudget)]
   *   diagnostic inSuccess=false [error, Error(sceBudget)]
   *
   * The harness, with the cpu limit lowered to the same effect, returns:
   *
   *   limit   100_000  ok=false  diagnostics []
   *   limit   300_000  ok=false  diagnostics [fn_call]
   *   limit 1_000_000  ok=false  diagnostics [fn_call]
   *   limit 1_100_000  ok=false  diagnostics [fn_call, error/Error(sceBudget)]
   *
   * so whether the failure is nameable from the diagnostics depends on exactly
   * where in the invocation the budget ran out, and the caller is told nothing
   * about the truncation.
   */
  it('RED: budget exhaustion yields a diagnostic list that never names the failure', () => {
    const starve = (cpuLimit: bigint) => {
      const env = new LiteStellar();
      const contract = env.deployContract(CONTRACT_DATA);
      const hostFn = invokeHostFn(contract.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
      const sim = env.ledger.simulate(hostFn, env.payer.accountIdB64);
      env.ledger.setCostParams(
        PROTOCOL_27_COST_PARAMS.cpuInstructions,
        PROTOCOL_27_COST_PARAMS.memoryBytes,
        cpuLimit,
        41_943_040n,
      );
      const sent = env.ledger.send(
        hostFn, env.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
      );
      return {
        sent,
        topics: sent.diagnosticEventsXdr
          .map((b) => xdr.DiagnosticEvent.fromXDR(b, 'base64'))
          .flatMap(topicsOf),
      };
    };

    for (const limit of [100_000n, 300_000n, 1_000_000n]) {
      const { sent, topics } = starve(limit);
      expect(sent.ok, `limit ${limit}`).toBe(false);
      expect(sent.error).toContain('Budget, ExceededLimit');
      // A real node names it twice over. Here, nothing in the machine-readable
      // output says "budget".
      expect(topics, `limit ${limit}`).toContain('Error(sceBudget)');
    }
  });

  it('RED: getTransaction() reports no diagnostics at all, where the node reports 24', async () => {
    // The one place an application actually reads diagnostics. Live node:
    //   getTransaction(FAILED)  -> diagnosticEventsXdr.length === 24
    //   getTransaction(SUCCESS) -> diagnosticEventsXdr.length === 21
    // fake-rpc.ts:121 hardcodes `diagnosticEvents: []` in the meta and
    // fake-rpc.ts:187 emits only `events.contractEventsXdr`, so the round-1
    // diagnostics never leave the Ledger.
    const alice: Wallet = svm.airdrop();
    const server: rpc.Server = svm.rpcServer();
    const contract = svm.deployContract(CONTRACT_DATA, { as: alice });

    const account = await server.getAccount(alice.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '1000000', networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({
        func: invokeHostFn(contract.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]),
        auth: [],
      }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(alice.keypair);
    const sent = await server.sendTransaction(assembled);
    const got: any = await server.getTransaction(sent.hash);

    expect(got.status).toBe('SUCCESS');
    expect(got.diagnosticEventsXdr?.length ?? 0).toBeGreaterThan(0);
  });

  it('RED: simulateTransaction().events carries contract events where the node carries diagnostics', async () => {
    // Live node, simulate of put_persistent (which emits NO contract events):
    //   sim.events.length === 2
    //     diagnostic inSuccess=true topics=[fn_call, bytes(32), put_persistent]
    //     diagnostic inSuccess=true topics=[fn_return, put_persistent]
    // fake-rpc.ts:482 fills the same field from `sim.eventsXdr` (contract
    // events) re-wrapped as DiagnosticEvent, so it is empty here.
    const alice: Wallet = svm.airdrop();
    const server: rpc.Server = svm.rpcServer();
    const contract = svm.deployContract(CONTRACT_DATA, { as: alice });

    const account = await server.getAccount(alice.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '1000000', networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({
        func: invokeHostFn(contract.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]),
        auth: [],
      }))
      .setTimeout(60)
      .build();
    const sim: any = await server.simulateTransaction(tx);

    expect(rpc.Api.isSimulationError(sim)).toBe(false);
    expect((sim.events ?? []).map((e: xdr.DiagnosticEvent) => firstTopic(e)))
      .toEqual(['fn_call', 'fn_return']);
  });
});

// ---------------------------------------------------------------------------
// 4. stateHash and the clock, without going through a TTL.
// ---------------------------------------------------------------------------

describe('stateHash: the "restore is exact" claim', () => {
  /**
   * `stateHash()` hashes key || entry || live_until for every entry, and
   * nothing else. `restore()` restores four things: the entry map, ledger_seq,
   * timestamp and prng_counter. Three of the four are outside the hash.
   *
   * test/observability.test.ts:75 "proves snapshot/restore is EXACT, not just
   * correct for known keys" asserts `stateHash() === hash` plus
   * `ledgerSequence === 1_000_000`. That pair cannot observe `timestamp` or
   * `prng_counter` at all: a restore that dropped either would still pass.
   *
   * This test exhibits the blind spot directly — a state change that is
   * invisible to BOTH assertions and decides whether a signed envelope is
   * valid.
   */
  it('RED: timestamp is observable state, and neither stateHash nor ledgerSequence sees it', async () => {
    const alice = svm.airdrop();
    const server = svm.rpcServer();

    const account = await server.getAccount(alice.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: '1000000', networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({
        func: invokeHostFn(c.address, 'put_persistent', [sc.sym('t'), sc.u64(1n)]),
        auth: [],
      }))
      .setTimeout(60)
      .build();
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(alice.keypair);

    const hashBefore = svm.stateHash();
    const seqBefore = svm.ledgerSequence;

    // Move the ledger clock past maxTime. No ledger ENTRY changes.
    svm.setTimestamp(BigInt(assembled.timeBounds!.maxTime) + 1n);

    // Both witnesses the "exact restore" test relies on say nothing happened.
    expect(svm.stateHash()).toBe(hashBefore);
    expect(svm.ledgerSequence).toBe(seqBefore);

    // The envelope that was valid a moment ago is now rejected.
    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txTooLate');

    // So: equal stateHash + equal ledgerSequence, different behaviour. A digest
    // that claims "equal hashes mean byte-identical state" must cover the
    // clock, or the claim has to be narrowed to "equal ENTRY state".
    expect(svm.stateHash()).not.toBe(hashBefore);
  });
});
