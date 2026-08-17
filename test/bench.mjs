// THROWAWAY: measurements, not a test. `node test/bench.mjs`
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

const require = createRequire(import.meta.url);
const wasm = require('../pkg/soroban_host.js');

const CODE = new Uint8Array(readFileSync(new URL('./fixtures/contract_data.wasm', import.meta.url)));
const sym = (s) => nativeToScVal(s, { type: 'symbol' }).toXDR('base64');
const u64 = (n) => nativeToScVal(n, { type: 'u64' }).toXDR('base64');
const sv = (b64) => xdr.ScVal.fromXDR(b64, 'base64');

function createFn(deployerB64, hashB64) {
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.fromXDR(deployerB64, 'base64')),
          salt: Buffer.alloc(32),
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hashB64, 'base64')),
      constructorArgs: [],
    }),
  ).toXDR('base64');
}

function invokeFn(addr, fn, argsB64) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: addr, functionName: fn, args: argsB64.map(sv) }),
  ).toXDR('base64');
}

function freshLedgerWithContract() {
  const env = new wasm.SorobanEnv(27, 1_000_000);
  const src = env.fundAccount(1);
  const hash = env.seedWasm(CODE);
  const fn = createFn(src, hash);
  const sim = env.simulate(fn, src);
  const sent = env.send(fn, src, sim.resourcesXdr, sim.authXdr, Uint32Array.from(sim.restoredRwEntryIndices));
  const addr = sv(sent.returnValueXdr).address();
  return { env, src, addr };
}

const time = (label, n, f) => {
  f(); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f(i);
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${(ms / n).toFixed(3)} ms  (n=${n})`);
  return ms / n;
};

console.log(`node ${process.version} | host protocol ${wasm.hostProtocolVersion()}`);
console.log(`wasm module: ${(readFileSync(new URL('../pkg/soroban_host_bg.wasm', import.meta.url)).length / 1024 / 1024).toFixed(2)} MB\n`);

console.log('SETUP / ISOLATION');
time('new Ledger + fundAccount (isolation cost)', 500, () => {
  const e = new wasm.SorobanEnv(27, 1_000_000);
  e.fundAccount(1);
});
time('full fixture: account + wasm + deployed contract', 200, () => freshLedgerWithContract());

const { env, src, addr } = freshLedgerWithContract();
const putFn = invokeFn(addr, 'put_persistent', [sym('ctr'), u64(42n)]);
const getFn = invokeFn(addr, 'get_persistent', [sym('ctr')]);

console.log('\nPER-TRANSACTION');
time('simulate (recording / preflight)', 500, () => env.simulate(putFn, src));
const simPut = env.simulate(putFn, src);
time('send (enforcing apply + merge changes)', 500, () =>
  env.send(putFn, src, simPut.resourcesXdr, simPut.authXdr, Uint32Array.from(simPut.restoredRwEntryIndices)));
time('simulate + send (what an app actually does)', 300, () => {
  const s = env.simulate(putFn, src);
  env.send(putFn, src, s.resourcesXdr, s.authXdr, Uint32Array.from(s.restoredRwEntryIndices));
});

console.log('\nSNAPSHOT / RESTORE');
const snapId = env.snapshot();
time('snapshot()', 2000, () => env.snapshot());
time('restore()', 2000, () => env.restore(snapId));

console.log('\nDETERMINISM (metering must be reproducible)');
const runs = new Set();
for (let i = 0; i < 20; i++) {
  const e2 = freshLedgerWithContract();
  const s = e2.env.simulate(invokeFn(e2.addr, 'put_persistent', [sym('ctr'), u64(42n)]), e2.src);
  runs.add(`${s.instructions}/${s.cpuInsns}/${s.readBytes}/${s.writeBytes}`);
}
console.log(`  distinct metering results across 20 fresh ledgers: ${runs.size}`);
console.log(`  value: ${[...runs][0]}  (instructions/cpuInsns/readBytes/writeBytes)`);

console.log('\nCORRECTNESS SPOT-CHECKS');
const s2 = env.simulate(putFn, src);
env.send(putFn, src, s2.resourcesXdr, s2.authXdr, Uint32Array.from(s2.restoredRwEntryIndices));
const readBack = env.simulate(getFn, src);
console.log(`  round-tripped value: ${scValToNative(sv(readBack.returnValueXdr))}`);
console.log(`  footprint: ${s2.readOnlyKeys.length} read-only, ${s2.readWriteKeys.length} read-write`);
console.log(`  resource fee inputs: instructions=${s2.instructions} readBytes=${s2.readBytes} writeBytes=${s2.writeBytes}`);

// Why the enforcing path rejects a stripped footprint.
const bad = xdr.SorobanResources.fromXDR(s2.resourcesXdr, 'base64');
bad.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));
try {
  const r = env.send(putFn, src, bad.toXDR('base64'), s2.authXdr, new Uint32Array());
  console.log(`  stripped footprint -> ok=${r.ok} error=${(r.error || '').slice(0, 120)}`);
} catch (e) {
  console.log(`  stripped footprint -> threw: ${String(e.message).slice(0, 120)}`);
}
console.log(`  ledger still usable afterwards: ${env.simulate(getFn, src).ok}`);
