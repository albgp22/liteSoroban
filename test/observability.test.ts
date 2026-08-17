/**
 * The observability surface: diagnostics, exact state comparison, and failures
 * that are observable rather than thrown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { LiteStellar, sc } from '../src/litestellar.js';
import { invokeHostFn } from '../src/index.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);

describe('observability', () => {
  let svm: LiteStellar;

  beforeEach(() => {
    svm = new LiteStellar();
  });

  describe('diagnostic events', () => {
    it('are returned on SUCCESS, with the fn_call/fn_return tree', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const r = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);

      expect(r.ok).toBe(true);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      const topics = r.diagnostics.flatMap((d) =>
        d.event().body().v0().topics().map((t) => scValToNative(t)),
      );
      expect(topics).toContain('fn_call');
      expect(topics).toContain('fn_return');
    });

    it('are returned on FAILURE too — that is the whole point', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const r = c.tryInvoke('get_persistent', [sc.sym('missing')]);

      expect(r.ok).toBe(false);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      const topics = r.diagnostics.flatMap((d) =>
        d.event().body().v0().topics().map((t) => {
          try {
            return scValToNative(t);
          } catch {
            return null;
          }
        }),
      );
      expect(topics).toContain('error');
    });

    it('decode as real DiagnosticEvent XDR', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const r = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
      for (const d of r.diagnostics) {
        expect(d).toBeInstanceOf(xdr.DiagnosticEvent);
        expect(typeof d.inSuccessfulContractCall()).toBe('boolean');
      }
    });
  });

  describe('stateHash', () => {
    it('is stable for identical state and differs after a write', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const before = svm.stateHash();
      expect(svm.stateHash()).toBe(before); // pure read

      c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
      expect(svm.stateHash()).not.toBe(before);
    });

    it('proves snapshot/restore is EXACT, not just correct for known keys', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      c.invoke('put_persistent', [sc.sym('a'), sc.u64(1n)]);

      const snap = svm.snapshot();
      const hash = svm.stateHash();

      c.invoke('put_persistent', [sc.sym('b'), sc.u64(2n)]);
      c.invoke('put_persistent', [sc.sym('c'), sc.u64(3n)]);
      svm.advanceLedgers(37);
      expect(svm.stateHash()).not.toBe(hash);

      svm.restore(snap);
      // Byte-identical, across every key in the ledger — not just the ones
      // this test happens to know about.
      expect(svm.stateHash()).toBe(hash);
      expect(svm.ledgerSequence).toBe(1_000_000); // the clock rolled back too
    });

    it('two environments built the same way are NOT equal (keys are random)', () => {
      const a = new LiteStellar();
      const b = new LiteStellar();
      a.deployContract(CONTRACT_DATA);
      b.deployContract(CONTRACT_DATA);
      // Different random payer keypairs => different state. If these ever match,
      // something is being shared between environments.
      expect(a.stateHash()).not.toBe(b.stateHash());
    });

    it('sandboxed() leaves the ledger byte-identical', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const hash = svm.stateHash();
      svm.sandboxed(() => {
        c.invoke('put_persistent', [sc.sym('tmp'), sc.u64(9n)]);
      });
      expect(svm.stateHash()).toBe(hash);
    });
  });

  describe('allKeys', () => {
    it('enumerates the whole ledger, and grows with writes', () => {
      const before = svm.allKeys();
      expect(before.length).toBe(svm.entryCount);

      const c = svm.deployContract(CONTRACT_DATA);
      c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);

      const after = svm.allKeys();
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.length).toBe(svm.entryCount);
      // Every key decodes.
      for (const k of after) expect(() => xdr.LedgerKey.fromXDR(k, 'base64')).not.toThrow();
    });
  });

  describe('failures are observable, not thrown', () => {
    it('a malformed footprint comes back as ok:false, not as a thrown JsError', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
      const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
      expect(sim.ok).toBe(true);
      const before = svm.stateHash();

      // Strip the footprint the simulation computed. This used to escape as a
      // JsError out of wasm, which no caller could observe as a failed
      // transaction — strictly worse than a wrong answer.
      const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
      resources.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));

      const sent = svm.ledger.send(
        hostFn,
        svm.payer.accountIdB64,
        resources.toXDR('base64'),
        sim.authXdr,
        [],
      );
      expect(sent.ok).toBe(false);
      expect(sent.error).toBeTruthy();
      // ...and the failed transaction applied nothing at all.
      expect(svm.stateHash()).toBe(before);
    });

    it('reports memory consumption alongside instructions', () => {
      const c = svm.deployContract(CONTRACT_DATA);
      const hostFn = invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(1n)]);
      const sim = svm.ledger.simulate(hostFn, svm.payer.accountIdB64);
      const sent = svm.ledger.send(
        hostFn, svm.payer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
      );
      expect(sent.ok).toBe(true);
      expect(sent.cpuInsns).toBeGreaterThan(0n);
      expect(sent.memBytes).toBeGreaterThan(0n);
    });
  });
});
