/**
 * Acceptance test for the cost calibration.
 *
 * The reference numbers this file used to compare against were the implied raw
 * instruction counts of a protocol-27 stellar/quickstart node (stellar-rpc
 * 27.1.1, captive-core 27.1.0), measured with soroban-env-host 27.0.1. The
 * pinned host is now 30.0.0, whose own metering moved in 28.0.0, so those
 * numbers no longer describe it; see README "Read this before trusting a
 * number". Re-capture against a protocol-29 node before comparing again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LiteStellar, sc } from '../src/litestellar.js';
import { uploadWasmHostFn, invokeHostFn } from '../src/index.js';
import { PROTOCOL_27_COST_PARAMS } from '../src/cost-params.js';

const f = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const ADD_I32 = f('add_i32.wasm');
const CONTRACT_DATA = f('contract_data.wasm');

function measure(svm: LiteStellar) {
  const payer = svm.payer.accountIdB64;
  const upload = svm.ledger.simulate(uploadWasmHostFn(ADD_I32), payer).instructions;

  const adder = svm.deployContract(ADD_I32);
  const add = svm.ledger
    .simulate(invokeHostFn(adder.address, 'add', [sc.i32(2), sc.i32(3)]), payer)
    .instructions;

  const store = svm.deployContract(CONTRACT_DATA);
  const putFn = invokeHostFn(store.address, 'put_persistent', [sc.sym('k'), sc.u64(42n)]);
  const putPersistent = svm.ledger.simulate(putFn, payer).instructions;
  store.invoke('put_persistent', [sc.sym('k'), sc.u64(42n)]);
  const getPersistent = svm.ledger
    .simulate(invokeHostFn(store.address, 'get_persistent', [sc.sym('k')]), payer)
    .instructions;

  return { upload, add, putPersistent, getPersistent };
}

describe('network cost calibration', () => {
  it('is off by default, and says so', () => {
    expect(new LiteStellar().metersLikeNetwork).toBe(false);
    expect(new LiteStellar().withNetworkCostParams().metersLikeNetwork).toBe(true);
  });

  it('the shipped table is a real 86-entry protocol-27 calibration', async () => {
    const { xdr } = await import('@stellar/stellar-sdk');
    const cpu = xdr.decodeArray(
      xdr.ContractCostParamEntry,
      Buffer.from(PROTOCOL_27_COST_PARAMS.cpuInstructions, 'base64'),
    );
    const mem = xdr.decodeArray(
      xdr.ContractCostParamEntry,
      Buffer.from(PROTOCOL_27_COST_PARAMS.memoryBytes, 'base64'),
    );
    expect(cpu.length).toBe(86);
    expect(mem.length).toBe(86);
    // The entry that dominates the divergence: 331 on a real network,
    // 59,052 in the host's protocol-20 defaults.
    expect(cpu.some((e: any) => e.constTerm.toString() === '331')).toBe(true);
    expect(cpu.every((e: any) => e.constTerm.toString() !== '59052')).toBe(true);
  });

  // soroban-env-host 28.0.0 replaced its protocol-20 `Budget::default()` with
  // the live network's calibration: all 86 CPU and 86 memory entries equal the
  // shipped table. On the pinned host, installing it changes no count at all.
  it('the pinned host already meters with the shipped table', () => {
    const before = measure(new LiteStellar());
    const after = measure(new LiteStellar().withNetworkCostParams());
    expect(after).toEqual(before);
  });

  // ...which would also be the symptom of a setCostParams that is not wired
  // through, so prove a table that DIFFERS from the host's defaults still takes
  // effect: restore the protocol-20 ValDeser const_term (59,052 vs 331).
  it('a table that differs from the host defaults still takes effect', async () => {
    const { xdr } = await import('@stellar/stellar-sdk');
    const cpu = xdr.decodeArray(
      xdr.ContractCostParamEntry,
      Buffer.from(PROTOCOL_27_COST_PARAMS.cpuInstructions, 'base64'),
    );
    const valDeser = xdr.ContractCostType.valDeser.value;
    cpu[valDeser] = new xdr.ContractCostParamEntry({
      ext: xdr.ExtensionPoint.v0(),
      constTerm: 59_052n,
      linearTerm: cpu[valDeser].linearTerm,
    });
    // The ContractCostParams typedef is a length-prefixed ContractCostParamEntry
    // array; see encodeParams in src/cost-params.ts.
    const cpuInstructions = xdr.encodeArray(xdr.ContractCostParamEntry, cpu, 'base64');

    const host = measure(new LiteStellar());
    const p20ValDeser = measure(
      new LiteStellar().withNetworkCostParams({ ...PROTOCOL_27_COST_PARAMS, cpuInstructions }),
    );
    for (const k of Object.keys(host) as (keyof typeof host)[]) {
      expect(p20ValDeser[k], `${k} ignored the installed table`).toBeGreaterThan(host[k]);
    }
  });
});
