/**
 * HARNESS SIDE of the differential. Same nine scenarios, same wasm bytes, same
 * arguments, run through LiteStellar/Ledger with withNetworkCostParams().
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  xdr,
  Keypair,
  Address,
  Asset,
  nativeToScVal,
  authorizeEntry,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';
import { accountIdFromPublicKey } from './src/classic.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';
import { preFundedWallet, nativeToken } from './src/fixtures.js';

const PASS = 'Standalone Network ; February 2017';
const FIX = './test/fixtures/';
const NODE_JSON =
  '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/node-results.json';

const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

/** the harness's own padding, copied from crates/host-wasm/src/lib.rs:103 */
const pad = (raw: number) => Math.max(raw + 50_000, Math.floor((raw * 104) / 100));

function run(calibrated: boolean) {
  const L = new Ledger({ networkPassphrase: PASS });
  if (calibrated) {
    L.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      P27_CPU_LIMIT,
      P27_MEM_LIMIT,
    );
  }
  const kp = Keypair.random();
  L.fund(kp.publicKey());
  const source = accountIdFromPublicKey(kp.publicKey()).toXDR('base64');

  const deploy = (code: Uint8Array, salt: number, ctor: xdr.ScVal[] = []) => {
    const h = L.seedWasm(code);
    const { sent } = L.simulateAndSend(
      createContractHostFn(source, h, Buffer.alloc(32, salt), ctor),
      source,
    );
    if (!sent.ok) throw new Error('deploy: ' + sent.error);
    return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  };

  const out: Record<string, any> = {};
  const rec = (k: string, r: any) => {
    out[k] = {
      ok: r.ok,
      error: r.error?.split('\n')[0],
      instructions: r.instructions,
      adjusted: r.adjustedInstructions,
      cpuInsns: Number(r.cpuInsns),
      memBytes: Number(r.memBytes),
      writeBytes: r.writeBytes,
      readBytes: r.readBytes,
    };
  };

  const ADD_I32 = f('add_i32.wasm');
  const CONTRACT_DATA = f('contract_data.wasm');
  const INVOKE_CONTRACT = f('invoke_contract.wasm');
  const ERR = f('err.wasm');
  const SMART = f('smart_account.wasm');

  rec('upload', L.simulate(uploadWasmHostFn(ADD_I32), source));

  const adder = deploy(ADD_I32, 1);
  rec('add', L.simulate(invokeHostFn(adder, 'add', [i32(2), i32(3)]), source));

  const store = deploy(CONTRACT_DATA, 2);
  const putFn = invokeHostFn(store, 'put_persistent', [sym('k'), u64(42n)]);
  rec('putPersistent', L.simulate(putFn, source));
  L.simulateAndSend(putFn, source);
  rec('getPersistent', L.simulate(invokeHostFn(store, 'get_persistent', [sym('k')]), source));
  rec(
    'largeWrite',
    L.simulate(
      invokeHostFn(store, 'replace_with_bytes_and_extend', [sym('k'), u32(5), u32(100), u32(10_000)]),
      source,
    ),
  );

  const A = deploy(INVOKE_CONTRACT, 3);
  const B = deploy(INVOKE_CONTRACT, 4);
  rec('crossContract', L.simulate(invokeHostFn(A, 'add_with', [i32(3), i32(4), addrV(B)]), source));

  const errC = deploy(ERR, 5);
  rec('failing', L.simulate(invokeHostFn(errC, 'err_eek', []), source));

  // SAC transfer, native XLM, account -> account
  const w = preFundedWallet(L);
  const dest = preFundedWallet(L);
  const nat = nativeToken(L, w);
  rec(
    'sacTransfer',
    L.simulate(
      invokeHostFn(nat.address, 'transfer', [addrV(w.address), addrV(dest.address), i128(1000n)]),
      w.accountIdB64,
    ),
  );

  return { L, source, out, deploy, SMART };
}

async function checkAuth(ctx: any) {
  const { L, source, out, deploy, SMART } = ctx;
  const admin = Keypair.random();
  const signerVal = (kp: Keypair) =>
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Ed25519'),
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(kp.rawPublicKey()),
        }),
      ]),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
    ]);
  const sa = deploy(SMART, 6, [xdr.ScVal.scvVec([signerVal(admin)]), xdr.ScVal.scvVec([])]);
  const newSigner = Keypair.random();
  const fn = invokeHostFn(sa, 'add_signer', [signerVal(newSigner)]);
  const recording = L.simulate(fn, source);
  const signed: string[] = [];
  for (const b64 of recording.authXdr) {
    const e = xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64');
    const s = await authorizeEntry(
      e,
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
      L.ledgerSeq + 100,
      PASS,
    );
    signed.push(s.toXDR('base64'));
  }
  const enforced = L.simulateWithAuth(fn, source, signed);
  out.checkAuthRecording = {
    ok: recording.ok,
    instructions: recording.instructions,
    adjusted: recording.adjustedInstructions,
    memBytes: Number(recording.memBytes),
  };
  out.checkAuth = {
    ok: enforced.ok,
    error: enforced.error?.split('\n')[0],
    instructions: enforced.instructions,
    adjusted: enforced.adjustedInstructions,
    memBytes: Number(enforced.memBytes),
    writeBytes: enforced.writeBytes,
  };
}

const calib = run(true);
await checkAuth(calib);
const defaults = run(false);
await checkAuth(defaults);

const node = JSON.parse(readFileSync(NODE_JSON, 'utf8'));

const rows: string[] = [];
const H = (s: string, n: number) => s.padStart(n);
rows.push(
  `${'scenario'.padEnd(20)} ${H('node(pad)', 11)} ${H('node/1.04', 11)} ${H('harness raw', 11)} ${H('harness pad', 11)} ${H('Δpad %', 8)} ${H('default raw', 11)} ${H('Δdef %', 8)}`,
);
for (const k of Object.keys(node)) {
  if (k.startsWith('_')) continue;
  const n = node[k];
  const c = calib.out[k];
  const d = defaults.out[k];
  if (!c) continue;
  if (n.error) {
    rows.push(
      `${k.padEnd(20)} ${H('rpc ERROR', 11)} ${H('-', 11)} ${H(String(c.instructions), 11)} ${H(String(c.adjusted), 11)} ${H('-', 8)} ${H(String(d.instructions), 11)} ${H('-', 8)}`,
    );
    continue;
  }
  const deadj = Math.round(n.instructions / 1.04);
  const dpad = ((c.adjusted - n.instructions) / n.instructions) * 100;
  const ddef = ((pad(d.instructions) - n.instructions) / n.instructions) * 100;
  rows.push(
    `${k.padEnd(20)} ${H(String(n.instructions), 11)} ${H(String(deadj), 11)} ${H(String(c.instructions), 11)} ${H(String(c.adjusted), 11)} ${H(dpad.toFixed(2), 8)} ${H(String(d.instructions), 11)} ${H(ddef.toFixed(1), 8)}`,
  );
}
console.log('\n' + rows.join('\n') + '\n');

console.log('write/read bytes and footprint:');
for (const k of Object.keys(node)) {
  if (k.startsWith('_') || node[k].error || !calib.out[k]) continue;
  console.log(
    `  ${k.padEnd(20)} node wb=${node[k].writeBytes} rb=${node[k].readBytes}  harness wb=${calib.out[k].writeBytes} rb=${calib.out[k].readBytes}`,
  );
}
console.log('\nmemBytes (harness only; rpc exposes none):');
for (const k of Object.keys(calib.out)) {
  console.log(`  ${k.padEnd(20)} calibrated=${calib.out[k].memBytes}  default=${defaults.out[k]?.memBytes}`);
}
writeFileSync(
  '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/harness-results.json',
  JSON.stringify({ calibrated: calib.out, defaults: defaults.out }, null, 2),
);
