/**
 * NODE SIDE of the differential. Runs nine scenarios against the live
 * protocol-27 quickstart node and records, for each, the instruction count
 * stellar-rpc returns with instructionLeeway pinned to 0, plus the padded
 * `minResourceFee` and the footprint.
 *
 * Output: /tmp/.../node-results.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  rpc,
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  xdr,
  Address,
  nativeToScVal,
  authorizeEntry,
  hash as sha256,
  StrKey,
} from '@stellar/stellar-sdk';

const PASS = 'Standalone Network ; February 2017';
const URL = 'http://localhost:8000/rpc';
const FIX = './test/fixtures/';
const OUT =
  '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/node-results.json';

const server = new rpc.Server(URL, { allowHttp: true });
const f = (n: string) => readFileSync(FIX + n);

async function raw(method: string, params: any): Promise<any> {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
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

async function friendbot(pk: string) {
  const r = await fetch(`http://localhost:8000/friendbot?addr=${pk}`);
  if (!r.ok) throw new Error('friendbot ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function buildTx(op: xdr.Operation, fee = '2000000') {
  const acct = await server.getAccount(kp.publicKey());
  return new TransactionBuilder(acct, { fee, networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(300)
    .build();
}

/** Measurement: leeway 0, no assembly, nothing submitted. */
async function measure(op: xdr.Operation) {
  const tx = await buildTx(op);
  const res = await raw('simulateTransaction', {
    transaction: tx.toXDR(),
    resourceConfig: { instructionLeeway: 0 },
  });
  if (res.error) return { error: String(res.error).slice(0, 300), raw: res };
  const td = xdr.SorobanTransactionData.fromXDR(res.transactionData, 'base64');
  const r = td.resources();
  const fp = r.footprint();
  return {
    instructions: r.instructions(),
    readBytes: (r as any).diskReadBytes ? (r as any).diskReadBytes() : undefined,
    writeBytes: r.writeBytes(),
    minResourceFee: res.minResourceFee,
    roCount: fp.readOnly().length,
    rwCount: fp.readWrite().length,
    auth: res.results?.[0]?.auth ?? [],
  };
}

async function poll(hash: string) {
  for (let i = 0; i < 90; i++) {
    const g: any = await raw('getTransaction', { hash });
    if (g.status !== 'NOT_FOUND') return g;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('tx never appeared: ' + hash);
}

async function submit(op: xdr.Operation, signers: Keypair[] = []) {
  const tx = await buildTx(op);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error('sim error: ' + sim.error);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp, ...signers);
  const send: any = await raw('sendTransaction', { transaction: prepared.toXDR() });
  if (send.status === 'ERROR') throw new Error('send ERROR ' + JSON.stringify(send));
  const got = await poll(send.hash);
  if (got.status !== 'SUCCESS') throw new Error('tx ' + got.status + ' ' + JSON.stringify(got.resultXdr));
  return got;
}

/** Classic (non-Soroban) operation — no preflight. */
async function submitClassic(op: xdr.Operation, source = kp, signers: Keypair[] = []) {
  const acct = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '1000000', networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(300)
    .build();
  tx.sign(source, ...signers);
  const send: any = await raw('sendTransaction', { transaction: tx.toXDR() });
  if (send.status === 'ERROR') throw new Error('classic send ERROR ' + JSON.stringify(send));
  const got = await poll(send.hash);
  if (got.status !== 'SUCCESS') throw new Error('classic tx ' + got.status + ' ' + JSON.stringify(got.resultXdr));
  return got;
}

function returnedAddress(got: any): string {
  const meta = xdr.TransactionMeta.fromXDR(got.resultMetaXdr, 'base64');
  const v = meta.value() as any;
  const rv: xdr.ScVal = v.sorobanMeta().returnValue();
  return Address.fromScAddress(rv.address()).toString();
}

async function uploadAndDeploy(wasm: Buffer, salt: Buffer, ctorArgs?: xdr.ScVal[]) {
  await submit(Operation.uploadContractWasm({ wasm }));
  const wasmHash = sha256(wasm);
  const op = ctorArgs
    ? Operation.createCustomContract({
        address: Address.fromString(kp.publicKey()),
        wasmHash,
        salt,
        constructorArgs: ctorArgs,
      })
    : Operation.createCustomContract({
        address: Address.fromString(kp.publicKey()),
        wasmHash,
        salt,
      });
  const got = await submit(op);
  return returnedAddress(got);
}

const results: Record<string, any> = {};

async function main() {
  kp = Keypair.random();
  await friendbot(kp.publicKey());
  console.log('source', kp.publicKey());

  const ADD_I32 = f('add_i32.wasm');
  const CONTRACT_DATA = f('contract_data.wasm');
  const INVOKE_CONTRACT = f('invoke_contract.wasm');
  const ERR = f('err.wasm');
  const SMART = f('smart_account.wasm');

  // ---- 1. upload add_i32 -------------------------------------------------
  results.upload = await measure(Operation.uploadContractWasm({ wasm: ADD_I32 }));
  console.log('upload', results.upload);

  // ---- 2. add(2,3) -------------------------------------------------------
  const adder = await uploadAndDeploy(ADD_I32, Buffer.alloc(32, 1));
  console.log('adder', adder);
  results.add = await measure(
    Operation.invokeContractFunction({ contract: adder, function: 'add', args: [i32(2), i32(3)] }),
  );
  console.log('add', results.add);

  // ---- 3/4/5. contract_data ---------------------------------------------
  const store = await uploadAndDeploy(CONTRACT_DATA, Buffer.alloc(32, 2));
  console.log('store', store);
  const putOp = Operation.invokeContractFunction({
    contract: store,
    function: 'put_persistent',
    args: [sym('k'), u64(42n)],
  });
  results.putPersistent = await measure(putOp);
  await submit(putOp);
  results.getPersistent = await measure(
    Operation.invokeContractFunction({ contract: store, function: 'get_persistent', args: [sym('k')] }),
  );
  console.log('put', results.putPersistent, 'get', results.getPersistent);

  // large storage write: 5 KB of Bytes into a persistent entry
  results.largeWrite = await measure(
    Operation.invokeContractFunction({
      contract: store,
      function: 'replace_with_bytes_and_extend',
      args: [sym('k'), u32(5), u32(100), u32(10_000)],
    }),
  );
  console.log('largeWrite', results.largeWrite);

  // ---- 6. cross-contract -------------------------------------------------
  const A = await uploadAndDeploy(INVOKE_CONTRACT, Buffer.alloc(32, 3));
  const bHash = sha256(INVOKE_CONTRACT);
  const gotB = await submit(
    Operation.createCustomContract({
      address: Address.fromString(kp.publicKey()),
      wasmHash: bHash,
      salt: Buffer.alloc(32, 4),
    }),
  );
  const B = returnedAddress(gotB);
  console.log('A', A, 'B', B);
  results.crossContract = await measure(
    Operation.invokeContractFunction({
      contract: A,
      function: 'add_with',
      args: [i32(3), i32(4), addrV(B)],
    }),
  );
  console.log('crossContract', results.crossContract);

  // ---- 7. failing call ---------------------------------------------------
  const errC = await uploadAndDeploy(ERR, Buffer.alloc(32, 5));
  results.failing = await measure(
    Operation.invokeContractFunction({ contract: errC, function: 'err_eek', args: [] }),
  );
  console.log('failing', results.failing);

  // ---- 8. SAC transfer (native) -----------------------------------------
  const dest = Keypair.random();
  await friendbot(dest.publicKey());
  const nativeSac = Asset.native().contractId(PASS);
  try {
    await submit(Operation.createStellarAssetContract({ asset: Asset.native() }));
    console.log('deployed native SAC');
  } catch (e: any) {
    console.log('native SAC deploy skipped:', String(e.message).slice(0, 120));
  }
  results.sacTransfer = await measure(
    Operation.invokeContractFunction({
      contract: nativeSac,
      function: 'transfer',
      args: [addrV(kp.publicKey()), addrV(dest.publicKey()), i128(1000n)],
    }),
  );
  console.log('sacTransfer', results.sacTransfer, 'sac', nativeSac);

  // ---- 9. custom account __check_auth ------------------------------------
  const admin = Keypair.random();
  const adminSigner = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Ed25519'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('public_key'),
        val: xdr.ScVal.scvBytes(admin.rawPublicKey()),
      }),
    ]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
  ]);
  const sa = await uploadAndDeploy(SMART, Buffer.alloc(32, 6), [
    xdr.ScVal.scvVec([adminSigner]),
    xdr.ScVal.scvVec([]),
  ]);
  console.log('smart account', sa);

  const newSigner = Keypair.random();
  const newSignerVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Ed25519'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('public_key'),
        val: xdr.ScVal.scvBytes(newSigner.rawPublicKey()),
      }),
    ]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
  ]);
  const addSignerOp = Operation.invokeContractFunction({
    contract: sa,
    function: 'add_signer',
    args: [newSignerVal],
  });
  // recording pass, to get the auth entry
  const recording = await measure(addSignerOp);
  console.log('checkAuth recording', { ...recording, auth: recording.auth?.length });
  results.checkAuthRecording = { ...recording, auth: undefined };

  const validUntil = (await raw('getLatestLedger', {})).sequence + 100;
  const signedAuth: string[] = [];
  for (const b64 of recording.auth as string[]) {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64');
    const signed = await authorizeEntry(
      entry,
      async (_p: any, payload: Buffer) => ({
        signatureScVal: xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('Ed25519'),
                xdr.ScVal.scvBytes(admin.rawPublicKey()),
              ]),
              val: xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('Ed25519'),
                xdr.ScVal.scvBytes(admin.sign(payload)),
              ]),
            }),
          ]),
        ]),
      }),
      validUntil,
      PASS,
    );
    signedAuth.push(signed.toXDR('base64'));
  }
  const enforcingOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(sa).toScAddress(),
        functionName: 'add_signer',
        args: [newSignerVal],
      }),
    ),
    auth: signedAuth.map((b) => xdr.SorobanAuthorizationEntry.fromXDR(b, 'base64')),
  });
  results.checkAuth = await measure(enforcingOp);
  results.checkAuth.validUntil = validUntil;
  console.log('checkAuth enforcing', { ...results.checkAuth, auth: undefined });

  results._meta = { source: kp.publicKey(), sa, adder, store, A, B, errC, nativeSac };
  for (const k of Object.keys(results)) if (results[k]?.auth) delete results[k].auth;
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nwrote', OUT);
}

await main();
