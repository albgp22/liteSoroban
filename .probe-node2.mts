/**
 * NODE SIDE, round 2.
 *  (a) leeway scan: solve for the node's RAW recorded instruction count with no
 *      assumption about the padding, by pushing the additive factor above the
 *      multiplicative one (instruction_leeway raises `additive_factor`).
 *  (b) more scenarios: SAC transfer to a CONTRACT (no AccountEntry), a
 *      non-native SAC transfer between two G accounts with trustlines, a mint,
 *      a contract-driven SAC transfer, a deploy, and a big upload.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  rpc, Keypair, TransactionBuilder, Operation, Asset, xdr, Address, nativeToScVal,
  hash as sha256,
} from '@stellar/stellar-sdk';

const PASS = 'Standalone Network ; February 2017';
const URL = 'http://localhost:8000/rpc';
const FIX = './test/fixtures/';
const OUT = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/node-results2.json';
const server = new rpc.Server(URL, { allowHttp: true });
const f = (n: string) => readFileSync(FIX + n);

async function raw(method: string, params: any): Promise<any> {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
  return j.result;
}
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: string) => nativeToScVal(new Address(a), { type: 'address' });

let kp: Keypair;
async function friendbot(pk: string) {
  const r = await fetch(`http://localhost:8000/friendbot?addr=${pk}`);
  if (!r.ok) throw new Error('friendbot ' + r.status);
}
async function buildTx(op: xdr.Operation, src = kp, fee = '4000000') {
  const acct = await server.getAccount(src.publicKey());
  return new TransactionBuilder(acct, { fee, networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
}
async function simRaw(op: xdr.Operation, leeway: number | null, src = kp) {
  const tx = await buildTx(op, src);
  const params: any = { transaction: tx.toXDR() };
  if (leeway !== null) params.resourceConfig = { instructionLeeway: leeway };
  const res = await raw('simulateTransaction', params);
  if (res.error) return { error: String(res.error).split('\n')[0] };
  const td = xdr.SorobanTransactionData.fromXDR(res.transactionData, 'base64');
  const r = td.resources();
  return {
    instructions: r.instructions(),
    writeBytes: r.writeBytes(),
    diskReadBytes: (r as any).diskReadBytes(),
    ro: r.footprint().readOnly().length,
    rw: r.footprint().readWrite().length,
  };
}
async function poll(hash: string) {
  for (let i = 0; i < 120; i++) {
    const g: any = await raw('getTransaction', { hash });
    if (g.status !== 'NOT_FOUND') return g;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('never appeared');
}
async function submit(op: xdr.Operation, src = kp, extra: Keypair[] = []) {
  const tx = await buildTx(op, src);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error.split('\n')[0]);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(src, ...extra);
  const send: any = await raw('sendTransaction', { transaction: prepared.toXDR() });
  if (send.status === 'ERROR') throw new Error('send ' + JSON.stringify(send.errorResult ?? send));
  const got = await poll(send.hash);
  if (got.status !== 'SUCCESS') throw new Error('tx ' + got.status);
  return got;
}
async function submitClassic(op: xdr.Operation, src: Keypair) {
  const acct = await server.getAccount(src.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
  tx.sign(src);
  const send: any = await raw('sendTransaction', { transaction: tx.toXDR() });
  if (send.status === 'ERROR') throw new Error('classic send ' + JSON.stringify(send.errorResult ?? send));
  const got = await poll(send.hash);
  if (got.status !== 'SUCCESS') throw new Error('classic ' + got.status + ' ' + JSON.stringify(got.resultXdr));
  return got;
}
function returnedAddress(got: any): string {
  const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
  const rv: xdr.ScVal = (meta.value() as any).sorobanMeta().returnValue();
  return Address.fromScAddress(rv.address()).toString();
}
async function uploadAndDeploy(wasm: Buffer, salt: Buffer) {
  try { await submit(Operation.uploadContractWasm({ wasm })); } catch (e: any) { if (!/ExistingValue/.test(e.message)) throw e; }
  const got = await submit(Operation.createCustomContract({
    address: Address.fromString(kp.publicKey()), wasmHash: sha256(wasm), salt,
  }));
  return returnedAddress(got);
}

const out: Record<string, any> = {};

async function main() {
  kp = Keypair.random();
  await friendbot(kp.publicKey());
  console.log('source', kp.publicKey());

  const ADD_I32 = f('add_i32.wasm');
  const SMART = f('smart_account.wasm');
  const SAC_TRANSFER = f('contract_sac_transfer.wasm');

  // (a) leeway scan on upload (multiplicative regime) and add (additive regime)
  const adder = await uploadAndDeploy(ADD_I32, Buffer.alloc(32, 11));
  const uploadOp = Operation.uploadContractWasm({ wasm: SMART });   // never uploaded yet
  const addOp = Operation.invokeContractFunction({
    contract: adder, function: 'add',
    args: [nativeToScVal(2, { type: 'i32' }), nativeToScVal(3, { type: 'i32' })],
  });
  out.leewayScan = {};
  for (const [name, op] of [['add', addOp], ['uploadSmart', uploadOp]] as const) {
    const row: Record<string, number> = {};
    for (const lw of [0, 1_000, 50_000, 50_001, 100_000, 1_000_000, 3_000_000, 20_000_000]) {
      const r: any = await simRaw(op as any, lw);
      row['lw' + lw] = r.instructions;
    }
    const rdef: any = await simRaw(op as any, null);
    row.defaultLeeway = rdef.instructions;
    out.leewayScan[name] = row;
    console.log(name, row);
  }

  // (b) SAC scenarios
  const store = adder; // reuse for a contract-address destination
  const nativeSac = Asset.native().contractId(PASS);
  try { await submit(Operation.createStellarAssetContract({ asset: Asset.native() })); } catch { }

  const dest = Keypair.random();
  await friendbot(dest.publicKey());

  out.sacToAccount = await simRaw(Operation.invokeContractFunction({
    contract: nativeSac, function: 'transfer',
    args: [addrV(kp.publicKey()), addrV(dest.publicKey()), i128(1000n)],
  }), 0);
  out.sacToContract = await simRaw(Operation.invokeContractFunction({
    contract: nativeSac, function: 'transfer',
    args: [addrV(kp.publicKey()), addrV(store), i128(1000n)],
  }), 0);
  console.log('sacToAccount', out.sacToAccount, '\nsacToContract', out.sacToContract);

  // non-native asset: issuer -> holder(kp) -> dest, both with trustlines
  const iss = Keypair.random();
  await friendbot(iss.publicKey());
  const ABC = new Asset('ABC', iss.publicKey());
  await submitClassic(Operation.changeTrust({ asset: ABC }), kp);
  await submitClassic(Operation.changeTrust({ asset: ABC }), dest);
  await submitClassic(Operation.payment({ destination: kp.publicKey(), asset: ABC, amount: '1000' }), iss);
  const abcSac = ABC.contractId(PASS);
  await submit(Operation.createStellarAssetContract({ asset: ABC }));
  out.sacAssetTransfer = await simRaw(Operation.invokeContractFunction({
    contract: abcSac, function: 'transfer',
    args: [addrV(kp.publicKey()), addrV(dest.publicKey()), i128(100n)],
  }), 0);
  out.sacMint = await simRaw(Operation.invokeContractFunction({
    contract: abcSac, function: 'mint', args: [addrV(dest.publicKey()), i128(100n)],
  }), 0, iss);
  console.log('sacAssetTransfer', out.sacAssetTransfer, '\nsacMint', out.sacMint);

  // contract-driven SAC transfer: contract holds the asset, sends 1 to an account
  const sacC = await uploadAndDeploy(SAC_TRANSFER, Buffer.alloc(32, 12));
  await submit(Operation.invokeContractFunction({
    contract: abcSac, function: 'mint', args: [addrV(sacC), i128(100n)],
  }), iss);
  out.contractSacTransfer = await simRaw(Operation.invokeContractFunction({
    contract: sacC, function: 'transfer_1', args: [addrV(abcSac), addrV(dest.publicKey())],
  }), 0);
  console.log('contractSacTransfer', out.contractSacTransfer);

  // deploy (createCustomContract) of an already-uploaded wasm
  out.deploy = await simRaw(Operation.createCustomContract({
    address: Address.fromString(kp.publicKey()), wasmHash: sha256(ADD_I32), salt: Buffer.alloc(32, 33),
  }), 0);
  // big upload (smart_account.wasm)
  out.uploadSmart = await simRaw(uploadOp, 0);
  console.log('deploy', out.deploy, '\nuploadSmart', out.uploadSmart);

  out._meta = { source: kp.publicKey(), dest: dest.publicKey(), issuer: iss.publicKey(), adder, sacC, nativeSac, abcSac };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('wrote', OUT);
}
await main();
