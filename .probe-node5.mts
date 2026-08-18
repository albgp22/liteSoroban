/** NODE SIDE, round 5 — the failing call, costed properly. */
import { readFileSync, writeFileSync } from 'node:fs';
import { rpc, Keypair, TransactionBuilder, Operation, xdr, Address, nativeToScVal, scValToNative, hash as sha256 } from '@stellar/stellar-sdk';

const PASS = 'Standalone Network ; February 2017';
const URL = 'http://localhost:8000/rpc';
const FIX = './test/fixtures/';
const SCRATCH = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/';
const server = new rpc.Server(URL, { allowHttp: true });
const f = (n: string) => readFileSync(FIX + n);
async function raw(method: string, params: any): Promise<any> {
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json(); if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error)); return j.result;
}
let kp: Keypair;
async function buildTx(op: xdr.Operation) {
  const acct = await server.getAccount(kp.publicKey());
  return new TransactionBuilder(acct, { fee: '8000000', networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
}
async function poll(hash: string) {
  for (let i = 0; i < 150; i++) { const g: any = await raw('getTransaction', { hash }); if (g.status !== 'NOT_FOUND') return g; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error('never appeared');
}
function metrics(got: any) {
  const out: Record<string, number> = {};
  for (const b64 of got.diagnosticEventsXdr ?? []) {
    const de = xdr.DiagnosticEvent.fromXDR(b64, 'base64');
    const body = de.event().body().v0(); const t = body.topics();
    if (t.length === 2 && t[0].switch().name === 'scvSymbol' && t[0].sym().toString() === 'core_metrics') out[t[1].sym().toString()] = Number(scValToNative(body.data()));
  }
  return out;
}
async function submitAssembled(op: xdr.Operation, sorobanData?: xdr.SorobanTransactionData) {
  const tx = await buildTx(op);
  let prepared;
  if (sorobanData) {
    prepared = TransactionBuilder.cloneFrom(tx, { fee: '8000000', sorobanData }).build();
  } else {
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error.split('\n')[0]);
    prepared = rpc.assembleTransaction(tx, sim).build();
  }
  prepared.sign(kp);
  const send: any = await raw('sendTransaction', { transaction: prepared.toXDR() });
  if (send.status === 'ERROR') throw new Error('send ' + JSON.stringify(send.errorResult ?? send));
  const got = await poll(send.hash);
  return { status: got.status, metrics: metrics(got), got };
}
function returnedAddress(got: any) {
  const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
  return Address.fromScAddress((meta.value() as any).sorobanMeta().returnValue().address()).toString();
}

kp = Keypair.random();
await (await fetch(`http://localhost:8000/friendbot?addr=${kp.publicKey()}`)).text();
const ERR = f('err.wasm');
try { await submitAssembled(Operation.uploadContractWasm({ wasm: ERR })); } catch { }
const errC = returnedAddress((await submitAssembled(Operation.createCustomContract({ address: Address.fromString(kp.publicKey()), wasmHash: sha256(ERR), salt: Buffer.alloc(32, 55) }))).got);
console.log('err contract', errC);

// hand-built footprint: instance + code, read-only, which is exactly what a
// pure `err_eek()` call touches.
const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: Address.fromString(errC).toScAddress(),
  key: xdr.ScVal.scvLedgerKeyContractInstance(),
  durability: xdr.ContractDataDurability.persistent(),
}));
const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: sha256(ERR) }));
const res = new xdr.SorobanResources({
  footprint: new xdr.LedgerFootprint({ readOnly: [instanceKey, codeKey], readWrite: [] }),
  instructions: 10_000_000, diskReadBytes: 0, writeBytes: 0,
});
const data = new xdr.SorobanTransactionData({ ext: new xdr.SorobanTransactionDataExt(0), resources: res, resourceFee: new xdr.Int64(3_000_000) });
const failed = await submitAssembled(Operation.invokeContractFunction({ contract: errC, function: 'err_eek', args: [] }), data);
console.log('err_eek', failed.status, 'cpu', failed.metrics.cpu_insn, 'mem', failed.metrics.mem_byte);

// and val() itself, for a like-for-like successful baseline
const okApplied = { status: "SKIPPED", metrics: {} as any };
console.log('val', okApplied.status, 'cpu', okApplied.metrics.cpu_insn, 'mem', okApplied.metrics.mem_byte);

writeFileSync(SCRATCH + 'node-results5.json', JSON.stringify({
  errC,
  valRecordingPadded: null,
  failing: { status: failed.status, cpu: failed.metrics.cpu_insn, mem: failed.metrics.mem_byte },
  val: { status: okApplied.status, cpu: okApplied.metrics.cpu_insn, mem: okApplied.metrics.mem_byte },
}, null, 2));
console.log('wrote node-results5.json');
