/**
 * DIFFERENTIAL AUDIT of the cost-calibration fix, against the live protocol-27
 * quickstart node (stellar-rpc 27.1.1 / captive-core 27.1.0) at
 * http://localhost:8000/rpc.
 *
 * Every "node" number below was MEASURED, not inferred, in two independent ways:
 *
 *  (1) PREFLIGHT — `simulateTransaction` with `resourceConfig.instructionLeeway`
 *      pinned to 0. stellar-rpc pads the recorded count with
 *      `SimulationAdjustmentFactor::adjust_u32`
 *      (rs-soroban-env/soroban-simulation/src/resources.rs:35):
 *
 *          value == 0 ? 0
 *                     : max(value + additive, floor(value as f64 * mult))
 *
 *      with `instructions: (mult 1.04, additive 50_000)` from
 *      `SimulationAdjustmentConfig::default_adjustment()` (simulation.rs:342) and
 *      `additive = max(additive, instruction_leeway)` (preflight/src/shared.rs),
 *      so leeway 0 leaves the 50_000 in place. Confirmed empirically on the node
 *      by scanning the leeway: for `add(2,3)` the node returns 353_123 at leeway
 *      0/1_000/50_000, 353_124 at 50_001, 403_123 at 100_000, 1_303_123 at
 *      1_000_000 and 20_303_123 at 20_000_000 — i.e. raw + max(50_000, leeway),
 *      pinning raw at exactly 303_123.
 *
 *  (2) APPLY — stellar-core emits `core_metrics`/`cpu_insn` and
 *      `core_metrics`/`mem_byte` diagnostic events for every InvokeHostFunction
 *      op (InvokeHostFunctionOpFrame.cpp:1026 and :1028). Submitting the same
 *      transaction and reading those events off `getTransaction` gives the real
 *      node's ENFORCING budget consumption with no padding and no inference —
 *      and it is the only way to see the node's MEMORY number at all, since
 *      SorobanResources carries no memory field.
 *
 * VERDICT, up front: on the PREFLIGHT path the calibrated harness is not
 * "within ~1%", it is EXACT — 0 instructions of difference on 9 of 12
 * scenarios. Two real gaps remain, and both are wider than README says.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from '../../src/index.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from '../../src/cost-params.js';
import { preFundedWallet, nativeToken } from '../../src/fixtures.js';

const PASS = 'Standalone Network ; February 2017';
const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

const ADD_I32 = fixture('add_i32.wasm');
const CONTRACT_DATA = fixture('contract_data.wasm');
const INVOKE_CONTRACT = fixture('invoke_contract.wasm');
const ERR = fixture('err.wasm');
const ALLOC = fixture('alloc.wasm');

/**
 * add_i32.wasm plus a 20-byte custom section. The point is a blob the node had
 * demonstrably never stored: the round-1 differential compared the harness's
 * FRESH upload of add_i32.wasm against a node that already held that ContractCode
 * entry (the preflight came back `readWrite: []`, `writeBytes: 0`), which is not
 * the same operation and is where the "~1.4% upload residue" comes from.
 */
const UNIQUE = (() => {
  const suffix = Buffer.from('0012017510e3485048a8bc11bddff35fc8f506ac', 'hex');
  return new Uint8Array(Buffer.concat([Buffer.from(ADD_I32), suffix]));
})();

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

/** exactly what crates/host-wasm/src/lib.rs:103 does, and what rpc does */
const pad = (raw: number) => Math.max(raw + 50_000, Math.floor((raw * 104) / 100));
/** invert it */
function deadjust(padded: number): number {
  const additive = padded - 50_000;
  if (pad(additive) === padded) return additive;
  for (let r = Math.floor(padded / 1.04) - 2; r <= Math.floor(padded / 1.04) + 2; r++) {
    if (pad(r) === padded) return r;
  }
  throw new Error(`no raw count pads to ${padded}`);
}

// ---------------------------------------------------------------------------
// what the node returned
// ---------------------------------------------------------------------------

/** `simulateTransaction`, instructionLeeway 0 — i.e. already padded. */
const NODE_PREFLIGHT_PADDED = {
  uploadUnique: 1_603_797,
  deploy: 579_166,
  add: 353_123,
  putPersistent: 599_484,
  getPersistent: 599_562,
  largeWrite: 644_696,
  crossContract: 765_982,
  sacMint: 228_048,
  contractSacTransfer: 658_120,
  sacToAccount: 235_414,
  sacToContract: 262_515,
  checkAuthEnforcing: 3_261_748,
};

/** `core_metrics` diagnostic events off the applied transaction. */
const NODE_APPLY = {
  uploadUnique2: { cpu: 1_540_336, mem: 1_447_946 },
  deploy: { cpu: 516_432, mem: 2_267_630 },
  add: { cpu: 298_100, mem: 1_146_659 },
  putPersistent: { cpu: 541_405, mem: 1_181_784 },
  getPersistent: { cpu: 541_868, mem: 1_182_523 },
  largeWrite: { cpu: 584_524, mem: 1_223_301 },
  crossContract: { cpu: 704_534, mem: 2_437_186 },
  failing: { cpu: 395_573, mem: 1_206_651 },
  sacToAccount: { cpu: 162_989, mem: 57_951 },
  sacToContract: { cpu: 193_100, mem: 65_302 },
  sum128: { cpu: 15_312_664, mem: 2_536_271 },
  sum300: { cpu: 50_516_404, mem: 5_813_103 },
};

// ---------------------------------------------------------------------------
// the same scenarios, in process
// ---------------------------------------------------------------------------

interface Row {
  sim: number;
  simMem: number;
  writeBytes: number;
  readBytes: number;
  sentCpu?: number;
  sentMem?: number;
}

function build() {
  const L = new Ledger({ networkPassphrase: PASS });
  L.setCostParams(
    PROTOCOL_27_COST_PARAMS.cpuInstructions,
    PROTOCOL_27_COST_PARAMS.memoryBytes,
    P27_CPU_LIMIT,
    P27_MEM_LIMIT,
  );
  const payer = preFundedWallet(L);
  const source = payer.accountIdB64;
  const rows: Record<string, Row> = {};

  const record = (k: string, sim: any, sent?: any) => {
    rows[k] = {
      sim: sim.instructions,
      simMem: Number(sim.memBytes),
      writeBytes: sim.writeBytes,
      readBytes: sim.readBytes,
      sentCpu: sent ? Number(sent.cpuInsns) : undefined,
      sentMem: sent ? Number(sent.memBytes) : undefined,
    };
  };
  const both = (k: string, hf: xdr.HostFunction, src = source) => {
    const sim = L.simulate(hf, src);
    expect(sim.ok, `${k}: ${sim.error}`).toBe(true);
    const sent = L.send(hf, src, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `${k} apply: ${sent.error}`).toBe(true);
    record(k, sim, sent);
    return sent;
  };
  const deploy = (code: Uint8Array, salt: number) => {
    const h = L.seedWasm(code);
    const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, salt)), source);
    expect(sent.ok, `deploy: ${sent.error}`).toBe(true);
    return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  };

  both('uploadUnique', uploadWasmHostFn(UNIQUE));

  const addHash = L.seedWasm(ADD_I32);
  both('deploy', createContractHostFn(source, addHash, Buffer.alloc(32, 41)));
  const adder = deploy(ADD_I32, 11);
  both('add', invokeHostFn(adder, 'add', [i32(2), i32(3)]));

  const store = deploy(CONTRACT_DATA, 42);
  both('putPersistent', invokeHostFn(store, 'put_persistent', [sym('k'), u64(42n)]));
  both('getPersistent', invokeHostFn(store, 'get_persistent', [sym('k')]));
  both('largeWrite', invokeHostFn(store, 'replace_with_bytes_and_extend', [sym('k'), u32(5), u32(100), u32(10_000)]));

  const A = deploy(INVOKE_CONTRACT, 43);
  const B = deploy(INVOKE_CONTRACT, 44);
  both('crossContract', invokeHostFn(A, 'add_with', [i32(3), i32(4), addrV(B)]));

  const al = deploy(ALLOC, 46);
  both('sum128', invokeHostFn(al, 'sum', [u32(128)]));
  both('sum300', invokeHostFn(al, 'sum', [u32(300)]));

  // a call that fails: rpc answers a failing preflight with a JSON-RPC error and
  // no resources at all, so the only comparable node number is the applied one.
  const errC = deploy(ERR, 45);
  {
    const hf = invokeHostFn(errC, 'err_eek', []);
    const sim = L.simulate(hf, source);
    expect(sim.ok).toBe(false);
    const cheapFootprint = sim.resourcesXdr;
    const sent = L.send(hf, source, cheapFootprint, sim.authXdr, []);
    record('failing', sim, sent);
  }

  const dest = preFundedWallet(L);
  const nat = nativeToken(L, payer);
  both('sacToAccount', invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(dest.address), i128(1000n)]));
  both('sacToContract', invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(store), i128(1000n)]));

  return rows;
}

const rows = build();
const pct = (got: number, ref: number) => ((got - ref) / ref) * 100;

// ===========================================================================
describe('preflight: the calibrated harness against the live node', () => {
  // ---------------------------------------------------------------------
  // GREEN. This is the part of the headline claim that holds, and it holds
  // harder than advertised.
  // ---------------------------------------------------------------------
  it('reproduces the node preflight EXACTLY, to the instruction', () => {
    const exact: (keyof typeof NODE_PREFLIGHT_PADDED)[] = [
      'uploadUnique', 'deploy', 'add', 'putPersistent',
      'getPersistent', 'largeWrite', 'crossContract',
    ];
    const report: string[] = [];
    for (const k of exact) {
      const nodeRaw = deadjust(NODE_PREFLIGHT_PADDED[k]);
      report.push(`  ${k.padEnd(16)} node=${String(nodeRaw).padStart(9)}  harness=${String(rows[k].sim).padStart(9)}  Δ=${rows[k].sim - nodeRaw}`);
    }
    console.log('\n' + report.join('\n'));
    for (const k of exact) {
      expect(rows[k].sim, `${k} is not exact`).toBe(deadjust(NODE_PREFLIGHT_PADDED[k]));
    }
  });

  it('reproduces the node preflight MEMORY too (vs the applied mem_byte)', () => {
    // The node exposes no memory number through rpc; core_metrics/mem_byte from
    // the applied transaction is the reference. Recording-mode memory and
    // enforcing-mode memory coincide on the node to <0.03%.
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'sum128', 'sum300'] as const) {
      const d = Math.abs(pct(rows[k].simMem, NODE_APPLY[k].mem));
      expect(d, `${k} memory off by ${d.toFixed(3)}%`).toBeLessThan(0.05);
    }
  });

  // ---------------------------------------------------------------------
  // RED #1 — anything that touches a classic AccountEntry.
  // ---------------------------------------------------------------------
  it('GAP: a native SAC transfer between two G-accounts under-meters by ~6.6%', () => {
    const nodeRaw = deadjust(NODE_PREFLIGHT_PADDED.sacToAccount); // 185_414
    const d = pct(rows.sacToAccount.sim, nodeRaw);
    console.log(`\n  sacToAccount  node=${nodeRaw}  harness=${rows.sacToAccount.sim}  ${d.toFixed(2)}%`);
    // The single most common thing a test does — "wallet sends XLM" — and it is
    // 6.6% low, not ~1%. Cause: fundAccount() writes AccountEntry ext=v0 (92
    // bytes) where stellar-core normalises to the v1->v2->v3 chain (144 bytes).
    expect(Math.abs(d), 'documented as ~1%; measured far worse').toBeLessThan(1);
  });

  it('GAP: and its disk_read_bytes / write_bytes are 36% short, which is the FEE', () => {
    // node: diskReadBytes 288, writeBytes 288 (two AccountEntries of 144).
    expect(rows.sacToAccount.readBytes, 'disk_read_bytes').toBe(288);
    expect(rows.sacToAccount.writeBytes, 'write_bytes').toBe(288);
  });

  it('GAP: transferring to a CONTRACT is only ~3% low — exactly one account short', () => {
    const nodeRaw = deadjust(NODE_PREFLIGHT_PADDED.sacToContract); // 212_515
    const d = pct(rows.sacToContract.sim, nodeRaw);
    console.log(`  sacToContract node=${nodeRaw}  harness=${rows.sacToContract.sim}  ${d.toFixed(2)}%`);
    // Half the error of the account->account case, because only one
    // AccountEntry is in the footprint instead of two. That is the proof that
    // the residue is the AccountEntry extension chain and nothing else.
    expect(Math.abs(d)).toBeLessThan(1);
  });
});

// ===========================================================================
describe('apply: send() is NOT calibrated, by a wide margin', () => {
  // The README quantifies this gap as "25-59%". Measured against the node's own
  // core_metrics/cpu_insn it is 55-121% for a contract invocation — because
  // crates/host-wasm/src/lib.rs:697 passes `module_cache: None` while
  // stellar-core always passes a prepopulated SorobanModuleCache
  // (soroban_proto_any.rs:597-620), so every apply pays the full
  // VmInstantiation const_term 417,482 instead of VmCachedInstantiation 41,142.
  it('GAP: applied CPU is 55-121% above the node on every contract invocation', () => {
    const report: string[] = [];
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'deploy', 'failing'] as const) {
      const d = pct(rows[k].sentCpu!, NODE_APPLY[k].cpu);
      report.push(`  ${k.padEnd(16)} node=${String(NODE_APPLY[k].cpu).padStart(9)}  harness=${String(rows[k].sentCpu).padStart(9)}  ${d > 0 ? '+' : ''}${d.toFixed(1)}%`);
    }
    console.log('\n' + report.join('\n'));
    for (const k of ['add', 'putPersistent', 'crossContract'] as const) {
      const d = Math.abs(pct(rows[k].sentCpu!, NODE_APPLY[k].cpu));
      expect(d, `${k} applied CPU off by ${d.toFixed(1)}% (README says 25-59%)`).toBeLessThan(59);
    }
  });

  it('GAP: applied MEMORY carries the same defect, 2.6-8.3% high', () => {
    for (const k of ['add', 'putPersistent', 'crossContract'] as const) {
      const d = Math.abs(pct(rows[k].sentMem!, NODE_APPLY[k].mem));
      expect(d, `${k} applied memory off by ${d.toFixed(2)}%`).toBeLessThan(1);
    }
  });

  it('an upload applies at the right cost — it instantiates no VM', () => {
    // Control: the module cache only matters when a contract is *invoked*.
    expect(Math.abs(pct(rows.uploadUnique.sentCpu!, NODE_APPLY.uploadUnique2.cpu))).toBeLessThan(0.05);
  });
});

// ===========================================================================
describe('the documented "residue" on upload does not exist', () => {
  it('a fresh upload of bytes the node has never stored matches exactly', () => {
    // test/cost-params.test.ts:109 asserts `delta > 0.5` — i.e. it REQUIRES the
    // harness to be at least 0.5% away from its reference. With the same bytes
    // uploaded for the first time on both sides the difference is zero, so that
    // test is pinning an artifact of the reference, not a property of the code.
    expect(rows.uploadUnique.sim).toBe(deadjust(NODE_PREFLIGHT_PADDED.uploadUnique));
  });

  it("GAP: the README/test reference numbers are not what the node returns", () => {
    // cost-params.test.ts NODE constants vs the node's actual leeway-0 output.
    const claimed = { add: 304_084, putPersistent: 550_088, getPersistent: 550_166 };
    for (const [k, v] of Object.entries(claimed)) {
      const measured = deadjust(NODE_PREFLIGHT_PADDED[k as keyof typeof NODE_PREFLIGHT_PADDED]);
      expect(v, `${k}: pinned reference ${v}, node returns ${measured}`).toBe(measured);
    }
  });
});
