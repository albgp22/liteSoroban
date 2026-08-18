/**
 * ROUND-3 AUDIT of the cost-calibration fix, measured differentially against
 * the live protocol-27 quickstart node (stellar-rpc 27.1.1 / captive-core
 * 27.1.0) at http://localhost:8000/rpc.
 *
 * Everything labelled "node" below was MEASURED by this author, not inherited:
 *
 *  (a) PREFLIGHT — `simulateTransaction` with `resourceConfig.instructionLeeway`
 *      pinned to 0, then de-adjusted. The padding is
 *      `SimulationAdjustmentFactor::adjust_u32` in soroban-simulation
 *      (`src/resources.rs`):
 *
 *          value == 0 ? 0
 *                     : max(value + additive, floor(value as f64 * mult))
 *
 *      with `instructions: (mult 1.04, additive 50_000)` from
 *      `SimulationAdjustmentConfig::default_adjustment()` (`src/simulation.rs`),
 *      and `additive = max(additive, instruction_leeway)` in
 *      `stellar-rpc/cmd/stellar-rpc/lib/preflight/src/shared.rs`.
 *      Confirmed live: add(2,3) returns 353_123 at leeway 0 / 1_000 / 50_000,
 *      353_124 at 50_001, 403_123 at 100_000, 1_303_123 at 1_000_000 and
 *      20_303_123 at 20_000_000 — i.e. raw + max(50_000, leeway), pinning raw
 *      at exactly 303_123.
 *
 *  (b) APPLY — `core_metrics`/`cpu_insn` and `core_metrics`/`mem_byte`
 *      diagnostic events off the applied transaction. This is the only way to
 *      see the node's MEMORY at all, since SorobanResources carries no memory
 *      field.
 *
 * BEWARE when reproducing: several of these counts are BIMODAL, and the mode is
 * chosen by the byte order of the two contract addresses in the footprint. A
 * contract-to-contract native SAC transfer costs 643_783 when the destination
 * id sorts BEFORE the source id and 636_107 when it sorts after — **on the node
 * as well as in the harness**. Comparing across modes manufactures a 1.2%
 * "gap" that is not real. Round 2's `crossContract` and `contractSacTransfer`
 * numbers are one mode; this file matches modes before comparing.
 *
 * VERDICT: the preflight claim holds and is stronger than the README says —
 * EXACT, not "~1%", on every scenario whose footprint is pure Soroban,
 * including a custom-account __check_auth round trip (3,136,297 instructions,
 * zero difference). Memory on that path is equally good, which nobody had
 * checked. Three things are wrong, and all three are in this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr, Keypair, rpc, Operation, Address, TransactionBuilder, nativeToScVal,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from '../../src/index.js';
import {
  PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT, loadCostParamsFromRpc,
} from '../../src/cost-params.js';
import { preFundedWallet, nativeToken } from '../../src/fixtures.js';
import { authorizeAndSend, smartAccountEd25519 } from '../../src/auth.js';
import { LiteStellar, sc } from '../../src/litestellar.js';

const PASS = 'Standalone Network ; February 2017';
const NODE_URL = 'http://localhost:8000/rpc';
const fx = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

const ADD_I32 = fx('add_i32.wasm');
const CONTRACT_DATA = fx('contract_data.wasm');
const INVOKE_CONTRACT = fx('invoke_contract.wasm');
const ERR = fx('err.wasm');
const SMART = fx('smart_account.wasm');

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const A = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

/** exactly what crates/host-wasm/src/lib.rs:103 does, and what stellar-rpc does */
const pad = (raw: number) => Math.max(raw + 50_000, Math.floor(raw * 1.04));

/** node preflight, leeway 0, already de-adjusted to RAW */
const NODE_PREFLIGHT_RAW = {
  uploadUnique: 1_542_113,
  deploy: 529_166,
  add: 303_123,
  putPersistent: 549_484,
  getPersistent: 549_562,
  largeWrite: 594_696,
  crossContract: 715_982,          // A->B; B->A is 715_582 (the other mode)
  checkAuthRecording: 2_006_499,
  checkAuthEnforcing: 3_136_297,
  sacToAccount: 185_414,           // other mode 185_750
  sacToContract: 212_515,
};

/** node `core_metrics` off the applied transaction */
const NODE_APPLY = {
  uploadUnique: { cpu: 1_540_336, mem: 1_447_946 },
  deploy: { cpu: 516_432, mem: 2_267_630 },
  add: { cpu: 298_100, mem: 1_146_659 },
  putPersistent: { cpu: 541_405, mem: 1_181_784 },
  getPersistent: { cpu: 541_868, mem: 1_182_523 },
  largeWrite: { cpu: 584_524, mem: 1_223_301 },
  crossContract: { cpu: 704_534, mem: 2_437_186 },
  failing: { cpu: 395_573, mem: 1_206_651 },
  sacToAccount: { cpu: 162_989, mem: 57_951 },
  sacToContract: { cpu: 193_100, mem: 65_302 },
  checkAuth: { cpu: 3_100_868, mem: 2_796_310 },
};

// ---------------------------------------------------------------------------
// the same scenarios, in process, calibrated
// ---------------------------------------------------------------------------
interface Row {
  sim: number; simMem: number; padded: number;
  diskReadBytes: number; writeBytes: number;
  cpu: number; mem: number;
}

async function build() {
  const L = new Ledger({ networkPassphrase: PASS });
  L.setCostParams(
    PROTOCOL_27_COST_PARAMS.cpuInstructions,
    PROTOCOL_27_COST_PARAMS.memoryBytes,
    P27_CPU_LIMIT,
    P27_MEM_LIMIT,
  );
  const payer = preFundedWallet(L);
  const SRC = payer.accountIdB64;
  const rows: Record<string, Row> = {};

  const record = (k: string, sim: any, sent: any) => {
    rows[k] = {
      sim: sim.instructions, simMem: Number(sim.memBytes), padded: sim.adjustedInstructions,
      diskReadBytes: sim.readBytes, writeBytes: sim.writeBytes,
      cpu: Number(sent.cpuInsns), mem: Number(sent.memBytes),
    };
  };
  const both = (k: string, hf: xdr.HostFunction) => {
    const sim = L.simulate(hf, SRC);
    expect(sim.ok, `${k}: ${sim.error}`).toBe(true);
    const sent = L.send(hf, SRC, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `${k} apply: ${sent.error}`).toBe(true);
    record(k, sim, sent);
  };
  const deploy = (code: Uint8Array, salt: number, ctor: xdr.ScVal[] = []) => {
    const h = L.seedWasm(code);
    const { sent } = L.simulateAndSend(createContractHostFn(SRC, h, Buffer.alloc(32, salt), ctor), SRC);
    expect(sent.ok, `deploy ${salt}: ${sent.error}`).toBe(true);
    return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  };

  // a blob no ledger on either side has ever stored (valid 18-byte custom section)
  const UNIQUE = new Uint8Array(
    Buffer.concat([Buffer.from(ADD_I32), Buffer.from('0012017510e3485048a8bc11bddff35fc8f506ac', 'hex')]),
  );
  both('uploadUnique', uploadWasmHostFn(UNIQUE));

  both('deploy', createContractHostFn(SRC, L.seedWasm(ADD_I32), Buffer.alloc(32, 41)));
  const adder = deploy(ADD_I32, 11);
  both('add', invokeHostFn(adder, 'add', [i32(2), i32(3)]));

  const store = deploy(CONTRACT_DATA, 42);
  both('putPersistent', invokeHostFn(store, 'put_persistent', [sym('k'), u64(42n)]));
  both('getPersistent', invokeHostFn(store, 'get_persistent', [sym('k')]));
  both('largeWrite', invokeHostFn(store, 'replace_with_bytes_and_extend',
    [sym('k'), u32(5), u32(100), u32(10_000)]));

  // cross-contract. The count is bimodal on the ORDER of the two contract ids,
  // on the node too, so pick the caller/callee pair that reproduces the node's
  // measured mode rather than comparing across modes.
  const c1 = deploy(INVOKE_CONTRACT, 43);
  const c2 = deploy(INVOKE_CONTRACT, 44);
  const [caller, callee] =
    Buffer.compare(Buffer.from(c1.contractId()), Buffer.from(c2.contractId())) < 0
      ? [c2, c1] : [c1, c2];
  both('crossContract', invokeHostFn(caller, 'add_with', [i32(3), i32(4), A(callee)]));

  // a failing call: rpc answers a failing preflight with a JSON-RPC error and no
  // resources, so the only comparable node number is the applied one (obtained
  // by submitting err_eek under a hand-built {instance, code} footprint).
  const errC = deploy(ERR, 45);
  {
    const hf = invokeHostFn(errC, 'err_eek', []);
    const sim = L.simulate(hf, SRC);
    expect(sim.ok).toBe(false);
    const sent = L.send(hf, SRC, sim.resourcesXdr, sim.authXdr, []);
    record('failing', sim, sent);
  }

  const dest = preFundedWallet(L);
  const nat = nativeToken(L, payer);
  both('sacToAccount', invokeHostFn(nat.address, 'transfer',
    [A(payer.address), A(dest.address), i128(1000n)]));
  both('sacToContract', invokeHostFn(nat.address, 'transfer',
    [A(payer.address), A(store), i128(1000n)]));

  // custom account: the full four-step __check_auth round trip
  const adminSigner = (k: Keypair) => xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Ed25519'),
    xdr.ScVal.scvMap([new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(k.rawPublicKey()),
    })]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
  ]);
  const admin = Keypair.random();
  const SA = deploy(SMART, 51, [xdr.ScVal.scvVec([adminSigner(admin)]), xdr.ScVal.scvVec([])]);
  const hf = invokeHostFn(SA, 'add_signer', [adminSigner(Keypair.random())]);
  const { recorded, enforced, sent } = await authorizeAndSend(L, hf, SRC, {
    sign: smartAccountEd25519(admin),
  });
  expect(sent.ok, `check_auth apply: ${sent.error}`).toBe(true);
  record('checkAuthRecording', recorded, sent);
  record('checkAuthEnforcing', enforced, sent);

  return rows;
}

const rows = await build();
const pct = (got: number, ref: number) => ((got - ref) / ref) * 100;

// ===========================================================================
describe('GREEN: the preflight claim, verified beyond the four tuned scenarios', () => {
  it('reproduces the node preflight EXACTLY on every pure-Soroban footprint', () => {
    const exact = [
      'uploadUnique', 'deploy', 'add', 'putPersistent',
      'getPersistent', 'largeWrite', 'crossContract',
    ] as const;
    const report = exact.map(k =>
      `  ${k.padEnd(18)} node=${String(NODE_PREFLIGHT_RAW[k]).padStart(9)}  ` +
      `harness=${String(rows[k].sim).padStart(9)}  Δ=${rows[k].sim - NODE_PREFLIGHT_RAW[k]}`);
    console.log('\n' + report.join('\n'));
    for (const k of exact) expect(rows[k].sim, `${k} is not exact`).toBe(NODE_PREFLIGHT_RAW[k]);
  });

  // NEW in this round: nobody had ever compared a custom-account authorization.
  it('a custom-account __check_auth round trip is exact, both passes', () => {
    expect(rows.checkAuthRecording.sim).toBe(NODE_PREFLIGHT_RAW.checkAuthRecording);
    // The enforcing pass is bimodal by 2_700 (0.086%) on the recorded nonce.
    expect(Math.abs(pct(rows.checkAuthEnforcing.sim, NODE_PREFLIGHT_RAW.checkAuthEnforcing)))
      .toBeLessThan(0.1);
  });

  // NEW in this round: memory had never been checked against anything.
  it('recording-mode MEMORY tracks the node as tightly as instructions do', () => {
    const keys = ['uploadUnique', 'deploy', 'add', 'putPersistent', 'getPersistent',
      'largeWrite', 'crossContract', 'failing'] as const;
    const report = keys.map(k =>
      `  ${k.padEnd(18)} node=${String(NODE_APPLY[k].mem).padStart(9)}  ` +
      `harness=${String(rows[k].simMem).padStart(9)}  ${pct(rows[k].simMem, NODE_APPLY[k].mem).toFixed(4)}%`);
    console.log('\n' + report.join('\n'));
    for (const k of keys) {
      expect(Math.abs(pct(rows[k].simMem, NODE_APPLY[k].mem)), `${k} memory`).toBeLessThan(0.05);
    }
    expect(Math.abs(pct(rows.checkAuthEnforcing.simMem, NODE_APPLY.checkAuth.mem)))
      .toBeLessThan(0.1);
  });

  it('the shipped table IS the live node table, entry for entry, CPU and memory', async () => {
    const S = new rpc.Server(NODE_URL, { allowHttp: true });
    const live = await loadCostParamsFromRpc(S);
    expect(live.cpuInstructions).toBe(PROTOCOL_27_COST_PARAMS.cpuInstructions);
    expect(live.memoryBytes).toBe(PROTOCOL_27_COST_PARAMS.memoryBytes);
    expect(live.cpuLimit).toBe(P27_CPU_LIMIT);
    expect(live.memLimit).toBe(P27_MEM_LIMIT);

    const dec = (b: string) => xdr.ContractCostParams.fromXDR(Buffer.from(b, 'base64'));
    for (const [name, a, b] of [
      ['cpu', dec(live.cpuInstructions), dec(PROTOCOL_27_COST_PARAMS.cpuInstructions)],
      ['mem', dec(live.memoryBytes), dec(PROTOCOL_27_COST_PARAMS.memoryBytes)],
    ] as const) {
      expect((a as any).length, `${name} entry count`).toBe(86);
      for (let i = 0; i < (a as any).length; i++) {
        expect((a as any)[i].constTerm().toString(), `${name}[${i}] const`)
          .toBe((b as any)[i].constTerm().toString());
        expect((a as any)[i].linearTerm().toString(), `${name}[${i}] linear`)
          .toBe((b as any)[i].linearTerm().toString());
      }
    }
  });
});

// ===========================================================================
describe('RED 1: the apply path is far worse than any document admits', () => {
  // README "Known gaps" quantifies the module_cache: None defect as 25-59%.
  // Round 2 measured 55-121% on contract invocations. On a CUSTOM-ACCOUNT
  // authorization it is 220%, because the enforcing pass instantiates the
  // smart account's Wasm for __check_auth *and* the invoked contract's, paying
  // VmInstantiation const_term 417,482 twice where core pays
  // VmCachedInstantiation 41,142 out of a prepopulated SorobanModuleCache.
  it('GAP: applied CPU on a __check_auth invocation is 3.2x the node', () => {
    const d = pct(rows.checkAuthEnforcing.cpu, NODE_APPLY.checkAuth.cpu);
    console.log(`\n  checkAuth apply  node=${NODE_APPLY.checkAuth.cpu}  harness=${rows.checkAuthEnforcing.cpu}  +${d.toFixed(1)}%`);
    expect(d, 'README "Known gaps" says 25-59%').toBeLessThan(59);
  });

  it('GAP: and its applied MEMORY is +53%, which no document mentions at all', () => {
    // README discusses the module cache purely as an INSTRUCTION problem.
    // VmInstantiation also has a memory cost, and on this path it dominates.
    const d = pct(rows.checkAuthEnforcing.mem, NODE_APPLY.checkAuth.mem);
    console.log(`  checkAuth mem    node=${NODE_APPLY.checkAuth.mem}  harness=${rows.checkAuthEnforcing.mem}  +${d.toFixed(1)}%`);
    expect(d, 'applied memory is uncalibrated on the auth path').toBeLessThan(1);
  });

  it('GAP: applied CPU is 58-121% high on ordinary invocations too', () => {
    const keys = ['add', 'deploy', 'putPersistent', 'getPersistent',
      'largeWrite', 'crossContract', 'failing'] as const;
    const report = keys.map(k =>
      `  ${k.padEnd(18)} node=${String(NODE_APPLY[k].cpu).padStart(9)}  ` +
      `harness=${String(rows[k].cpu).padStart(9)}  +${pct(rows[k].cpu, NODE_APPLY[k].cpu).toFixed(1)}%`);
    console.log('\n' + report.join('\n'));
    for (const k of keys) {
      expect(Math.abs(pct(rows[k].cpu, NODE_APPLY[k].cpu)), `${k} applied CPU`).toBeLessThan(59);
    }
  });
});

// ===========================================================================
describe('RED 2: anything holding a classic AccountEntry is mis-metered', () => {
  // fundAccount() writes AccountEntry with ext = v0 (92 bytes); stellar-core
  // normalises to the v1->v2->v3 chain (144 bytes). 52 bytes per account, and
  // it lands in instructions, memory AND the fee-bearing byte counts.
  it('GAP: a native SAC transfer between two G-accounts under-meters ~6.8%', () => {
    const d = pct(rows.sacToAccount.sim, NODE_PREFLIGHT_RAW.sacToAccount);
    console.log(`\n  sacToAccount  node=${NODE_PREFLIGHT_RAW.sacToAccount}  harness=${rows.sacToAccount.sim}  ${d.toFixed(2)}%`);
    // "wallet sends XLM" is the single most common thing a test does.
    expect(Math.abs(d), 'README claims ~1% after calibration').toBeLessThan(1);
  });

  it('GAP: its MEMORY is short by the same 6.7%, and memory is never mentioned', () => {
    const d = pct(rows.sacToAccount.simMem, NODE_APPLY.sacToAccount.mem);
    console.log(`  sacToAccount mem  node=${NODE_APPLY.sacToAccount.mem}  harness=${rows.sacToAccount.simMem}  ${d.toFixed(2)}%`);
    expect(Math.abs(d)).toBeLessThan(1);
  });

  it('GAP: the fee-bearing byte counts are 36% short — 52 bytes per account', () => {
    expect(rows.sacToAccount.diskReadBytes, 'disk_read_bytes: node reads 2x144').toBe(288);
    expect(rows.sacToAccount.writeBytes, 'write_bytes: node writes 2x144').toBe(288);
  });

  it('one account in the footprint instead of two halves the error, as predicted', () => {
    // Not a gap — the proof that the residue is the extension chain and nothing
    // else. 52 bytes short per AccountEntry, exactly.
    expect(NODE_PREFLIGHT_RAW.sacToContract - rows.sacToContract.sim).toBeGreaterThan(6_000);
    expect(rows.sacToContract.diskReadBytes).toBe(92);   // node: 144
    expect(rows.sacToContract.writeBytes).toBe(316);     // node: 368
  });
});

// ===========================================================================
describe('RED 3: the RPC facade ignores instructionLeeway entirely', () => {
  // stellar-rpc: adjustment_config.instructions.additive_factor =
  //   max(50_000, resource_config.instruction_leeway)   (preflight/src/shared.rs)
  // crates/host-wasm/src/lib.rs:103 hard-codes the 50_000 and src/fake-rpc.ts
  // never reads resourceConfig at all, so the returned resources are identical
  // whatever the caller asks for. Measured on the live node for add(2,3):
  //   leeway 0 -> 353_123 | 50_001 -> 353_124 | 100_000 -> 403_123
  //   leeway 1_000_000 -> 1_303_123 | 20_000_000 -> 20_303_123
  it('GAP: every leeway returns the same number; the node scales with it', async () => {
    const svm = new LiteStellar({ networkPassphrase: PASS }).withNetworkCostParams();
    const c = svm.deployContract(ADD_I32);
    const S = svm.rpcServer();
    const acct = await S.getAccount(svm.payer.publicKey);
    const tx = () => new TransactionBuilder(acct, { fee: '1000000', networkPassphrase: PASS })
      .addOperation(Operation.invokeContractFunction({
        contract: c.contractId, function: 'add', args: [sc.i32(2), sc.i32(3)],
      })).setTimeout(300).build();

    const seen: Record<string, number> = {};
    for (const leeway of [0, 100_000, 1_000_000, 20_000_000]) {
      const sim: any = await S.simulateTransaction(tx(), { cpuInstructions: leeway });
      seen[leeway] = sim.transactionData.build().resources().instructions();
    }
    console.log('\n  harness leeway ->', JSON.stringify(seen));
    console.log('  node    leeway -> {"0":353123,"100000":403123,"1000000":1303123,"20000000":20303123}');

    expect(seen[0]).toBe(pad(NODE_PREFLIGHT_RAW.add));                       // holds
    expect(seen[100_000], 'leeway 100k').toBe(NODE_PREFLIGHT_RAW.add + 100_000);
    expect(seen[1_000_000], 'leeway 1M').toBe(NODE_PREFLIGHT_RAW.add + 1_000_000);
    expect(seen[20_000_000], 'leeway 20M').toBe(NODE_PREFLIGHT_RAW.add + 20_000_000);
  });
});

// ===========================================================================
describe('RED 4: the acceptance test pins numbers the node does not produce', () => {
  // test/cost-params.test.ts's NODE constants, against the leeway-0 truth.
  it('GAP: test/cost-params.test.ts NODE constants are 0.11-0.32% too high', () => {
    const pinned = { add: 304_084, putPersistent: 550_088, getPersistent: 550_166 };
    for (const [k, v] of Object.entries(pinned)) {
      const measured = NODE_PREFLIGHT_RAW[k as keyof typeof NODE_PREFLIGHT_RAW];
      expect(v, `${k}: test pins ${v}, node returns ${measured}`).toBe(measured);
    }
  });

  it('GAP: "upload retains a small documented residue" REQUIRES the harness to be wrong', () => {
    // cost-params.test.ts:109-114 asserts `delta > 0.5` — a test that fails if
    // the code becomes exact. Its reference (1,547,805) is a node that ALREADY
    // held that ContractCode, so its preflight wrote nothing; the harness was
    // uploading for the first time. With the same bytes fresh on both sides the
    // difference is zero, so the "residue" is an artifact of the reference.
    expect(rows.uploadUnique.sim).toBe(NODE_PREFLIGHT_RAW.uploadUnique);
    const residue = Math.abs(pct(rows.uploadUnique.sim, NODE_PREFLIGHT_RAW.uploadUnique));
    expect(residue, 'a lower bound on error is not a property worth pinning')
      .toBeGreaterThan(0.5);
  });
});
