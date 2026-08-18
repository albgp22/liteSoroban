import { readFileSync } from 'node:fs';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';

const FIX = './test/fixtures/';
const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });

const L = new Ledger({ networkPassphrase: 'Standalone Network ; February 2017' });
L.setCostParams(PROTOCOL_27_COST_PARAMS.cpuInstructions, PROTOCOL_27_COST_PARAMS.memoryBytes, P27_CPU_LIMIT, P27_MEM_LIMIT);
const source = L.fundAccount(1);
let salt = 0;
const deploy = (code: Uint8Array) => {
  const h = L.seedWasm(code);
  const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, ++salt)), source);
  if (!sent.ok) throw new Error(sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
};

console.log('README reference numbers: upload 1,547,805  add 304,084  put 550,088  get 550,166');
for (const n of ['add_i32.wasm', 'upstream_add_i32.wasm', 'add_i32_p20.wasm', 'e2e_add_i32.wasm']) {
  try {
    const code = f(n);
    const up = L.simulate(uploadWasmHostFn(code), source).instructions;
    const a = deploy(code);
    const add = L.simulate(invokeHostFn(a, 'add', [i32(2), i32(3)]), source).instructions;
    console.log(`${n.padEnd(24)} bytes=${String(code.length).padStart(5)} upload=${String(up).padStart(9)} add=${String(add).padStart(8)}`);
  } catch (e: any) { console.log(n, 'ERR', String(e.message).split('\n')[0]); }
}
for (const n of ['contract_data.wasm', 'upstream_contract_data.wasm', 'e2e_contract_storage.wasm']) {
  try {
    const code = f(n);
    const c = deploy(code);
    const put = L.simulate(invokeHostFn(c, 'put_persistent', [sym('k'), u64(42n)]), source).instructions;
    L.simulateAndSend(invokeHostFn(c, 'put_persistent', [sym('k'), u64(42n)]), source);
    const get = L.simulate(invokeHostFn(c, 'get_persistent', [sym('k')]), source).instructions;
    console.log(`${n.padEnd(28)} bytes=${String(code.length).padStart(5)} put=${String(put).padStart(8)} get=${String(get).padStart(8)}`);
  } catch (e: any) { console.log(n, 'ERR', String(e.message).split('\n')[0]); }
}
