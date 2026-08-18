/**
 * ROUND-2 ADVERSARIAL RE-TEST of round-1 fix 11:
 * "send() returns {ok:false} rather than throwing".
 *
 * crates/host-wasm/src/lib.rs wraps ONLY `invoke_host_function`:
 *
 *   let res = match res { Ok(r) => r, Err(e) => { ...ok:false... } };
 *
 * `simulate_inner` still does
 *
 *   invoke_host_function_in_recording_mode(...).map_err(host_err)?
 *
 * so a top-level host error in RECORDING mode is still a thrown JsError. That
 * matters because every documented non-throwing entry point on the facade
 * (`Contract.tryInvoke`, `LiteStellar.invokeContract` -> `applyHostFn`) calls
 * `simulate` FIRST (src/litestellar.ts:558).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { LiteStellar, sc } from '../../src/litestellar.js';
import { PROTOCOL_27_COST_PARAMS } from '../../src/cost-params.js';
import { accountIdFromPublicKey } from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');

function scaffold(L: Ledger) {
  const dep = Keypair.random();
  L.fund(dep.publicKey());
  const wasmHash = L.seedWasm(CODE);
  const { sent } = L.simulateAndSend(
    createContractHostFn(accB64(dep.publicKey()), wasmHash),
    accB64(dep.publicKey()),
  );
  return {
    src: accB64(dep.publicKey()),
    addr: xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address(),
  };
}

describe('ROUND 2 — fix 11: non-throwing failures', () => {
  it('HOLDS: send() returns ok:false on a footprint violation instead of throwing', () => {
    const L = new Ledger();
    const { src, addr } = scaffold(L);
    const fn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim = L.simulate(fn, src);
    // Strip the read-write footprint: the write is now outside it.
    const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const stripped = new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: res.footprint().readOnly(), readWrite: [] }),
      instructions: res.instructions(),
      diskReadBytes: res.diskReadBytes(),
      writeBytes: res.writeBytes(),
    });
    let sent: any;
    expect(() => {
      sent = L.send(fn, src, stripped.toXDR('base64'), sim.authXdr, []);
    }).not.toThrow();
    expect(sent.ok).toBe(false);
    expect(sent.error).toBeTruthy();
  });

  it('HOLDS: send() returns ok:false when the declared instruction budget is exceeded', () => {
    const L = new Ledger();
    const { src, addr } = scaffold(L);
    // Turned on only AFTER the deploy: the crate documents that enforcing the
    // declared count makes every deploy fail (module cache is not wired up).
    (L as any).env.enforceDeclaredResources(true);
    const fn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim = L.simulate(fn, src);
    const res = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const tiny = new xdr.SorobanResources({
      footprint: res.footprint(),
      instructions: 1_000,
      diskReadBytes: res.diskReadBytes(),
      writeBytes: res.writeBytes(),
    });
    let sent: any;
    expect(() => {
      sent = L.send(fn, src, tiny.toXDR('base64'), sim.authXdr, sim.restoredRwEntryIndices);
    }).not.toThrow();
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Budget|ExceededLimit/);
  });

  it('DEFECT: simulate() still throws a raw Error where send() returns ok:false', () => {
    // Same underlying condition — a CPU limit too small for the invocation —
    // reported two incompatible ways.
    const L = new Ledger();
    const { src, addr } = scaffold(L);
    const fn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim0 = L.simulate(fn, src);
    expect(sim0.ok).toBe(true);

    // A real network cost table with an absurdly small CPU limit.
    L.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      1_000n,
      41_943_040n,
    );

    // send() is fine: it reports the failure.
    const sent = L.send(fn, src, sim0.resourcesXdr, sim0.authXdr, sim0.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);

    // simulate() throws instead of returning { ok: false, error }.
    let out: any;
    expect(() => {
      out = L.simulate(fn, src);
    }, 'simulate() must report failures the same way send() does').not.toThrow();
    expect(out.ok).toBe(false);
  });

  it('DEFECT (facade): Contract.tryInvoke() is documented as non-throwing but propagates it', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const c = svm.deployContract(CODE, { as: alice });
    expect(c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]).ok).toBe(true);

    svm.ledger.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      1_000n,
      41_943_040n,
    );

    let r: any;
    expect(() => {
      r = c.tryInvoke('put_persistent', [sc.sym('k2'), sc.u64(1n)]);
    }, 'tryInvoke must never throw — that is its whole contract').not.toThrow();
    expect(r.ok).toBe(false);
  });
});
