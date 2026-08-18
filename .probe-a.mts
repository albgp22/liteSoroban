import { readFileSync } from 'node:fs';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';

const FIX = '/Users/alberto/Documents/Projects/stellar-testing/test/fixtures/';
const f = (n) => new Uint8Array(readFileSync(FIX + n));
const sym = (s) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n) => nativeToScVal(n, { type: 'u32' });
const u64 = (n) => nativeToScVal(n, { type: 'u64' });

const L = new Ledger();
const source = L.fundAccount(1);
function deploy(code, salt = 0) {
  const h = L.seedWasm(code);
  const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, salt)), source);
  if (!sent.ok) throw new Error(sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr, 'base64').address();
}

const cd = deploy(f('contract_data.wasm'), 1);
// probe signature of replace_with_bytes_and_extend
for (const args of [
  [sym('k'), u32(1), u32(100), u32(200)],
  [sym('k'), u32(1), u32(100)],
  [sym('k'), u32(1)],
]) {
  try {
    const r = L.simulate(invokeHostFn(cd, 'replace_with_bytes_and_extend', args), source);
    console.log('args', args.length, '->', r.ok, r.error?.slice(0, 120), 'instr', r.instructions, 'write', r.writeBytes);
  } catch (e) {
    console.log('args', args.length, 'THREW', String(e.message).slice(0, 160));
  }
}

const lg = deploy(f('loadgen.wasm'), 2);
for (const args of [
  [u32(10), u32(0), u32(0)],
  [u32(10), u64(0n), u32(1), u32(100)],
  [u32(10), u32(0), u32(1), u32(100)],
]) {
  try {
    const r = L.simulate(invokeHostFn(lg, 'do_work', args), source);
    console.log('do_work args', args.length, '->', r.ok, r.error?.slice(0, 100), 'instr', r.instructions);
  } catch (e) {
    console.log('do_work args', args.length, 'THREW', String(e.message).slice(0, 140));
  }
}
