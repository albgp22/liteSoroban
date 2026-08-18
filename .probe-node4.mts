/**
 * NODE SIDE, round 4 — the real thing: stellar-core emits `core_metrics`
 * diagnostic events (InvokeHostFunctionOpFrame.cpp:1026/1028) carrying the
 * ENFORCING pass's exact `cpu_insn` and `mem_byte`. Submit each scenario and
 * harvest them. No padding, no de-adjustment, no inference — and it is the only
 * way to see the node's MEMORY number at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { rpc, Keypair, TransactionBuilder, Operation, Asset, xdr, Address, nativeToScVal, hash as sha256, scValToNative } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';

const PASS = 'Standalone Network ; February 2017';
const URL = 'http://localhost:8000/rpc';
const FIX = './test/fixtures/';
const SCRATCH = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/';
const server = new rpc.Server(URL, { allowHttp: true });
const f = (n: string) => readFileSync(FIX + n);

async function raw(method: string, params: any): Promise<any> {
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
  return j.result;
}
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: string) => nativeToScVal(new Address(a), { type: 'address' });

let kp: Keypair;
async function friendbot(pk: string) { const r = await fetch(`http://localhost:8000/friendbot?addr=${pk}`); if (!r.ok) throw new Error('friendbot ' + r.status); }
async function buildTx(op: xdr.Operation, src = kp) {
  const acct = await server.getAccount(src.publicKey());
  return new TransactionBuilder(acct, { fee: '8000000', networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
}
async function poll(hash: string) {
  for (let i = 0; i < 150; i++) { const g: any = await raw('getTransaction', { hash }); if (g.status !== 'NOT_FOUND') return g; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error('never appeared');
}
function metrics(got: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b64 of got.diagnosticEventsXdr ?? []) {
    const de = xdr.DiagnosticEvent.fromXDR(b64, 'base64');
    const body = de.event().body().v0();
    const topics = body.topics();
    if (topics.length === 2 && topics[0].switch().name === 'scvSymbol' && topics[0].sym().toString() === 'core_metrics') {
      out[topics[1].sym().toString()] = Number(scValToNative(body.data()));
    }
  }
  return out;
}
/** submit; tolerate a FAILED tx (we want its metrics too) */
async function submitMeasured(op: xdr.Operation, src = kp, allowFail = false) {
  const tx = await buildTx(op, src);
  const sim = await server.simulateTransaction(tx);
  let prepared;
  if (rpc.Api.isSimulationError(sim)) {
    if (!allowFail) throw new Error('sim: ' + sim.error.split('\n')[0]);
    // hand-build resources for a call the preflight refuses to cost
    const res = new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 20_000_000, diskReadBytes: 10_000, writeBytes: 10_000,
    });
    const data = new xdr.SorobanTransactionData({ ext: new xdr.SorobanTransactionDataExt(0), resources: res, resourceFee: new xdr.Int64(5_000_000) });
    prepared = TransactionBuilder.cloneFrom(tx, { fee: '8000000', sorobanData: data }).build();
  } else {
    prepared = rpc.assembleTransaction(tx, sim).build();
  }
  prepared.sign(src);
  const send: any = await raw('sendTransaction', { transaction: prepared.toXDR() });
  if (send.status === 'ERROR') throw new Error('send ' + JSON.stringify(send.errorResult ?? send));
  const got = await poll(send.hash);
  return { status: got.status, metrics: metrics(got), got };
}
function returnedAddress(got: any): string {
  const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
  return Address.fromScAddress((meta.value() as any).sorobanMeta().returnValue().address()).toString();
}

const out: Record<string, any> = {};
const show = (k: string, r: any) => { out[k] = { status: r.status, cpu: r.metrics.cpu_insn, mem: r.metrics.mem_byte, m: r.metrics }; console.log(k, out[k].status, 'cpu', out[k].cpu, 'mem', out[k].mem); };

async function main() {
  kp = Keypair.random();
  await friendbot(kp.publicKey());
  console.log('source', kp.publicKey());

  // a second never-seen wasm for the upload scenario
  const U2 = SCRATCH + 'unique2.wasm';
  try { readFileSync(U2); } catch {
    const base = f('add_i32.wasm');
    const name = Buffer.from('v');
    const payload = randomBytes(16);
    const body = Buffer.concat([Buffer.from([name.length]), name, payload]);
    writeFileSync(U2, Buffer.concat([base, Buffer.from([0, body.length]), body]));
  }
  const UNIQUE2 = readFileSync(U2);

  show('uploadUnique2', await submitMeasured(Operation.uploadContractWasm({ wasm: UNIQUE2 })));

  const ADD_I32 = f('add_i32.wasm');
  try { await submitMeasured(Operation.uploadContractWasm({ wasm: ADD_I32 })); } catch { }
  const gotAdder = await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(ADD_I32), salt: Buffer.alloc(32, 41) }));
  show('deploy', gotAdder);
  const adder = returnedAddress(gotAdder.got);

  show('add', await submitMeasured(Operation.invokeContractFunction({ contract: adder, function: 'add', args: [i32(2), i32(3)] })));

  const CD = f('contract_data.wasm');
  try { await submitMeasured(Operation.uploadContractWasm({ wasm: CD })); } catch { }
  const gotStore = await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(CD), salt: Buffer.alloc(32, 42) }));
  const store = returnedAddress(gotStore.got);
  show('putPersistent', await submitMeasured(Operation.invokeContractFunction({ contract: store, function: 'put_persistent', args: [sym('k'), u64(42n)] })));
  show('getPersistent', await submitMeasured(Operation.invokeContractFunction({ contract: store, function: 'get_persistent', args: [sym('k')] })));
  show('largeWrite', await submitMeasured(Operation.invokeContractFunction({ contract: store, function: 'replace_with_bytes_and_extend', args: [sym('k'), u32(5), u32(100), u32(10_000)] })));

  const IC = f('invoke_contract.wasm');
  try { await submitMeasured(Operation.uploadContractWasm({ wasm: IC })); } catch { }
  const A = returnedAddress((await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(IC), salt: Buffer.alloc(32, 43) }))).got);
  const B = returnedAddress((await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(IC), salt: Buffer.alloc(32, 44) }))).got);
  show('crossContract', await submitMeasured(Operation.invokeContractFunction({ contract: A, function: 'add_with', args: [i32(3), i32(4), addrV(B)] })));

  // failing call
  const ERR = f('err.wasm');
  try { await submitMeasured(Operation.uploadContractWasm({ wasm: ERR })); } catch { }
  const errC = returnedAddress((await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(ERR), salt: Buffer.alloc(32, 45) }))).got);
  show('failing', await submitMeasured(Operation.invokeContractFunction({ contract: errC, function: 'err_eek', args: [] }), kp, true));

  // SAC
  try { await submitMeasured(Operation.createStellarAssetContract({ asset: Asset.native() })); } catch { }
  const dest = Keypair.random();
  await friendbot(dest.publicKey());
  const nativeSac = Asset.native().contractId(PASS);
  show('sacToAccount', await submitMeasured(Operation.invokeContractFunction({ contract: nativeSac, function: 'transfer', args: [addrV(kp.publicKey()), addrV(dest.publicKey()), i128(1000n)] })));
  show('sacToContract', await submitMeasured(Operation.invokeContractFunction({ contract: nativeSac, function: 'transfer', args: [addrV(kp.publicKey()), addrV(store), i128(1000n)] })));

  // alloc at the CPU ceiling
  const ALLOC = f('alloc.wasm');
  try { await submitMeasured(Operation.uploadContractWasm({ wasm: ALLOC })); } catch { }
  const al = returnedAddress((await submitMeasured(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(ALLOC), salt: Buffer.alloc(32, 46) }))).got);
  show('sum128', await submitMeasured(Operation.invokeContractFunction({ contract: al, function: 'sum', args: [u32(128)] })));
  show('sum300', await submitMeasured(Operation.invokeContractFunction({ contract: al, function: 'sum', args: [u32(300)] })));

  out._meta = { source: kp.publicKey(), dest: dest.publicKey(), adder, store, A, B, errC, al, nativeSac };
  writeFileSync(SCRATCH + 'node-results4.json', JSON.stringify(out, null, 2));
  console.log('wrote node-results4.json');
}
await main();
