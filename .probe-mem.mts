import { readFileSync } from 'node:fs';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';

const FIX = './test/fixtures/';
const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });

const L = new Ledger({ networkPassphrase: 'Standalone Network ; February 2017' });
L.setCostParams(PROTOCOL_27_COST_PARAMS.cpuInstructions, PROTOCOL_27_COST_PARAMS.memoryBytes, P27_CPU_LIMIT, P27_MEM_LIMIT);
const source = L.fundAccount(1);
const deploy = (code: Uint8Array, salt: number) => {
  const h = L.seedWasm(code);
  const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, salt)), source);
  if (!sent.ok) throw new Error('deploy: ' + sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
};
const try_ = (label: string, fn: () => any) => {
  try { const r = fn(); console.log(label, r.ok, r.error?.split('\n')[0] ?? '', 'cpu', r.instructions, 'mem', Number(r.memBytes), 'mem%', ((Number(r.memBytes) / 41943040) * 100).toFixed(1), 'cpu%', ((r.instructions / 1e8) * 100).toFixed(1)); return r; }
  catch (e: any) { console.log(label, 'THREW', String(e.message).split('\n')[0]); return null; }
};

const lg = deploy(f('loadgen.wasm'), 1);
for (const args of [
  [u32(10), u32(0), u32(0)],
  [u32(10), u32(0), u32(1)],
  [u32(10), u32(0), u32(1), u32(1)],
  [u64(10n), u64(0n), u32(1)],
  [u32(10), u64(0n), u32(1)],
]) try_(`do_work(${args.length})`, () => L.simulate(invokeHostFn(lg, 'do_work', args), source));

const lm = deploy(f('linear_memory.wasm'), 2);
console.log('linear_memory exports:', WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(FIX + 'linear_memory.wasm'))).filter((e) => e.kind === 'function').map((e) => e.name).join(','));

const ic = deploy(f('invoke_contract.wasm'), 3);
const ic2 = deploy(f('invoke_contract.wasm'), 4);
try_('add_with', () => L.simulate(invokeHostFn(ic, 'add_with', [nativeToScVal(1, { type: 'i32' }), nativeToScVal(2, { type: 'i32' }), xdr.ScVal.scvAddress(ic2)]), source));

const cd = deploy(f('contract_data.wasm'), 5);
for (const kb of [1, 10, 40, 60]) {
  try_(`replace_with_bytes(${kb}kb)`, () => L.simulate(invokeHostFn(cd, 'replace_with_bytes_and_extend', [sym('k'), u32(kb), u32(100), u32(10000)]), source));
}

const al = deploy(f('alloc.wasm'), 6);
for (const n of [128, 300, 585, 586, 600]) {
  try_(`sum(${n})`, () => L.simulate(invokeHostFn(al, 'sum', [u32(n)]), source));
}
