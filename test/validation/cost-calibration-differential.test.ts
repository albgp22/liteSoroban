/**
 * DIFFERENTIAL AUDIT of the cost-calibration fix, against a live PROTOCOL-29
 * `stellar/quickstart` node at http://localhost:8000/rpc.
 *
 * PINNED NODE: stellar-rpc 29.0.1 (commit 055dc9c7), stellar-core v29.0.0
 * (which embeds soroban-env-host 29.0.0, git a721944), `getNetwork()` protocol
 * 29, standalone passphrase. Every "node" number below was re-captured on
 * 2026-10-18; the harness pins soroban-env-host 29.0.2. Two rounds on fresh
 * contract ids and fresh salts returned identical counts. The earlier
 * protocol-27 constants (stellar-rpc 27.1.1 / captive-core 27.1.0, host
 * 27.0.1) are gone: the host's metering moved in 28.0.0.
 *
 * APPLY PATH, CLOSED BY THE MODULE CACHE: the `apply` block below was written
 * when `send()` passed `module_cache: None`; its GAP tests asserted a 55-121%
 * overshoot. `send()` now passes a prepopulated cache, as stellar-core does
 * (README "Apply-path metering"); applied CPU sits within 0.14% of the node's
 * `core_metrics` and applied memory equals it, on the numbers pinned here.
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
 *      by scanning the leeway: for `add(2,3)` the node returns 325_616 at leeway
 *      0/1_000/50_000, 325_617 at 50_001, 375_616 at 100_000, 1_275_616 at
 *      1_000_000 and 20_275_616 at 20_000_000 — i.e. raw + max(50_000, leeway),
 *      pinning raw at exactly 275_616.
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
 * "within ~1%", it is EXACT — 0 instructions of difference on every scenario
 * whose footprint is pure Soroban (upload, deploy, add, put/get/large write,
 * cross-contract). What remains is anything holding a classic AccountEntry
 * (the native SAC transfers, 5.1% and 2.3% low) and the RPC facade ignoring
 * instructionLeeway (round 3).
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

/**
 * `simulateTransaction`, instructionLeeway 0 — i.e. already padded. Captured
 * 2026-10-18 on stellar-rpc 29.0.1 / stellar-core v29.0.0 (protocol 29).
 *
 * Two entries are BIMODAL on the byte order of the two ids in the footprint,
 * on the node as well as in the harness (a re-capture reproduces both):
 *
 *   crossContract  668_891 caller id > callee id   (668_741 when it sorts before)
 *   sacToAccount   209_028 payer key < dest key    (209_364 when it sorts after)
 *
 * The scenarios below build their wallets and contracts to match the pinned
 * mode instead of comparing across modes, which would manufacture a 0.2% "gap".
 * `sacToContract` is NOT bimodal: the destination contract sorting before or
 * after the native SAC id both give 242_286.
 *
 * (The old `sacMint`, `contractSacTransfer` and `checkAuthEnforcing` entries
 * were never asserted on, and their scenarios are not reproducible from this
 * file, so they were dropped rather than left as protocol-27 numbers; the
 * custom-account round trip is pinned in cost-calibration-round3.)
 */
const NODE_PREFLIGHT_PADDED = {
  uploadUnique: 1_604_631,
  deploy: 545_354,
  add: 325_616,
  putPersistent: 463_712,
  getPersistent: 464_915,
  largeWrite: 510_445,
  crossContract: 668_891,
  sacToAccount: 209_028,
  sacToContract: 242_286,
};

/**
 * `core_metrics` diagnostic events off the applied transaction (same node,
 * same date). `sacToAccount` is bimodal here too, and by far more in memory:
 * payer key < dest key 150_401 insns / 36_665 bytes, the other order 154_879 /
 * 39_465. The pinned mode is the first.
 */
const NODE_APPLY = {
  uploadUnique: { cpu: 1_541_138, mem: 1_439_796 },
  deploy: { cpu: 493_979, mem: 2_260_048 },
  add: { cpu: 276_240, mem: 1_130_954 },
  putPersistent: { cpu: 411_280, mem: 1_151_268 },
  getPersistent: { cpu: 412_868, mem: 1_151_485 },
  largeWrite: { cpu: 456_020, mem: 1_173_633 },
  crossContract: { cpu: 619_017, mem: 2_405_938 },
  failing: { cpu: 330_700, mem: 1_206_580 },
  sacToAccount: { cpu: 150_401, mem: 36_665 },
  sacToContract: { cpu: 184_326, mem: 48_531 },
  sum128: { cpu: 15_205_717, mem: 2_513_101 },
  sum300: { cpu: 50_409_457, mem: 5_789_933 },
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

  // The count is bimodal on the byte order of the two contract ids (see the
  // note on NODE_PREFLIGHT_PADDED). The ids depend on the random payer, so pick
  // the pair that reproduces the pinned mode: caller id > callee id.
  const c1 = deploy(INVOKE_CONTRACT, 43);
  const c2 = deploy(INVOKE_CONTRACT, 44);
  const [A, B] =
    Buffer.compare(Buffer.from(c1.contractId()), Buffer.from(c2.contractId())) < 0
      ? [c2, c1] : [c1, c2];
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

  // Also bimodal, on the byte order of the two account keys: pin payer < dest.
  const payerKey = Buffer.from(payer.keypair.rawPublicKey());
  let dest = preFundedWallet(L);
  while (Buffer.compare(payerKey, Buffer.from(dest.keypair.rawPublicKey())) >= 0) {
    dest = preFundedWallet(L);
  }
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
    // The node exposes no RECORDED memory through rpc (SorobanResources has no
    // memory field and simulateTransaction returns no `cost`); core_metrics/
    // mem_byte from the applied transaction is the only reference. On the
    // protocol-27 host recording-mode and enforcing-mode memory coincided to
    // <0.03%. On protocol 29 they do not: the harness's own recorded memory
    // sits 0.05-0.6% below its own APPLIED memory, and its applied memory
    // equals the node's (see the apply block below). The cause is not isolated;
    // the node's recorded memory cannot be observed, so the bound is 1%.
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'sum128', 'sum300'] as const) {
      const d = Math.abs(pct(rows[k].simMem, NODE_APPLY[k].mem));
      expect(d, `${k} memory off by ${d.toFixed(3)}%`).toBeLessThan(1);
    }
  });

  // ---------------------------------------------------------------------
  // RED #1 — anything that touches a classic AccountEntry.
  // ---------------------------------------------------------------------
  it('GAP: a native SAC transfer between two G-accounts under-meters by ~5.1%', () => {
    const nodeRaw = deadjust(NODE_PREFLIGHT_PADDED.sacToAccount); // 159_028
    const d = pct(rows.sacToAccount.sim, nodeRaw);
    console.log(`\n  sacToAccount  node=${nodeRaw}  harness=${rows.sacToAccount.sim}  ${d.toFixed(2)}%`);
    // The single most common thing a test does — "wallet sends XLM" — and it is
    // 5.1% low, not ~1%. Cause: fundAccount() writes AccountEntry ext=v0 (92
    // bytes) where stellar-core normalises to the v1->v2->v3 chain (144 bytes).
    expect(Math.abs(d), 'documented as ~1%; measured far worse').toBeLessThan(1);
  });

  it('GAP: and its disk_read_bytes / write_bytes are 36% short, which is the FEE', () => {
    // node: diskReadBytes 288, writeBytes 288 (two AccountEntries of 144).
    expect(rows.sacToAccount.readBytes, 'disk_read_bytes').toBe(288);
    expect(rows.sacToAccount.writeBytes, 'write_bytes').toBe(288);
  });

  it('GAP: transferring to a CONTRACT is only ~2.3% low — exactly one account short', () => {
    const nodeRaw = deadjust(NODE_PREFLIGHT_PADDED.sacToContract); // 192_286
    const d = pct(rows.sacToContract.sim, nodeRaw);
    console.log(`  sacToContract node=${nodeRaw}  harness=${rows.sacToContract.sim}  ${d.toFixed(2)}%`);
    // Half the error of the account->account case, because only one
    // AccountEntry is in the footprint instead of two. That is the proof that
    // the residue is the AccountEntry extension chain and nothing else.
    expect(Math.abs(d)).toBeLessThan(1);
  });
});

// ===========================================================================
describe('apply: send() matches the node now that it passes a module cache', () => {
  // History: the README quantified this gap as "25-59%"; measured against the
  // node's own core_metrics/cpu_insn it was 55-121% for a contract invocation,
  // because `send()` passed `module_cache: None` while stellar-core always
  // passes a prepopulated SorobanModuleCache, so every apply paid the full
  // VmInstantiation const_term 417,482 instead of VmCachedInstantiation 41,142.
  // Against the protocol-29 numbers pinned above the residue is <=0.14% (the
  // largest is largeWrite, +0.13%); 0.25% leaves headroom without letting the
  // cache regress unnoticed.
  it('applied CPU is within 0.25% of the node on every contract invocation', () => {
    const report: string[] = [];
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'deploy', 'failing'] as const) {
      const d = pct(rows[k].sentCpu!, NODE_APPLY[k].cpu);
      report.push(`  ${k.padEnd(16)} node=${String(NODE_APPLY[k].cpu).padStart(9)}  harness=${String(rows[k].sentCpu).padStart(9)}  ${d > 0 ? '+' : ''}${d.toFixed(3)}%`);
    }
    console.log('\n' + report.join('\n'));
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'deploy', 'failing'] as const) {
      const d = Math.abs(pct(rows[k].sentCpu!, NODE_APPLY[k].cpu));
      expect(d, `${k} applied CPU off by ${d.toFixed(3)}%`).toBeLessThan(0.25);
    }
  });

  it('applied MEMORY equals the node on every contract invocation', () => {
    for (const k of ['add', 'putPersistent', 'getPersistent', 'largeWrite', 'crossContract', 'deploy', 'failing'] as const) {
      const d = Math.abs(pct(rows[k].sentMem!, NODE_APPLY[k].mem));
      expect(d, `${k} applied memory off by ${d.toFixed(3)}%`).toBeLessThan(0.05);
    }
  });

  it('an upload applies at the right cost — it instantiates no VM', () => {
    // Control: the module cache only matters when a contract is *invoked*.
    expect(Math.abs(pct(rows.uploadUnique.sentCpu!, NODE_APPLY.uploadUnique.cpu))).toBeLessThan(0.05);
  });

  it('a big workload still applies at the right cost (sum over 128 and 300 values)', () => {
    for (const k of ['sum128', 'sum300'] as const) {
      expect(Math.abs(pct(rows[k].sentCpu!, NODE_APPLY[k].cpu)), `${k} applied CPU`).toBeLessThan(0.25);
      expect(Math.abs(pct(rows[k].sentMem!, NODE_APPLY[k].mem)), `${k} applied memory`).toBeLessThan(0.05);
    }
  });
});

// ===========================================================================
describe('the documented "residue" on upload does not exist', () => {
  it('a fresh upload of bytes the node has never stored matches exactly', () => {
    // test/cost-params.test.ts used to assert `delta > 0.5` — i.e. it REQUIRED
    // the harness to be at least 0.5% away from its reference. With the same
    // bytes uploaded for the first time on both sides the difference is zero,
    // so that test was pinning an artifact of the reference, not a property of
    // the code.
    expect(rows.uploadUnique.sim).toBe(deadjust(NODE_PREFLIGHT_PADDED.uploadUnique));
  });

  it('and test/cost-params.test.ts no longer pins node numbers or requires a residue', () => {
    // It used to pin {add 304_084, putPersistent 550_088, getPersistent
    // 550_166} (0.11-0.32% above the leeway-0 truth) and `delta > 0.5` on an
    // upload against 1_547_805, a node that already held those bytes.
    const acceptance = readFileSync(
      fileURLToPath(new URL('../cost-params.test.ts', import.meta.url)), 'utf8');
    for (const stale of ['304_084', '550_088', '550_166', '1_547_805', '1547805']) {
      expect(acceptance, `still pins ${stale}`).not.toContain(stale);
    }
    expect(acceptance).not.toMatch(/delta\s*>\s*0\.5/);
  });
});
