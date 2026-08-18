/**
 * Fresh-eyes review findings, demonstrated at the PUBLIC FACADE level
 * (`LiteStellar`), i.e. the API GUIDE.md tells a newcomer to use.
 *
 * Both are silent-wrong-answer bugs: nothing throws, nothing is logged, the
 * state is simply not what the caller asked for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LiteStellar, sc } from '../../src/litestellar.js';

const CONTRACT_DATA = readFileSync(new URL('../fixtures/contract_data.wasm', import.meta.url));

describe('facade: snapshot handles are not scoped to their ledger', () => {
  /**
   * `snapshot()` returns a bare per-instance index (crates/host-wasm/src/lib.rs
   * snapshot vec), so the FIRST snapshot of every LiteStellar is `0`. Handles
   * from different instances are therefore interchangeable, and `restore()`
   * happily rolls the wrong ledger back to the wrong state.
   *
   * GUIDE.md "Test isolation" hands the reader both `new LiteStellar()` per
   * test AND `snapshot()`/`restore()`, so holding two worlds at once is a
   * documented pattern, not an exotic one.
   */
  it('DEFECT: ledger B accepts a snapshot handle issued by ledger A and silently rolls itself back', () => {
    const a = new LiteStellar();
    const b = new LiteStellar();
    const ca = a.deployContract(CONTRACT_DATA);
    const cb = b.deployContract(CONTRACT_DATA);

    ca.invoke('put_persistent', [sc.sym('a'), sc.u64(1n)]);
    const handleFromA = a.snapshot();

    cb.invoke('put_persistent', [sc.sym('b'), sc.u64(100n)]);
    b.snapshot(); // B's own first snapshot — same numeric handle as A's
    cb.invoke('put_persistent', [sc.sym('b'), sc.u64(999n)]);

    expect(handleFromA).toBe(0); // the handle carries no ledger identity
    expect(cb.view('get_persistent', [sc.sym('b')])).toBe(999n);
    const bBefore = b.stateHash();

    let threw: unknown = null;
    try {
      b.restore(handleFromA);
    } catch (e) {
      threw = e;
    }

    // Observed: no throw, and B mutated to 100n — B's own snapshot, not A's.
    expect(b.stateHash(), "B's state was silently mutated by a foreign handle")
      .toBe(bBefore);
    expect(threw, "B accepted a snapshot handle it never issued").not.toBeNull();
  });
});

describe('facade: the ledger clock is only guarded in one direction', () => {
  /**
   * `warpToLedger` refuses to go backwards, with an excellent message
   * ("cannot warp backwards: at 1005000, asked 500000"). `setTimestamp` — listed
   * directly beneath it in GUIDE.md "Time travel", under the same
   * "forward only" note — has no such guard and silently rewinds the clock.
   *
   * Consequence: timebounds and TTL reasoning can be invalidated mid-test with
   * no signal, and `svm.timestamp` disagrees with `svm.ledgerSequence`.
   */
  it('DEFECT: setTimestamp silently moves the clock backwards', () => {
    const svm = new LiteStellar();
    const t0 = Number(svm.timestamp);

    svm.warpToLedger(svm.ledgerSequence + 5_000);
    svm.setTimestamp(t0 + 100_000);
    expect(Number(svm.timestamp)).toBe(t0 + 100_000);

    let threw: unknown = null;
    try {
      svm.setTimestamp(t0 - 100_000); // backwards
    } catch (e) {
      threw = e;
    }

    expect(threw, 'setTimestamp accepted a backwards jump').not.toBeNull();
    expect(Number(svm.timestamp)).toBeGreaterThanOrEqual(t0 + 100_000);
  });

  it('CONTRAST (green): warpToLedger does guard, and says so clearly', () => {
    const svm = new LiteStellar();
    svm.warpToLedger(svm.ledgerSequence + 5_000);
    expect(() => svm.warpToLedger(1)).toThrow(/cannot warp backwards/);
  });
});
