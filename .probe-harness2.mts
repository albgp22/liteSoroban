/**
 * HARNESS SIDE, round 2 — the SAC/classic-account scenarios plus a genuinely
 * fresh upload (the node already had add_i32.wasm on its ledger from an earlier
 * run, which made the round-1 upload comparison unfair).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { xdr, Keypair, Asset, Address, nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from './src/index.js';
import { accountIdFromPublicKey, loadAccount, storeAccount } from './src/classic.js';
import { PROTOCOL_27_COST_PARAMS, P27_CPU_LIMIT, P27_MEM_LIMIT } from './src/cost-params.js';
import { preFundedWallet, nativeToken, deployToken, XLM } from './src/fixtures.js';

const PASS = 'Standalone Network ; February 2017';
const FIX = './test/fixtures/';
const SCRATCH = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/';
const f = (n: string) => new Uint8Array(readFileSync(FIX + n));
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addrV = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

// --- a wasm this node has certainly never seen: add_i32 + a random custom section
const UNIQUE = SCRATCH + 'unique.wasm';
if (!existsSync(UNIQUE)) {
  const base = readFileSync(FIX + 'add_i32.wasm');
  const name = Buffer.from('u');
  const payload = randomBytes(16);
  const body = Buffer.concat([Buffer.from([name.length]), name, payload]);
  writeFileSync(UNIQUE, Buffer.concat([base, Buffer.from([0, body.length]), body]));
  console.log('generated', UNIQUE);
}
const UNIQUE_WASM = new Uint8Array(readFileSync(UNIQUE));

const L = new Ledger({ networkPassphrase: PASS });
L.setCostParams(
  PROTOCOL_27_COST_PARAMS.cpuInstructions,
  PROTOCOL_27_COST_PARAMS.memoryBytes,
  P27_CPU_LIMIT,
  P27_MEM_LIMIT,
);

const payer = preFundedWallet(L);
const source = payer.accountIdB64;
const deploy = (code: Uint8Array, salt: number) => {
  const h = L.seedWasm(code);
  const { sent } = L.simulateAndSend(createContractHostFn(source, h, Buffer.alloc(32, salt)), source);
  if (!sent.ok) throw new Error('deploy: ' + sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
};

const out: Record<string, any> = {};
const rec = (k: string, r: any) => {
  out[k] = {
    ok: r.ok, error: r.error?.split('\n')[0],
    instructions: r.instructions, adjusted: r.adjustedInstructions,
    writeBytes: r.writeBytes, readBytes: r.readBytes,
    memBytes: Number(r.memBytes),
    ro: r.readOnlyKeys.length, rw: r.readWriteKeys.length,
  };
};

// fresh upload
rec('uploadUnique', L.simulate(uploadWasmHostFn(UNIQUE_WASM), source));

// deploy (of an already-seeded wasm)
const adderHash = L.seedWasm(f('add_i32.wasm'));
rec('deploy', L.simulate(createContractHostFn(source, adderHash, Buffer.alloc(32, 33)), source));

const adder = deploy(f('add_i32.wasm'), 11);

// native SAC
const dest = preFundedWallet(L);
const nat = nativeToken(L, payer);
rec('sacToAccount', L.simulate(
  invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(dest.address), i128(1000n)]), source));
rec('sacToContract', L.simulate(
  invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(adder), i128(1000n)]), source));

// non-native asset between two G accounts with trustlines
const tok = deployToken(L, { code: 'ABC' });
tok.trust(payer);
tok.trust(dest);
tok.mint(payer, 1000n);
rec('sacAssetTransfer', L.simulate(
  invokeHostFn(tok.address, 'transfer', [addrV(payer.address), addrV(dest.address), i128(100n)]), source));
rec('sacMint', L.simulate(
  invokeHostFn(tok.address, 'mint', [addrV(dest.address), i128(100n)]), tok.issuer.accountIdB64));

// contract-driven SAC transfer
const sacC = deploy(f('contract_sac_transfer.wasm'), 12);
tok.mint(sacC, 100n);
rec('contractSacTransfer', L.simulate(
  invokeHostFn(sacC, 'transfer_1', [addrV(tok.address), addrV(dest.address)]), source));

// --- hypothesis: the whole native-SAC gap is the missing AccountEntry ext chain
function extendAccountToV3(pk: string) {
  const acc = loadAccount(L, accountIdFromPublicKey(pk))!;
  const v3 = new xdr.AccountEntryExtensionV3({
    ext: new xdr.ExtensionPoint(0),
    seqLedger: L.ledgerSeq,
    seqTime: new xdr.TimePoint(xdr.Uint64.fromString(String(L.timestamp))),
  });
  const v2 = new xdr.AccountEntryExtensionV2({
    numSponsored: 0,
    numSponsoring: 0,
    signerSponsoringIDs: [],
    ext: new xdr.AccountEntryExtensionV2Ext(3, v3),
  });
  const v1 = new xdr.AccountEntryExtensionV1({
    liabilities: new xdr.Liabilities({ buying: new xdr.Int64(0), selling: new xdr.Int64(0) }),
    ext: new xdr.AccountEntryExtensionV1Ext(2, v2),
  });
  acc.ext(new xdr.AccountEntryExt(1, v1));
  storeAccount(L, acc);
}
extendAccountToV3(payer.publicKey);
extendAccountToV3(dest.publicKey);
rec('sacToAccountV3ext', L.simulate(
  invokeHostFn(nat.address, 'transfer', [addrV(payer.address), addrV(dest.address), i128(1000n)]), source));

// ---------------------------------------------------------------- comparison
const node = JSON.parse(readFileSync(SCRATCH + 'node-results2.json', 'utf8'));
/** invert stellar-rpc's max(raw+50_000, floor(raw*1.04)) */
function deadjust(padded: number): number {
  if (padded - 50_000 >= Math.floor((padded - 50_000) * 1.04) - 0) {
    // additive regime iff raw+50000 >= floor(raw*1.04)  <=>  raw <= 1_250_000
    const cand = padded - 50_000;
    if (cand <= 1_250_000) return cand;
  }
  for (let r = Math.floor(padded / 1.04) - 2; r <= Math.floor(padded / 1.04) + 2; r++) {
    if (Math.max(r + 50_000, Math.floor((r * 104) / 100)) === padded) return r;
  }
  return NaN;
}

const rows: string[] = [];
rows.push(
  `${'scenario'.padEnd(22)}${'node raw'.padStart(11)}${'harness'.padStart(11)}${'Δ'.padStart(10)}${'Δ%'.padStart(9)}   ${'node wb/rb'.padStart(12)}  ${'harness wb/rb'.padStart(13)}`,
);
for (const k of Object.keys(out)) {
  const n = node[k];
  const h = out[k];
  if (!n || n.error) {
    rows.push(`${k.padEnd(22)}${'-'.padStart(11)}${String(h.instructions).padStart(11)}`);
    continue;
  }
  const nr = deadjust(n.instructions);
  const d = h.instructions - nr;
  rows.push(
    `${k.padEnd(22)}${String(nr).padStart(11)}${String(h.instructions).padStart(11)}${String(d).padStart(10)}${((d / nr) * 100).toFixed(2).padStart(9)}   ${`${n.writeBytes}/${n.diskReadBytes}`.padStart(12)}  ${`${h.writeBytes}/${h.readBytes}`.padStart(13)}`,
  );
}
console.log('\n' + rows.join('\n') + '\n');
writeFileSync(SCRATCH + 'harness-results2.json', JSON.stringify(out, null, 2));
