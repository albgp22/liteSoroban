/**
 * ROUND-3 AUDIT of the cost-calibration fix, measured differentially against a
 * live PROTOCOL-29 `stellar/quickstart` node at http://localhost:8000/rpc.
 *
 * PINNED NODE: stellar-rpc 29.0.1 (commit 055dc9c7), stellar-core v29.0.0
 * (which embeds soroban-env-host 29.0.0, git a721944), `getNetwork()` protocol
 * 29, standalone passphrase. Every "node" number below was re-captured on
 * 2026-10-18; the harness pins soroban-env-host 29.0.2. Two rounds on fresh
 * contract ids and salts returned identical counts. The earlier protocol-27
 * constants (stellar-rpc 27.1.1 / captive-core 27.1.0, host 27.0.1) are gone:
 * the host's metering moved in 28.0.0.
 *
 * RED 1 (APPLY PATH) IS CLOSED: `send()` now passes a module cache, as
 * stellar-core does, so the 58-121% / +220% / +53% gaps its tests name are gone
 * (applied CPU within 0.14% and applied memory equal to `core_metrics`;
 * README "Apply-path metering"); its tests now assert that closed state against
 * these protocol-29 numbers.
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
 *      Confirmed live: add(2,3) returns 325_616 at leeway 0 / 1_000 / 50_000,
 *      325_617 at 50_001, 375_616 at 100_000, 1_275_616 at 1_000_000 and
 *      20_275_616 at 20_000_000 — i.e. raw + max(50_000, leeway), pinning raw
 *      at exactly 275_616.
 *
 *  (b) APPLY — `core_metrics`/`cpu_insn` and `core_metrics`/`mem_byte`
 *      diagnostic events off the applied transaction. This is the only way to
 *      see the node's MEMORY at all, since SorobanResources carries no memory
 *      field.
 *
 * BEWARE when reproducing: several of these counts are BIMODAL, and the mode is
 * chosen by the byte order of the two ids in the footprint — **on the node as
 * well as in the harness**. Measured on this node (raw, instructions):
 *
 *   crossContract  618_891 caller id > callee id | 618_741 caller id < callee id
 *   sacToAccount   159_028 payer key < dest key  | 159_364 payer key > dest key
 *
 * and the applied sacToAccount memory moves 7.6% with it (36_665 vs 39_465
 * bytes). Comparing across modes manufactures a "gap" that is not real, so this
 * file matches modes before comparing. `sacToContract` is not bimodal: a
 * destination contract id sorting before or after the native SAC id both give
 * 192_286.
 *
 * VERDICT: the preflight claim holds and is stronger than the README says —
 * EXACT, not "~1%", on every scenario whose footprint is pure Soroban,
 * including a custom-account __check_auth round trip (912,700 recording,
 * 2,037,481 or 2,040,027 enforcing depending on the nonce; zero difference).
 * Applied memory equals the node's. What is still wrong is in this file:
 * anything holding a classic AccountEntry (RED 2) and the RPC facade ignoring
 * instructionLeeway (RED 3). RED 1 and RED 4 are closed.
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

/** node preflight, leeway 0, already de-adjusted to RAW (protocol-29 node, 2026-10-18) */
const NODE_PREFLIGHT_RAW = {
  uploadUnique: 1_542_915,
  deploy: 495_354,
  add: 275_616,
  putPersistent: 413_712,
  getPersistent: 414_915,
  largeWrite: 460_445,
  crossContract: 618_891,          // caller id > callee id; the other mode is 618_741
  checkAuthRecording: 912_700,
  // BIMODAL on the recorded nonce (key order in the footprint): 24 fresh recordings
  // on the node gave 2_037_481 x10 and 2_040_027 x14; the recording pass is 912_700 x24.
  checkAuthEnforcing: [2_037_481, 2_040_027],
  sacToAccount: 159_028,           // payer key < dest key; the other mode is 159_364
  sacToContract: 192_286,
};

/** node `core_metrics` off the applied transaction (same node, same date) */
const NODE_APPLY = {
  uploadUnique: { cpu: 1_541_138, mem: 1_439_796 },
  deploy: { cpu: 493_979, mem: 2_260_048 },
  add: { cpu: 276_240, mem: 1_130_954 },
  putPersistent: { cpu: 411_280, mem: 1_151_268 },
  getPersistent: { cpu: 412_868, mem: 1_151_485 },
  largeWrite: { cpu: 456_020, mem: 1_173_633 },
  crossContract: { cpu: 619_017, mem: 2_405_938 },
  failing: { cpu: 330_700, mem: 1_206_580 },
  sacToAccount: { cpu: 150_401, mem: 36_665 },   // payer key < dest key; the other mode 154_879 / 39_465
  sacToContract: { cpu: 184_326, mem: 48_531 },
  checkAuth: { cpu: 2_016_866, mem: 2_553_360 },
};

/**
 * The node's ledger limits. NOT the shipped P27_* constants (mainnet's
 * protocol-27 limits): the quickstart standalone network allows 4x the
 * instructions per transaction (ConfigSettingContractComputeV0
 * tx_max_instructions); the memory ceiling is the same.
 */
const NODE_CPU_LIMIT = 400_000_000n;
const NODE_MEM_LIMIT = 41_943_040n;

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

  // bimodal on the byte order of the two account keys: pin payer < dest
  const payerKey = Buffer.from(payer.keypair.rawPublicKey());
  let dest = preFundedWallet(L);
  while (Buffer.compare(payerKey, Buffer.from(dest.keypair.rawPublicKey())) >= 0) {
    dest = preFundedWallet(L);
  }
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
    // The enforcing pass is bimodal by 2_546 (0.125%) on the recorded nonce, on
    // the node and in the harness alike: it must land on one of the node's modes.
    expect(NODE_PREFLIGHT_RAW.checkAuthEnforcing).toContain(rows.checkAuthEnforcing.sim);
  });

  // NEW in this round: memory had never been checked against anything.
  //
  // The node exposes no RECORDED memory (SorobanResources has no memory field
  // and simulateTransaction returns no `cost`), so the only reference is the
  // applied `mem_byte`. On the protocol-27 host the two coincided to <0.03%. On
  // protocol 29 they do not: the harness's own recorded memory sits 0.05-0.6%
  // below its own applied memory (1.7% on the two-module auth path). The cause
  // is not isolated. So the verifiable claims are two: applied memory equals
  // the node's, and recorded memory is within 1% of it (2% on the auth path).
  it('MEMORY: applied equals the node, recording-mode is within 1% of it', () => {
    const keys = ['uploadUnique', 'deploy', 'add', 'putPersistent', 'getPersistent',
      'largeWrite', 'crossContract', 'failing'] as const;
    const report = keys.map(k =>
      `  ${k.padEnd(18)} node=${String(NODE_APPLY[k].mem).padStart(9)}  ` +
      `applied=${String(rows[k].mem).padStart(9)} (${pct(rows[k].mem, NODE_APPLY[k].mem).toFixed(4)}%)  ` +
      `recorded=${String(rows[k].simMem).padStart(9)} (${pct(rows[k].simMem, NODE_APPLY[k].mem).toFixed(4)}%)`);
    console.log('\n' + report.join('\n'));
    for (const k of keys) {
      expect(Math.abs(pct(rows[k].mem, NODE_APPLY[k].mem)), `${k} applied memory`).toBeLessThan(0.05);
      expect(Math.abs(pct(rows[k].simMem, NODE_APPLY[k].mem)), `${k} recorded memory`).toBeLessThan(1);
    }
    expect(Math.abs(pct(rows.checkAuthEnforcing.mem, NODE_APPLY.checkAuth.mem)), 'checkAuth applied memory')
      .toBeLessThan(0.05);
    // the auth path is the widest (1.7%): it runs two modules
    expect(Math.abs(pct(rows.checkAuthEnforcing.simMem, NODE_APPLY.checkAuth.mem)), 'checkAuth recorded memory')
      .toBeLessThan(2);
  });

  it('the shipped table IS the live node table, entry for entry, CPU and memory', async () => {
    const S = new rpc.Server(NODE_URL, { allowHttp: true });
    const live = await loadCostParamsFromRpc(S);
    expect(live.cpuInstructions).toBe(PROTOCOL_27_COST_PARAMS.cpuInstructions);
    expect(live.memoryBytes).toBe(PROTOCOL_27_COST_PARAMS.memoryBytes);
    expect(live.cpuLimit).toBe(NODE_CPU_LIMIT);
    expect(live.memLimit).toBe(NODE_MEM_LIMIT);

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
describe('CLOSED 1: the apply path matches core_metrics now that send() passes a module cache', () => {
  // History: with `module_cache: None` every apply paid VmInstantiation
  // (const_term 417,482) where stellar-core pays VmCachedInstantiation (41,142)
  // out of a prepopulated SorobanModuleCache. README "Known gaps" put that at
  // 25-59%, round 2 measured 55-121% on contract invocations, and a CUSTOM-
  // ACCOUNT authorization was +220% CPU / +53% memory because the enforcing
  // pass instantiates both the smart account's Wasm and the invoked contract's.
  // These assert the closed state against the protocol-29 `core_metrics`: the
  // measured CPU residue is <=0.14% (the largest is largeWrite, +0.13%) and
  // applied memory is exact, so 0.25% leaves headroom without letting the
  // cache regress unnoticed.
  it('applied CPU on a __check_auth invocation is within 0.25% of the node', () => {
    const d = pct(rows.checkAuthEnforcing.cpu, NODE_APPLY.checkAuth.cpu);
    console.log(`\n  checkAuth apply  node=${NODE_APPLY.checkAuth.cpu}  harness=${rows.checkAuthEnforcing.cpu}  ${d.toFixed(3)}%`);
    expect(Math.abs(d), 'applied CPU on the auth path').toBeLessThan(0.25);
  });

  it('applied MEMORY on that path equals the node', () => {
    const d = pct(rows.checkAuthEnforcing.mem, NODE_APPLY.checkAuth.mem);
    console.log(`  checkAuth mem    node=${NODE_APPLY.checkAuth.mem}  harness=${rows.checkAuthEnforcing.mem}  ${d.toFixed(3)}%`);
    expect(Math.abs(d), 'applied memory on the auth path').toBeLessThan(0.05);
  });

  it('applied CPU on ordinary invocations is within 0.25% of the node', () => {
    const keys = ['add', 'deploy', 'putPersistent', 'getPersistent',
      'largeWrite', 'crossContract', 'failing'] as const;
    const report = keys.map(k =>
      `  ${k.padEnd(18)} node=${String(NODE_APPLY[k].cpu).padStart(9)}  ` +
      `harness=${String(rows[k].cpu).padStart(9)}  ${pct(rows[k].cpu, NODE_APPLY[k].cpu).toFixed(3)}%`);
    console.log('\n' + report.join('\n'));
    for (const k of keys) {
      expect(Math.abs(pct(rows[k].cpu, NODE_APPLY[k].cpu)), `${k} applied CPU`).toBeLessThan(0.25);
    }
  });
});

// ===========================================================================
describe('RED 2: anything holding a classic AccountEntry is mis-metered', () => {
  // fundAccount() writes AccountEntry with ext = v0 (92 bytes); stellar-core
  // normalises to the v1->v2->v3 chain (144 bytes). 52 bytes per account, and
  // it lands in instructions, memory AND the fee-bearing byte counts.
  it('GAP: a native SAC transfer between two G-accounts under-meters ~5.1%', () => {
    const d = pct(rows.sacToAccount.sim, NODE_PREFLIGHT_RAW.sacToAccount);
    console.log(`\n  sacToAccount  node=${NODE_PREFLIGHT_RAW.sacToAccount}  harness=${rows.sacToAccount.sim}  ${d.toFixed(2)}%`);
    // "wallet sends XLM" is the single most common thing a test does.
    expect(Math.abs(d), 'README claims ~1% after calibration').toBeLessThan(1);
  });

  it('GAP: its applied MEMORY through Ledger.send is ~7% under the node', () => {
    // An earlier version compared RECORDED memory with the node's APPLIED
    // memory (simulateTransaction returns no cost). That stopped being a valid
    // proxy here: preflight hands the host both accounts promoted to ext v3
    // (soroban-simulation's SimulationSnapshotSource) while apply sees the
    // fresh destination at v0, so the two differ on the node too.
    //
    // Applied against applied, 2026-10-18: harness 34_085 vs node 36_665 bytes
    // (-7.0%), CPU 147_409 vs 150_401 (-2.0%). This scenario drives Ledger.send
    // directly, which does not bump the payer's sequence, and on a network that
    // bump promotes the transaction source to ext v3 before the host runs.
    // Promoting the payer by hand first gives 36_885 bytes (+0.6%) and 151_887
    // instructions (+1.0%). An envelope through sendTransaction does get the
    // promotion; the low-level path does not.
    const d = pct(rows.sacToAccount.mem, NODE_APPLY.sacToAccount.mem);
    console.log(`  sacToAccount applied mem  node=${NODE_APPLY.sacToAccount.mem}  harness=${rows.sacToAccount.mem}  ${d.toFixed(2)}%`);
    expect(Math.abs(d)).toBeLessThan(1);
  });

  it('GAP: the fee-bearing byte counts are 36% short — 52 bytes per account', () => {
    expect(rows.sacToAccount.diskReadBytes, 'disk_read_bytes: node reads 2x144').toBe(288);
    expect(rows.sacToAccount.writeBytes, 'write_bytes: node writes 2x144').toBe(288);
  });

  it('one account in the footprint: the bytes match the node too', () => {
    // An earlier version pinned the residue here (92 / 316 bytes against the
    // node's 144 / 368: 52 short per AccountEntry, exactly) as the proof that
    // the extension chain was the whole gap. Simulation now promotes accounts
    // the way soroban-simulation's SimulationSnapshotSource does, so it is
    // closed.
    expect(rows.sacToContract.diskReadBytes).toBe(144);
    expect(rows.sacToContract.writeBytes).toBe(368);
  });
});

// ===========================================================================
describe('RED 3 (fixed): the RPC facade honours instructionLeeway', () => {
  // stellar-rpc: adjustment_config.instructions.additive_factor =
  //   max(50_000, resource_config.instruction_leeway)   (preflight/src/shared.rs)
  // This used to be hard-coded at 50_000, so every leeway returned the same
  // number. Measured on a live protocol-29 node (stellar-rpc 29.0.1, core
  // 29.0.0) for add(2,3), in two separate captures that agree:
  //   leeway 0 -> 325_616 | 50_001 -> 325_617 | 100_000 -> 375_616
  //   leeway 1_000_000 -> 1_275_616 | 20_000_000 -> 20_275_616
  // (A protocol-27 node gave 353_123 / 403_123 / 1_303_123 / 20_303_123: the
  // same deltas on the older host's metering.)
  it('scales the padding with the leeway exactly as the node does', async () => {
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
    console.log('  node    leeway -> {"0":325616,"100000":375616,"1000000":1275616,"20000000":20275616}');

    const node = { 0: 325_616, 100_000: 375_616, 1_000_000: 1_275_616, 20_000_000: 20_275_616 };
    for (const leeway of [0, 100_000, 1_000_000, 20_000_000] as const) {
      expect(seen[leeway], `leeway ${leeway}`).toBe(node[leeway]);
    }
  });
});

// ===========================================================================
describe('CLOSED 4: the acceptance test no longer pins node numbers it cannot reproduce', () => {
  // History: test/cost-params.test.ts pinned {add 304_084, putPersistent 550_088,
  // getPersistent 550_166}, 0.11-0.32% above the leeway-0 truth, and asserted
  // `delta > 0.5` on an upload against 1_547_805 — a node that ALREADY held
  // that ContractCode, so its preflight wrote nothing while the harness
  // uploaded for the first time. That assertion failed if the code became
  // exact. The file has since dropped both and compares only against the
  // shipped table; these keep it that way.
  const acceptance = readFileSync(
    fileURLToPath(new URL('../cost-params.test.ts', import.meta.url)), 'utf8');

  it('test/cost-params.test.ts pins none of the stale node counts', () => {
    for (const stale of ['304_084', '550_088', '550_166', '1_547_805', '1547805']) {
      expect(acceptance, `still pins ${stale}`).not.toContain(stale);
    }
  });

  it('and does not require the harness to be wrong on upload', () => {
    expect(acceptance).not.toMatch(/delta\s*>\s*0\.5/);
    // same bytes, fresh on both sides: the difference is zero
    expect(rows.uploadUnique.sim).toBe(NODE_PREFLIGHT_RAW.uploadUnique);
  });
});
