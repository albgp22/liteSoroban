/**
 * ADVERSARIAL AUDIT of the round-1 observability surface
 * (commit 09762df: diagnostics, stateHash, allKeys, mem_bytes, ttlChangedKeys,
 * non-throwing send).
 *
 * Every test in here asserts the behaviour the surface CLAIMS, against ground
 * truth (soroban-env-host 27.0.1 / stellar-core master), not against what the
 * harness happens to return. RED tests pin a real gap.
 *
 * Ground-truth references:
 *   host  e2e_invoke.rs:487   extract_diagnostic_events runs only AFTER
 *                             `host.try_finish()?` — every `?` before it leaves
 *                             `diagnostic_events` EMPTY.
 *   core  src/rust/src/soroban_proto_any.rs:537  on that same top-level-error
 *                             path core PUSHES a synthetic `host_fn_failed`
 *                             diagnostic event carrying the error code.
 *   host  budget.rs:1412-1418 get_cpu_insns_consumed / get_mem_bytes_consumed
 *                             return the NON-shadow counters, so diagnostics
 *                             (charged in shadow mode) cannot inflate them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { LiteStellar, sc } from '../../src/litestellar.js';
import { invokeHostFn, Ledger } from '../../src/index.js';
import { PROTOCOL_27_COST_PARAMS } from '../../src/cost-params.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);

const topicsOf = (d: xdr.DiagnosticEvent): string[] =>
  d.event().body().v0().topics().map((t: any) => {
    try {
      const n = scValToNative(t);
      return typeof n === 'string' ? n : t.switch().name;
    } catch {
      return t.switch().name;
    }
  });

// ---------------------------------------------------------------------------
// 1. The non-throwing send path returns ZERO diagnostics — always.
// ---------------------------------------------------------------------------

describe('send: the top-level-host-error path', () => {
  /**
   * The only way to reach the branch added in round 1 is a HostError returned
   * by `invoke_host_function` ITSELF (not one captured inside
   * `encoded_invoke_result`). Budget exhaustion during the enforcing pass does
   * exactly that.
   */
  const budgetBlownSend = () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    expect(sim.ok).toBe(true);
    // Shrink the ceiling AFTER simulating, so the enforcing pass dies in the
    // host's own setup rather than inside the contract.
    svm.ledger.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      10_000n,
      41_943_040n,
    );
    return svm.ledger.send(
      hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
  };

  it('does return ok:false rather than throwing (the round-1 fix works)', () => {
    const sent = budgetBlownSend();
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('Budget, ExceededLimit');
  });

  it('RED: attaches NO diagnostics, though that is the branch that promised them', () => {
    const sent = budgetBlownSend();
    // The commit message: "It now returns { ok: false } with the diagnostics
    // attached." The host has not populated `diagnostic_events` at that point
    // (e2e_invoke.rs:487 is unreachable once an earlier `?` fires), so the
    // vector encode_diagnostics() serialises is empty by construction.
    // stellar-core, on this identical path, pushes a `host_fn_failed`
    // diagnostic event so the failure is still explicable downstream.
    expect(sent.diagnosticEventsXdr.length).toBeGreaterThan(0);
  });

  it('contrast: a failure raised INSIDE the invocation does carry diagnostics', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    const r = c.tryInvoke('get_persistent', [sc.sym('missing')]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.flatMap(topicsOf)).toContain('error');
  });

  it('RED: the round-1 regression test never reaches the round-1 code', () => {
    // observability.test.ts strips the footprint and asserts ok:false, calling
    // that proof the failure "used to escape as a JsError". It does not: a
    // footprint violation is raised INSIDE host.invoke_function and lands in
    // `encoded_invoke_result`, which the pre-round-1 code already returned as
    // ok:false. Confirmed by rebuilding the crate with the new branch reverted
    // to `.map_err(host_err)?` — that scenario still returns ok:false there.
    //
    // The two branches have a visible signature: the pre-existing one carries
    // diagnostics, the new one never does. If the stripped-footprint scenario
    // really exercised the new branch, the two counts would agree.
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    res.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));
    const stripped = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, res.toXDR('base64'), sim.authXdr, [],
    );
    expect(stripped.ok).toBe(false);
    expect(stripped.diagnosticEventsXdr.length)
      .toBe(budgetBlownSend().diagnosticEventsXdr.length);
  });
});

// ---------------------------------------------------------------------------
// 2. simulate() was never made non-throwing.
// ---------------------------------------------------------------------------

describe('simulate: still throws where send no longer does', () => {
  it('RED: a budget-exhausted simulation throws a JsError instead of ok:false', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    svm.ledger.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      10_000n,
      41_943_040n,
    );
    const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    // simulate_inner still ends in `.map_err(host_err)?`, so the caller cannot
    // observe this as a failed simulation, and the diagnostics collected so far
    // are dropped with the error.
    expect(() => svm.ledger.simulate(hostFn, svm.payer.accountIdB64)).not.toThrow();
  });

  it('RED: tryInvoke — documented as the non-throwing form — throws too', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    svm.withNetworkCostParams({ ...PROTOCOL_27_COST_PARAMS, cpuLimit: 10_000n });
    expect(() => c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. stateHash is not a digest of all ledger state.
// ---------------------------------------------------------------------------

describe('stateHash: what it actually covers', () => {
  it('RED: the clock is not hashed, so "byte-identical" can mean live vs expired', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_temporary', [sc.sym('k'), sc.u64(7n)]);

    const before = svm.stateHash();
    expect(c.tryInvoke('has_temporary', [sc.sym('k')]).value).toBe(true);

    svm.advanceLedgers(100); // past the 16-ledger minimum temporary TTL
    const after = svm.stateHash();

    // The very same key is now gone as far as the contract is concerned...
    expect(c.tryInvoke('has_temporary', [sc.sym('k')]).value).toBe(false);
    // ...and the entry is still enumerated by allKeys().
    expect(svm.allKeys().length).toBe(svm.entryCount);
    // ...yet stateHash says nothing changed. ledger_seq, timestamp and
    // prng_counter are all restored by restore() but none of them is hashed.
    expect(after).not.toBe(before);
  });

  it('RED: TTL "absent" and TTL 0 collide — live_until.unwrap_or(0)', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);

    const keys = svm.allKeys();
    const instanceKey = keys.find((k) => {
      const lk = xdr.LedgerKey.fromXDR(k, 'base64');
      return lk.switch().name === 'contractData'
        && lk.contractData().key().switch().name === 'scvLedgerKeyContractInstance';
    })!;

    const clone = (instanceTtl: number | undefined) => {
      const l = new Ledger();
      for (const k of keys) {
        l.putEntry(svm.ledger.getEntry(k)!, k === instanceKey ? instanceTtl : svm.ledger.getEntryTtl(k));
      }
      return l;
    };
    const noTtl = clone(undefined);   // live_until = None
    const zeroTtl = clone(0);         // live_until = Some(0)

    // The harness itself distinguishes them: getEntryTtl reports undefined vs 0,
    // and send() feeds the host `live_until.unwrap_or(self.ledger_seq)` for the
    // first and treats the second as an expired entry.
    expect(noTtl.getEntryTtl(instanceKey)).toBeUndefined();
    expect(zeroTtl.getEntryTtl(instanceKey)).toBe(0);

    expect(noTtl.stateHash()).not.toBe(zeroTtl.stateHash());
  });

  it('RED: equal stateHash, and one of the two ledgers cannot even be simulated', () => {
    // The sharpest form of the same collision: two ledgers the hash calls
    // identical, where a plain read succeeds against one and blows up the host
    // against the other (get_ledger_changes' `old_live_until_ledger
    // .ok_or_else(internal_error)?`).
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const keys = svm.allKeys();
    const instanceKey = keys.find((k) => {
      const lk = xdr.LedgerKey.fromXDR(k, 'base64');
      return lk.switch().name === 'contractData'
        && lk.contractData().key().switch().name === 'scvLedgerKeyContractInstance';
    })!;
    const clone = (instanceTtl: number | undefined) => {
      const l = new Ledger();
      for (const k of keys) {
        l.putEntry(svm.ledger.getEntry(k)!, k === instanceKey ? instanceTtl : svm.ledger.getEntryTtl(k));
      }
      return l;
    };
    const a = clone(undefined);
    const b = clone(0);
    expect(a.stateHash()).toBe(b.stateHash()); // the collision, restated

    const hostFn = invokeHostFn(c.address, 'get_persistent', [sc.sym('k')]);
    const outcome = (l: Ledger) => {
      try {
        return l.simulate(hostFn, svm.payer.accountIdB64).ok ? 'ok' : 'failed';
      } catch (e: any) {
        return 'threw: ' + String(e?.message ?? e).split('\n')[0];
      }
    };
    // Equal hashes must imply equal behaviour, or the hash is not a state digest.
    expect(outcome(a)).toBe(outcome(b));
  });
});

// ---------------------------------------------------------------------------
// 4. Things that hold up. Keep these green — they are the regression fence.
// ---------------------------------------------------------------------------

describe('verified against the host', () => {
  it('diagnostics are complete and in host order: fn_call, events, fn_return', () => {
    const svm = new LiteStellar();
    const token = svm.deployToken({ code: 'USDC' });
    const alice = svm.airdrop();
    token.trust(alice);
    const hostFn = invokeHostFn(token.address, 'mint', [alice.scAddress, sc.i128(1000n)]);
    const sim = svm.ledger.simulate(hostFn, token.issuer.accountIdB64);
    const sent = svm.ledger.send(
      hostFn, token.issuer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(true);

    const diags = sent.diagnosticEventsXdr.map((b) => xdr.DiagnosticEvent.fromXDR(b, 'base64'));
    // extract_diagnostic_events pushes EVERY host event, contract events
    // included, in chronological order — same as core's TransactionMeta.
    expect(diags.map((d) => d.event().type().name)).toEqual([
      'diagnostic', 'contract', 'diagnostic',
    ]);
    expect(topicsOf(diags[0])[0]).toBe('fn_call');
    expect(topicsOf(diags[1])[0]).toBe('mint');
    expect(topicsOf(diags[2])[0]).toBe('fn_return');
    // The contract event is ALSO in eventsXdr, exactly once.
    expect(sent.eventsXdr.length).toBe(1);
    expect(diags.every((d) => d.inSuccessfulContractCall())).toBe(true);
  });

  it('ttlChangedKeys reports a read-only TTL bump that changedKeys cannot show', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const dataKey = svm.allKeys().find((k) => {
      const lk = xdr.LedgerKey.fromXDR(k, 'base64');
      return lk.switch().name === 'contractData'
        && lk.contractData().key().switch().name === 'scvSymbol';
    })!;
    const ttlBefore = svm.ledger.getEntryTtl(dataKey)!;

    const hostFn = invokeHostFn(c.address, 'extend_persistent', [
      sc.sym('k'), sc.u32(200_000), sc.u32(500_000),
    ]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    expect(sim.readWriteKeys.length).toBe(0); // purely read-only footprint
    const sent = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(true);
    expect(sent.changedKeys).toEqual([]);
    expect(sent.ttlChangedKeys).toEqual([dataKey]);
    expect(svm.ledger.getEntryTtl(dataKey)!).toBeGreaterThan(ttlBefore);
  });

  it('a pure read reports no change at all', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const before = svm.stateHash();
    const hostFn = invokeHostFn(c.address, 'get_persistent', [sc.sym('k')]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    const sent = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    expect(sent.changedKeys).toEqual([]);
    expect(sent.removedKeys).toEqual([]);
    expect(sent.ttlChangedKeys).toEqual([]);
    expect(svm.stateHash()).toBe(before);
  });

  it('mem_bytes tracks the non-shadow memory dimension, on both results', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
    const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
    const sent = svm.ledger.send(
      hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    expect(sim.memBytes).toBeGreaterThan(0n);
    expect(sent.memBytes).toBeGreaterThan(0n);
    // The enforcing pass parses the Wasm module itself (module_cache: None),
    // so it must consume strictly more of both dimensions than recording did.
    expect(sent.memBytes).toBeGreaterThan(sim.memBytes);
    expect(sent.cpuInsns).toBeGreaterThan(sim.cpuInsns);
  });
});
