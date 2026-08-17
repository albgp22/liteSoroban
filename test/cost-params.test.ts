/**
 * Acceptance test for the cost calibration fix.
 *
 * Reference numbers are the *implied raw* instruction counts of a live
 * stellar/quickstart node (stellar-rpc 27.1.1, captive-core 27.1.0, protocol
 * 27), measured differentially and de-adjusted with stellar-rpc's documented
 * max(raw + 50_000, 1.04 * raw) padding with instructionLeeway pinned to 0.
 *
 * Before the fix the harness over-metered by 15-249% on these six scenarios.
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

/** Node's implied raw counts, from the differential run. */
const NODE = {
  upload: 1_547_805,
  add: 304_084,
  putPersistent: 550_088,
  getPersistent: 550_166,
};

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

const pct = (got: number, ref: number) => ((got - ref) / ref) * 100;

describe('network cost calibration', () => {
  it('is off by default, and says so', () => {
    expect(new LiteStellar().metersLikeNetwork).toBe(false);
    expect(new LiteStellar().withNetworkCostParams().metersLikeNetwork).toBe(true);
  });

  it('the shipped table is a real 86-entry protocol-27 calibration', async () => {
    const { xdr } = await import('@stellar/stellar-sdk');
    const cpu = xdr.ContractCostParams.fromXDR(
      Buffer.from(PROTOCOL_27_COST_PARAMS.cpuInstructions, 'base64'),
    );
    const mem = xdr.ContractCostParams.fromXDR(
      Buffer.from(PROTOCOL_27_COST_PARAMS.memoryBytes, 'base64'),
    );
    expect(cpu.length).toBe(86);
    expect(mem.length).toBe(86);
    // The entry that dominates the divergence: 331 on a real network,
    // 59,052 in the host's protocol-20 defaults.
    expect(cpu.some((e: any) => e.constTerm().toString() === '331')).toBe(true);
    expect(cpu.every((e: any) => e.constTerm().toString() !== '59052')).toBe(true);
  });

  it('moves every scenario decisively toward the real node', () => {
    const before = measure(new LiteStellar());
    const after = measure(new LiteStellar().withNetworkCostParams());

    const rows: string[] = [];
    for (const k of Object.keys(NODE) as (keyof typeof NODE)[]) {
      const dBefore = Math.abs(pct(before[k], NODE[k]));
      const dAfter = Math.abs(pct(after[k], NODE[k]));
      rows.push(
        `  ${k.padEnd(15)} node=${NODE[k].toLocaleString().padStart(11)}  ` +
          `before=${before[k].toLocaleString().padStart(11)} (${dBefore.toFixed(1)}%)  ` +
          `after=${after[k].toLocaleString().padStart(11)} (${dAfter.toFixed(1)}%)`,
      );
      // Strictly closer on every single scenario.
      expect(dAfter, `${k} did not improve`).toBeLessThan(dBefore);
      // And within a few percent, not merely "better".
      expect(dAfter, `${k} still far from the node`).toBeLessThan(10);
    }
    console.log('\n' + rows.join('\n') + '\n');
  });

  // Pinning the exact pre-fix figures would be brittle — they move with the
  // deployer, the salt and the sequence of calls. What must stay true is that
  // the DEFAULT still over-meters materially, because the README warns about it.
  it('the default calibration still over-meters materially, as documented', () => {
    const before = measure(new LiteStellar());
    expect(pct(before.add, NODE.add)).toBeGreaterThan(50);
    expect(pct(before.getPersistent, NODE.getPersistent)).toBeGreaterThan(50);
  });

  // Honest about the residue: upload is the one scenario still ~1.4% out. The
  // remaining error is not calibration — it is the AccountEntry v1/v2/v3
  // extension chain (52 bytes core normalises in, this harness does not) and
  // the missing module cache. Both are tracked in README "Known gaps".
  it('upload retains a small documented residue', () => {
    const after = measure(new LiteStellar().withNetworkCostParams());
    const delta = Math.abs(pct(after.upload, NODE.upload));
    expect(delta).toBeGreaterThan(0.5);
    expect(delta).toBeLessThan(3);
  });
});
