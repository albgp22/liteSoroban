/**
 * NODE SIDE, round 3: a genuinely fresh upload, measurement noise, and the
 * MEMORY differential — bisect the largest `alloc::sum(n)` the node's budget
 * still admits, which is a direct probe of the memory cost calibration.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { rpc, Keypair, TransactionBuilder, Operation, Asset, xdr, Address, nativeToScVal, hash as sha256 } from '@stellar/stellar-sdk';

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
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: string) => nativeToScVal(new Address(a), { type: 'address' });
let kp: Keypair;
async function friendbot(pk: string) { const r = await fetch(`http://localhost:8000/friendbot?addr=${pk}`); if (!r.ok) throw new Error('friendbot ' + r.status); }
async function buildTx(op: xdr.Operation, src = kp) {
  const acct = await server.getAccount(src.publicKey());
  return new TransactionBuilder(acct, { fee: '4000000', networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
}
async function simRaw(op: xdr.Operation, src = kp) {
  const tx = await buildTx(op, src);
  const res = await raw('simulateTransaction', { transaction: tx.toXDR(), resourceConfig: { instructionLeeway: 0 } });
  if (res.error) return { error: String(res.error).split('\n')[0] };
  const td = xdr.SorobanTransactionData.fromXDR(res.transactionData, 'base64');
  const r = td.resources();
  return { instructions: r.instructions(), writeBytes: r.writeBytes(), diskReadBytes: (r as any).diskReadBytes(), ro: r.footprint().readOnly().length, rw: r.footprint().readWrite().length };
}
async function poll(hash: string) {
  for (let i = 0; i < 120; i++) { const g: any = await raw('getTransaction', { hash }); if (g.status !== 'NOT_FOUND') return g; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error('never appeared');
}
async function submit(op: xdr.Operation, src = kp) {
  const tx = await buildTx(op, src);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error.split('\n')[0]);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(src);
  const send: any = await raw('sendTransaction', { transaction: prepared.toXDR() });
  if (send.status === 'ERROR') throw new Error('send ' + JSON.stringify(send.errorResult ?? send));
  const got = await poll(send.hash);
  if (got.status !== 'SUCCESS') throw new Error('tx ' + got.status);
  return got;
}
function returnedAddress(got: any): string {
  const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
  return Address.fromScAddress((meta.value() as any).sorobanMeta().returnValue().address()).toString();
}

const out: Record<string, any> = {};
async function main() {
  kp = Keypair.random();
  await friendbot(kp.publicKey());
  console.log('source', kp.publicKey());

  // 1. a wasm this ledger has never seen
  const UNIQUE = new Uint8Array(readFileSync(SCRATCH + 'unique.wasm'));
  out.uploadUnique = await simRaw(Operation.uploadContractWasm({ wasm: Buffer.from(UNIQUE) }));
  console.log('uploadUnique', out.uploadUnique);

  // 2. noise: repeat the native SAC transfer
  try { await submit(Operation.createStellarAssetContract({ asset: Asset.native() })); } catch { }
  const dest = Keypair.random();
  await friendbot(dest.publicKey());
  const nativeSac = Asset.native().contractId(PASS);
  const xferOp = Operation.invokeContractFunction({
    contract: nativeSac, function: 'transfer',
    args: [addrV(kp.publicKey()), addrV(dest.publicKey()), i128(1000n)],
  });
  out.sacRepeat = [];
  for (let i = 0; i < 3; i++) out.sacRepeat.push((await simRaw(xferOp)).instructions);
  console.log('sacRepeat', out.sacRepeat);

  // 3. MEMORY: the largest alloc::sum(n) the network budget admits
  const ALLOC = f('alloc.wasm');
  try { await submit(Operation.uploadContractWasm({ wasm: ALLOC })); } catch (e: any) { if (!/ExistingValue/.test(e.message)) throw e; }
  let alloc: string;
  try {
    const got = await submit(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(ALLOC), salt: Buffer.alloc(32, 77) }));
    alloc = returnedAddress(got);
  } catch (e: any) { throw e; }
  console.log('alloc contract', alloc);

  const trial = async (n: number) => {
    const r: any = await simRaw(Operation.invokeContractFunction({ contract: alloc, function: 'sum', args: [u32(n)] }));
    return { ok: !r.error, err: r.error, instructions: r.instructions };
  };
  // sanity + bracket
  console.log('sum(128)', await trial(128));
  let lo = 1, hi = 1;
  while ((await trial(hi)).ok && hi < 100_000_000) { lo = hi; hi *= 2; }
  console.log('bracket', lo, hi);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await trial(mid);
    if (t.ok) lo = mid; else hi = mid;
  }
  const at = await trial(lo);
  const over = await trial(hi);
  out.memThreshold = { maxOk: lo, firstFail: hi, atInstructions: at.instructions, failErr: over.err };
  console.log('memThreshold', out.memThreshold);

  writeFileSync(SCRATCH + 'node-results3.json', JSON.stringify(out, null, 2));
  console.log('wrote node-results3.json');
}
await main();
