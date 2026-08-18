/**
 * HARNESS SIDE, round 4 — enforcing pass, compared against the node's own
 * `core_metrics` cpu_insn / mem_byte diagnostic events.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { xdr, nativeToScVal, Address } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';
import { preFundedWallet, nativeToken } from './src/fixtures.js';

const PASS = 'Standalone Network ; February 2017';
const FIX = './test/fixtures/';
const SCRATCH = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/';
const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

const calibrated = process.argv.includes('--default') ? false : true;
const L = new Ledger({ networkPassphrase: PASS });
if (calibrated) {
  L.setCostParams(PROTOCOL_27_COST_PARAMS.cpuInstructions, PROTOCOL_27_COST_PARAMS.memoryBytes, P27_CPU_LIMIT, P27_MEM_LIMIT);
}
const payer = preFundedWallet(L);
const source = payer.accountIdB64;
const deployFrom = (code: Uint8Array, salt: number) => {
  const h = L.seedWasm(code);
  const hf = createContractHostFn(source, h, Buffer.alloc(32, salt));
  const { sim, sent } = L.simulateAndSend(hf, source);
  if (!sent.ok) throw new Error('deploy: ' + sent.error);
  return { addr: xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address(), sim, sent };
};

const out: Record<string, any> = {};
function apply(k: string, hf: xdr.HostFunction, src = source) {
  const sim = L.simulate(hf, src);
  if (!sim.ok) throw new Error(k + ' sim: ' + sim.error);
  const sent = L.send(hf, src, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
  out[k] = { ok: sent.ok, cpu: Number(sent.cpuInsns), mem: Number(sent.memBytes), simCpu: sim.instructions, simMem: Number(sim.memBytes) };
  return sent;
}

apply('uploadUnique2', uploadWasmHostFn(new Uint8Array(readFileSync(SCRATCH + 'unique2.wasm'))));

const ADD_I32 = f('add_i32.wasm');
const addHash = L.seedWasm(ADD_I32);
{
  const hf = createContractHostFn(source, addHash, Buffer.alloc(32, 41));
  const sim = L.simulate(hf, source);
  const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
  out.deploy = { ok: sent.ok, cpu: Number(sent.cpuInsns), mem: Number(sent.memBytes), simCpu: sim.instructions, simMem: Number(sim.memBytes) };
  var adder = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
}
apply('add', invokeHostFn(adder!, 'add', [i32(2), i32(3)]));

const store = deployFrom(f('contract_data.wasm'), 42).addr;
apply('putPersistent', invokeHostFn(store, 'put_persistent', [sym('k'), u64(42n)]));
apply('getPersistent', invokeHostFn(store, 'get_persistent', [sym('k')]));
apply('largeWrite', invokeHostFn(store, 'replace_with_bytes_and_extend', [sym('k'), u32(5), u32(100), u32(10_000)]));

const A = deployFrom(f('invoke_contract.wasm'), 43).addr;
const B = deployFrom(f('invoke_contract.wasm'), 44).addr;
apply('crossContract', invokeHostFn(A, 'add_with', [i32(3), i32(4), addrV(B)]));

// failing call: borrow a footprint from a call that succeeds on the same contract
const errC = deployFrom(f('err.wasm'), 45).addr;
{
  const cheap = L.simulate(invokeHostFn(errC, 'val', []), source);
  const hf = invokeHostFn(errC, 'err_eek', []);
  const sent = L.send(hf, source, cheap.resourcesXdr, cheap.authXdr, []);
  out.failing = { ok: sent.ok, err: sent.error?.split('\n')[0], cpu: Number(sent.cpuInsns), mem: Number(sent.memBytes) };
}

const dest = preFundedWallet(L);
const nat = nativeToken(L, payer);
apply('sacToAccount', invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(dest.address), i128(1000n)]));
apply('sacToContract', invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(store), i128(1000n)]));

const al = deployFrom(f('alloc.wasm'), 46).addr;
apply('sum128', invokeHostFn(al, 'sum', [u32(128)]));
apply('sum300', invokeHostFn(al, 'sum', [u32(300)]));

const node = JSON.parse(readFileSync(SCRATCH + 'node-results4.json', 'utf8'));
const rows: string[] = [];
rows.push(`${'scenario'.padEnd(16)}${'node cpu'.padStart(12)}${'harness cpu'.padStart(12)}${'Δcpu%'.padStart(9)}   ${'node mem'.padStart(11)}${'harness mem'.padStart(12)}${'Δmem%'.padStart(9)}`);
for (const k of Object.keys(out)) {
  const n = node[k];
  if (!n) continue;
  const h = out[k];
  const dc = ((h.cpu - n.cpu) / n.cpu) * 100;
  const dm = ((h.mem - n.mem) / n.mem) * 100;
  rows.push(`${k.padEnd(16)}${String(n.cpu).padStart(12)}${String(h.cpu).padStart(12)}${dc.toFixed(2).padStart(9)}   ${String(n.mem).padStart(11)}${String(h.mem).padStart(12)}${dm.toFixed(2).padStart(9)}`);
}
console.log(`\n=== ENFORCING PASS (${calibrated ? 'CALIBRATED' : 'DEFAULT (protocol-20) table'}) ===`);
console.log(rows.join('\n') + '\n');
writeFileSync(SCRATCH + `harness-results4${calibrated ? '' : '-default'}.json`, JSON.stringify(out, null, 2));
