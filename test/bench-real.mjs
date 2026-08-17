// THROWAWAY: how does the in-process host behave on a REAL contract?
// Target: Crossmint/stellar-smart-account (testdata/smart_account_v1.wasm, 32 KB),
// a custom account with __check_auth, ed25519/secp256r1/webauthn signers,
// multisig and plugin policies. Compared against a 3.8 KB toy.
//
//   node test/bench-real.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { xdr, nativeToScVal, scValToNative, Keypair } from '@stellar/stellar-sdk';

const require = createRequire(import.meta.url);
const wasm = require('../pkg/soroban_host.js');

const f = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const SMART = new Uint8Array(readFileSync(f('smart_account.wasm')));
const TOY = new Uint8Array(readFileSync(f('contract_data.wasm')));

const sv = (b64) => xdr.ScVal.fromXDR(b64, 'base64');
const sym = (s) => nativeToScVal(s, { type: 'symbol' });

function uploadFn(code) {
  return xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from(code)).toXDR('base64');
}
function createFn(deployerB64, hashB64, args = [], salt = Buffer.alloc(32)) {
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.fromXDR(deployerB64, 'base64')),
          salt,
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hashB64, 'base64')),
      constructorArgs: args,
    }),
  ).toXDR('base64');
}
function invokeFn(addr, fn, args = []) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: addr, functionName: fn, args }),
  ).toXDR('base64');
}

/** Signer::Ed25519(Ed25519Signer { public_key }, SignerRole::Admin) */
function adminSigner(pubkey32) {
  const ed25519Signer = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('public_key'), val: xdr.ScVal.scvBytes(Buffer.from(pubkey32)) }),
  ]);
  const roleAdmin = xdr.ScVal.scvVec([sym('Admin')]);
  return xdr.ScVal.scvVec([sym('Ed25519'), ed25519Signer, roleAdmin]);
}

const apply = (env, src, fnB64) => {
  const sim = env.simulate(fnB64, src);
  if (!sim.ok) throw new Error(`simulate failed: ${sim.error}`);
  const sent = env.send(
    fnB64, src, sim.resourcesXdr, sim.authXdr,
    Uint32Array.from(sim.restoredRwEntryIndices),
  );
  if (!sent.ok) throw new Error(`send failed: ${sent.error}`);
  return { sim, sent };
};

const time = (label, n, fn) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(52)} ${(ms / n).toFixed(3)} ms  (n=${n})`);
  return ms / n;
};

console.log(`node ${process.version} | host protocol ${wasm.hostProtocolVersion()}`);
console.log(`smart_account.wasm ${SMART.length} bytes   toy ${TOY.length} bytes\n`);

const kp = Keypair.random();
const rawPk = kp.rawPublicKey();

function freshEnv() {
  const env = new wasm.SorobanEnv(27, 1_000_000);
  const src = env.fundAccount(1);
  return { env, src };
}

// ---- upload: the size-dependent step (real wasm parse + validation) --------
console.log('UPLOAD (host parses and validates the module)');
time('upload 3.8 KB toy', 30, () => {
  const { env, src } = freshEnv();
  apply(env, src, uploadFn(TOY));
});
time('upload 32 KB smart account', 30, () => {
  const { env, src } = freshEnv();
  apply(env, src, uploadFn(SMART));
});

// ---- deploy: instantiates the module and runs __constructor ---------------
console.log('\nDEPLOY (CreateContractV2, runs __constructor)');
function deploySmart() {
  const { env, src } = freshEnv();
  const hash = env.seedWasm(SMART);
  const { sent } = apply(
    env, src,
    createFn(src, hash, [xdr.ScVal.scvVec([adminSigner(rawPk)]), xdr.ScVal.scvVec([])]),
  );
  return { env, src, addr: sv(sent.returnValueXdr).address() };
}
time('deploy smart account + run __constructor', 50, () => deploySmart());

const { env, src, addr } = deploySmart();
console.log(`  deployed OK -> ${addr.switch().name}`);

// ---- invoke ---------------------------------------------------------------
console.log('\nINVOKE (real contract methods)');
const isDeployed = invokeFn(addr, 'is_deployed');
time('simulate is_deployed()', 200, () => env.simulate(isDeployed, src));

const signerKey = xdr.ScVal.scvVec([sym('Ed25519'), xdr.ScVal.scvBytes(Buffer.from(rawPk))]);
const hasSigner = invokeFn(addr, 'has_signer', [signerKey]);
const hs = env.simulate(hasSigner, src);
console.log(`  has_signer(admin) -> ${hs.ok ? scValToNative(sv(hs.returnValueXdr)) : 'ERR ' + hs.error}`);
time('simulate has_signer()', 200, () => env.simulate(hasSigner, src));

// add_signer goes through the smart account's own __check_auth. Recording mode
// RECORDS auth without running __check_auth, so it succeeds; the enforcing path
// actually calls __check_auth and rejects the placeholder credential. That gap
// is real Soroban behaviour and is exactly what a mocked RPC can never surface:
// your app can simulate green and still fail on submit.
const addFn = invokeFn(addr, 'add_signer', [adminSigner(Keypair.random().rawPublicKey())]);
const addSim = env.simulate(addFn, src);
console.log(`  add_signer simulate (records auth, does NOT run __check_auth) -> ok=${addSim.ok}`);
console.log(`  recorded auth entries: ${addSim.authXdr.length}`);
if (addSim.authXdr.length) {
  const cred = xdr.SorobanAuthorizationEntry.fromXDR(addSim.authXdr[0], 'base64').credentials();
  console.log(`  credential type: ${cred.switch().name}`);
}
time('simulate add_signer() (auth recording)', 100, () => env.simulate(addFn, src));

try {
  const e = deploySmart();
  apply(e.env, e.src, invokeFn(e.addr, 'add_signer', [adminSigner(Keypair.random().rawPublicKey())]));
  console.log('  send add_signer -> unexpectedly succeeded without a signed auth entry');
} catch (err) {
  const line = String(err.message).split('\n')[0];
  console.log(`  send add_signer -> correctly rejected: ${line}`);
  console.log('    (the host RAN __check_auth and trapped on the unsigned payload —');
  console.log('     signing the auth entry is the client-side logic under test)');
}

// ---- resources ------------------------------------------------------------
console.log('\nRESOURCES (what you can assert on)');
const d = env.simulate(isDeployed, src);
console.log(`  is_deployed: instructions=${d.instructions} readBytes=${d.readBytes} writeBytes=${d.writeBytes}`);
console.log(`  footprint:   ${d.readOnlyKeys.length} read-only, ${d.readWriteKeys.length} read-write`);
console.log(`  cpuInsns=${d.cpuInsns} memBytes=${d.memBytes}`);

console.log('\nISOLATION');
time('fresh ledger with deployed smart account', 100, () => deploySmart());
