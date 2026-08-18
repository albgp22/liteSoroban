import { readFileSync } from 'node:fs';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from './src/index.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';

const FIX = './test/fixtures/';
const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });

const L = new Ledger({ networkPassphrase: 'Standalone Network ; February 2017' });
L.setCostParams(PROTOCOL_27_COST_PARAMS.cpuInstructions, PROTOCOL_27_COST_PARAMS.memoryBytes, P27_CPU_LIMIT, P27_MEM_LIMIT);
const source = L.fundAccount(1);
const IC = f('invoke_contract.wasm');
const h = L.seedWasm(IC);
const deploy = (salt: number) => {
  const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, salt)), source);
  if (!sent.ok) throw new Error('deploy: ' + sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
};
const C = Array.from({ length: 40 }, (_, i) => deploy(i + 20));
console.log('deployed', C.length);

const run = (label: string, hf: xdr.HostFunction) => {
  try {
    const r = L.simulate(hf, source);
    console.log(label, r.ok, r.error?.split('\n')[0] ?? '', 'cpu', r.instructions, 'mem', Number(r.memBytes), `mem%=${((Number(r.memBytes) / 41943040) * 100).toFixed(1)} cpu%=${((r.instructions / 1e8) * 100).toFixed(1)}`);
    return r;
  } catch (e: any) { console.log(label, 'THREW', String(e.message).split('\n')[0]); return null; }
};

// probe `invoke` signature
run('invoke(addr,sym,vec)', invokeHostFn(C[0], 'invoke', [
  xdr.ScVal.scvAddress(C[1]), xdr.ScVal.scvSymbol('add'), xdr.ScVal.scvVec([i32(1), i32(2)]),
]));
run('invoke(addr,sym) ', invokeHostFn(C[0], 'invoke', [xdr.ScVal.scvAddress(C[1]), xdr.ScVal.scvSymbol('add')]));

// nested chain: C0.invoke(C1,"invoke",[C2,"invoke",[...,[Cn,"add",[1,2]]]])
function chain(depth: number): xdr.HostFunction {
  let args: xdr.ScVal[] = [xdr.ScVal.scvAddress(C[depth]), xdr.ScVal.scvSymbol('add'), xdr.ScVal.scvVec([i32(1), i32(2)])];
  for (let k = depth - 1; k >= 1; k--) {
    args = [xdr.ScVal.scvAddress(C[k]), xdr.ScVal.scvSymbol('invoke'), xdr.ScVal.scvVec(args)];
  }
  return invokeHostFn(C[0], 'invoke', args);
}
for (const d of [1, 2, 4, 8, 16, 24, 30, 34, 36, 38]) run(`chain(${d})`, chain(d));
