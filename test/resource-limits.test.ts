/**
 * The network's Soroban resource limits, against a real node.
 *
 * Rules (stellar-core v29.0.0, read at the tag):
 * - Submission: TransactionFrame::checkSorobanResources (TransactionFrame.cpp
 *   :778-994), called from commonValidPreSeqNum right after the memo check
 *   (:1360): instructions, disk read bytes, write bytes, footprint entries,
 *   disk read entries (getNumDiskReadEntries, :67), write entries, each
 *   footprint key's type and size, the (inner) envelope's size, and the
 *   archived-entry indexes, in that order -> txSOROBAN_INVALID.
 * - Apply: validateContractLedgerEntry (TransactionUtils.cpp:2007) on every
 *   entry an InvokeHostFunction reads (InvokeHostFunctionOpFrame.cpp:614,
 *   :1191) or writes (:785), an ExtendFootprintTTL extends
 *   (ExtendFootprintTTLOpFrame.cpp:165) or a RestoreFootprint restores
 *   (RestoreFootprintOpFrame.cpp:214); and the DECLARED diskReadBytes /
 *   writeBytes (InvokeHostFunctionOpFrame.cpp:368, :805;
 *   RestoreFootprintOpFrame.cpp:199, :223) -> *_RESOURCE_LIMIT_EXCEEDED.
 * - The host's budget: an applied invocation runs under its DECLARED
 *   instructions and txMemoryLimit (InvokeHostFunctionOpFrame.cpp:51, :690;
 *   rust bridge soroban_proto_any.rs:446 Budget::try_from_configs), and fails
 *   RESOURCE_LIMIT_EXCEEDED past either, with core's own diagnostic after the
 *   host's (:737-753). stellar-rpc 29.0.1's preflight simulates under
 *   txMaxInstructions and txMemoryLimit
 *   (preflight/src/shared.rs:134 NetworkConfig::load_from_snapshot ->
 *   soroban-simulation simulation.rs:133 -> network_config.rs:152-166, the same
 *   in 29.0.1 and 29.0.2). Both come from ContractComputeV0.
 *
 * Every code, diagnostic and fee pinned here was first observed on a local
 * stellar/quickstart (stellar-core 29.0.0, stellar-rpc 29.0.1, protocol 29) on
 * 2026-10-18 by the same scenario through rpc.Server (.probe-live-limits.mts):
 * submission and invocation cases on the node whose settings QUICKSTART holds,
 * restore and oversized-entry cases on a private one started with testnet's
 * limits but minPersistentTTL 20, then upgraded to contractDataEntrySizeBytes
 * 2,000. The host-budget cases ran on the shared node through
 * .probe-live-ceiling.mts and .probe-live-insns.mts, and on a private one
 * upgraded to txMemoryLimit 2,000,000 through .probe-live-mem.mts. Core puts
 * the values in its diagnostic's arguments; `detail` writes them
 * `value > limit`. Successful calls are not compared on fees here: their rent
 * follows the state-archival TTLs, which are not yet the node's.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Address,
  Asset,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import { LiteStellar, PROTOCOL_27_COST_PARAMS, TESTNET_FEE_SETTINGS } from '../src/litestellar.js';
import { invokeHostFn } from '../src/index.js';
import { QUICKSTART } from './quickstart-settings.js';

const PASS = 'Standalone Network ; February 2017';
const fixture = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)));
/** The probe's custom section ("lsx" + 16 tag bytes): same size, same metering. */
const unique = (w: Buffer) => Buffer.concat([w, Buffer.from([0, 20, 3]), Buffer.from('lsx'), Buffer.alloc(16, 7)]);
const DATA = unique(fixture('contract_data.wasm'));
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });

const leb = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
/** `w` plus one custom section, `total` bytes in all. */
function padded(w: Buffer, total: number): Buffer {
  for (let r = total - w.length - 6; r >= 0; r--) {
    const len = 4 + r;
    if (w.length + 1 + leb(len).length + len === total) {
      return Buffer.concat([w, Buffer.from([0]), leb(len), Buffer.from([3]), Buffer.from('lsx'), Buffer.alloc(r, 9)]);
    }
  }
  throw new Error('cannot pad');
}

let svm: LiteStellar;
let S: rpc.Server;
let a: Keypair;
let store: string;

const balance = (k: Keypair) => BigInt(svm.getAccount(k.publicKey())!.balance.toString());
const fund = () => {
  const k = Keypair.random();
  svm.ledger.fund(k.publicKey(), { balance: 10_000n * 10_000_000n });
  return k;
};

async function prepared(op: xdr.Operation, data?: xdr.SorobanTransactionData) {
  const b = new TransactionBuilder(await S.getAccount(a.publicKey()), { fee: '100', networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(300);
  if (data) b.setSorobanData(data);
  const raw = b.build();
  const sim = await S.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`simulation failed: ${(sim as any).error}`);
  return rpc.assembleTransaction(raw, sim).build();
}

/** The same operation with its SorobanTransactionData replaced; build() adds the resource fee. */
async function withData(op: xdr.Operation, data: xdr.SorobanTransactionData) {
  return new TransactionBuilder(await S.getAccount(a.publicKey()), { fee: '100', networkPassphrase: PASS })
    .addOperation(op)
    .setSorobanData(data)
    .setTimeout(300)
    .build();
}

const sorobanData = (tx: Transaction) =>
  xdr.expectUnionVariant(xdr.expectUnionVariant(tx.toEnvelope(), 'envelopeTypeTx').v1.tx.ext, 'sorobanData').sorobanData;
/** `d` with some of its resources replaced: XDR values are read-only. */
const withResources = (d: xdr.SorobanTransactionData, r: Partial<xdr.SorobanResources>) =>
  new xdr.SorobanTransactionData({ ...d, resources: new xdr.SorobanResources({ ...d.resources, ...r }) });

/** Through the classic layer, for the outcome's diagnostic. */
function submit(tx: Transaction | FeeBumpTransaction, payer = a) {
  tx.sign(payer);
  const before = balance(payer);
  const out = svm.sendTransaction(tx.toXdr());
  return { ...out, debited: before - balance(payer) };
}

/** The getTransaction response `run` last polled. */
let polled: any;

/** Through rpc.Server, as an app sees it. */
async function run(tx: Transaction, payer = a) {
  tx.sign(payer);
  const before = balance(payer);
  polled = undefined;
  const sent = await S.sendTransaction(tx);
  if (sent.status === 'ERROR') return { status: `ERROR ${sent.errorResult!.result.type}`, op: '', fee: 0n, debited: 0n };
  const got: any = (polled = await S.pollTransaction(sent.hash));
  const result: xdr.TransactionResult = got.resultXdr;
  return {
    status: got.status as string,
    op: (result.result as any).results[0].tr.value.type as string,
    fee: BigInt(result.feeCharged.toString()),
    debited: before - balance(payer),
  };
}

async function deploy(wasm: Buffer, salt = Buffer.alloc(32, 1)): Promise<string> {
  expect((await run(await prepared(Operation.uploadContractWasm({ wasm })))).status).toBe('SUCCESS');
  const create = await prepared(
    Operation.createCustomContract({ address: new Address(a.publicKey()), wasmHash: hash(wasm), salt }),
  );
  const out = submit(create);
  expect(out.code).toBe('txSUCCESS');
  return Address.fromScVal(xdr.ScVal.fromXdr(out.returnValueXdr!, 'base64')).toString();
}

const dataKey = (k: xdr.ScVal, durability: 'persistent' | 'temporary' = 'persistent') =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(store).toScAddress(),
      key: k,
      durability: xdr.ContractDataDurability[durability],
    }),
  );
const firstTopic = (d: xdr.DiagnosticEvent) =>
  xdr.expectUnionVariant(xdr.expectUnionVariant(d.event.body, 'v0').v0.topics[0], 'scvSymbol').sym.toString();
/**
 * A diagnostic as core's DiagnosticEventManager::pushError builds it (topics
 * `["error", Error(type, code)]`, data `[message, ...u64]`), as
 * [type, code, message, ...values].
 */
const coreError = (d: xdr.DiagnosticEvent) => {
  const body = xdr.expectUnionVariant(d.event.body, 'v0').v0;
  const err = xdr.expectUnionVariant(body.topics[1], 'scvError').error;
  const [message, ...args] = xdr.expectUnionVariant(body.data, 'scvVec').vec!;
  return [
    err.type,
    xdr.expectUnionVariant(err, 'sceBudget').code.name,
    xdr.expectUnionVariant(message, 'scvString').str.toString(),
    ...args.map((v) => xdr.expectUnionVariant(v, 'scvU64').u64),
  ];
};
const accountKey = (k: Keypair) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: k.xdrAccountId() }));
const call = (fn: string, args: xdr.ScVal[]) => Operation.invokeContractFunction({ contract: store, function: fn, args });
const put = (k: string) => call('put_persistent', [sym(k), u64(1n)]);

beforeEach(async () => {
  svm = new LiteStellar({ networkPassphrase: PASS }).withFeeSettings(QUICKSTART);
  S = svm.rpcServer();
  a = fund();
  store = await deploy(DATA);
});

describe('submission: checkSorobanResources -> txSOROBAN_INVALID', () => {
  type Fp = xdr.SorobanTransactionData;
  const res = (d: Fp) => d.resources;
  const footprint = (d: Fp, f: Partial<xdr.LedgerFootprint>) =>
    withResources(d, { footprint: new xdr.LedgerFootprint({ ...res(d).footprint, ...f }) });
  const addRo = (d: Fp, keys: xdr.LedgerKey[]) => footprint(d, { readOnly: [...res(d).footprint.readOnly, ...keys] });
  const addRw = (d: Fp, keys: xdr.LedgerKey[]) => footprint(d, { readWrite: [...res(d).footprint.readWrite, ...keys] });
  const junk = (n: number) => Array.from({ length: n }, (_, i) => dataKey(sym(`j${i}`)));
  const accounts = (n: number) => Array.from({ length: n }, () => accountKey(Keypair.random()));
  const bytesKey = (n: number) => dataKey(nativeToScVal(Buffer.alloc(n, 1)));
  const trustline = (asset: xdr.TrustLineAsset) =>
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: a.xdrAccountId(), asset }));
  const archived = (indexes: number[]) => (d: Fp) =>
    new xdr.SorobanTransactionData({
      ...d,
      ext: xdr.SorobanTransactionDataExt.resourceExt(new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: indexes })),
    });

  /** A simulated put_persistent with its SorobanTransactionData edited. Its footprint is
   * 3 entries: the instance and the code read-only, the key read-write. */
  async function edited(edit: (d: Fp) => Fp, enoughFee = false) {
    const op = put('k');
    let d = edit(sorobanData(await prepared(op)));
    if (enoughFee) {
      d = new xdr.SorobanTransactionData({ ...d, resourceFee: 50_000_000n });
      if (res(d).instructions < 100_000_000) d = withResources(d, { instructions: 100_000_000 });
    }
    return withData(op, d);
  }

  const over: [string, (d: Fp) => Fp, string][] = [
    ['instructions', (d) => withResources(d, { instructions: 400_000_001 }),
      'transaction instructions resources exceed network config limit: 400000001 > 400000000'],
    ['disk read bytes', (d) => withResources(d, { diskReadBytes: 200_001 }),
      'transaction byte-read resources exceed network config limit: 200001 > 200000'],
    ['write bytes', (d) => withResources(d, { writeBytes: 132_097 }),
      'transaction byte-write resources exceed network config limit: 132097 > 132096'],
    ['instructions and disk read bytes: the first check wins', (d) =>
      withResources(d, { instructions: 400_000_001, diskReadBytes: 200_001 }),
      'transaction instructions resources exceed network config limit: 400000001 > 400000000'],
    ['footprint entries', (d) => addRo(d, junk(398)),
      'the number of entries in transaction footprint exceeds the network config limit: 401 > 400'],
    ['disk read entries (classic keys)', (d) => addRo(d, accounts(201)),
      'transaction entry-disk-read resources exceed network config limit: 201 > 200'],
    ['write entries', (d) => addRw(d, junk(200)),
      'transaction entry-write resources exceed network config limit: 201 > 200'],
    ['a 252-byte key', (d) => addRo(d, [bytesKey(200)]),
      'transaction footprint key exceeds network config limit: 252 > 250'],
    ['a TTL key', (d) => addRo(d, [xdr.LedgerKey.ttl(new xdr.LedgerKeyTtl({ keyHash: hash(Buffer.from('x')) }))]),
      'transaction footprint contains unsupported ledger key type: 9'],
    ['a native trustline', (d) => addRo(d, [trustline(xdr.TrustLineAsset.assetTypeNative())]),
      'transaction footprint contains invalid trustline asset'],
    ["the issuer's own trustline", (d) => addRo(d, [trustline(new Asset('USD', a.publicKey()).toTrustLineXdrObject())]),
      'transaction footprint contains invalid trustline asset'],
    ['an asset code with a zero in the middle', (d) => addRo(d, [trustline(
      xdr.TrustLineAsset.assetTypeCreditAlphanum4(
        new xdr.AlphaNum4({ assetCode: Buffer.from([0x55, 0, 0x53, 0]), issuer: Keypair.random().xdrAccountId() }),
      ),
    )]), 'transaction footprint contains invalid trustline asset'],
    ['archived indexes out of order', (d) => archived([0, 0])(addRw(d, junk(1))),
      'archivedSorobanEntries must be sorted in ascending order'],
    ['an archived index past the read-write footprint', archived([5]),
      'archivedSorobanEntries index is out of bounds: 5 >= 1'],
    ['an archived index on a temporary key', (d) =>
      archived([0])(footprint(d, { readWrite: [dataKey(sym('t'), 'temporary'), ...res(d).footprint.readWrite] })),
      'archivedSorobanEntries index points to a non-persistent entry: 0, key type 6'],
  ];

  it.each(over)('over the limit: %s', async (_, edit, detail) => {
    const tx = await edited(edit);
    const out = submit(tx);
    expect([out.code, out.rejected, out.detail]).toEqual(['txSOROBAN_INVALID', true, detail]);
    // Nothing moves; the result reports the declared resource fee + baseFee.
    const declared = BigInt(sorobanData(tx).resourceFee.toString());
    expect([out.debited, out.feeCharged]).toEqual([0n, declared + 100n]);
  });

  it('every limit is inclusive: a transaction AT each one is accepted and applies', async () => {
    const at: ((d: Fp) => Fp)[] = [
      (d) => withResources(d, { instructions: 400_000_000 }),
      (d) => addRo(d, junk(397)),
      (d) => addRo(d, accounts(200)),
      (d) => addRw(d, junk(199)),
      (d) => addRo(d, [bytesKey(196)]), // a 248-byte key
    ];
    for (const edit of at) {
      const out = submit(await edited(edit, true));
      expect([out.code, out.detail]).toEqual(['txSUCCESS', undefined]);
    }
  });

  it("caps the envelope at txMaxSizeBytes; a fee bump's own bytes do not count", async () => {
    const wasm = padded(fixture('add_i32.wasm'), 132_096);
    const op = Operation.uploadContractWasm({ wasm });
    const data = new SorobanDataBuilder()
      .setReadWrite([xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(wasm) }))])
      .setResources(100_000_000, 0, 132_096)
      .setResourceFee(50_000_000)
      .build();
    const out = submit(await withData(op, data));
    expect([out.code, out.detail, out.feeCharged, out.debited]).toEqual([
      'txSOROBAN_INVALID',
      'total transaction size exceeds network config limit: 132344 > 132096',
      50_000_100n,
      0n,
    ]);
  });

  it('judges a fee bump by its inner transaction', async () => {
    const op = put('fb');
    const d = withResources(sorobanData(await prepared(op)), { instructions: 400_000_001 });
    const inner = await withData(op, d);
    inner.sign(a);
    const f = fund();
    const out = submit(TransactionBuilder.buildFeeBumpTransaction(f, '500', inner, PASS), f);
    expect([out.code, out.innerCode, out.detail, out.debited]).toEqual([
      'txFEE_BUMP_INNER_FAILED',
      'txSOROBAN_INVALID',
      'transaction instructions resources exceed network config limit: 400000001 > 400000000',
      0n,
    ]);
  });

  it("enforces the installed network's limits, whether or not fees are charged", async () => {
    const tx = await prepared(put('k'));
    const declared = res(sorobanData(tx)).instructions;
    svm.withFeeSettings({ ...QUICKSTART, txMaxInstructions: declared - 1 }).withFeeCharging(false);
    expect(submit(tx).detail).toBe(
      `transaction instructions resources exceed network config limit: ${declared} > ${declared - 1}`,
    );
  });
});

describe('apply: InvokeHostFunction -> INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED', () => {
  const bytes = (k: string, kb: number) => call('replace_with_bytes_and_extend', [sym(k), u32(kb), u32(10), u32(1000)]);
  const stored = async (k: xdr.LedgerKey) => (await S.getLedgerEntries(k)).entries.length;

  it('writes no ContractData entry above contractDataEntrySizeBytes', async () => {
    expect(await run(await prepared(bytes('b63', 63)))).toMatchObject({ status: 'SUCCESS' });
    // 64 KB of bytes is a 65,612-byte entry. The node simulates it, then fails it.
    expect(await run(await prepared(bytes('b64', 64)))).toEqual({
      status: 'FAILED', op: 'invokeHostFunctionResourceLimitExceeded', fee: 62_742n, debited: 62_742n,
    });
    expect(await stored(dataKey(sym('b64')))).toBe(0);
    expect(submit(await prepared(bytes('b64', 64))).error).toBe(
      'ContractData size exceeds network config maximum size: 65612 > 65536',
    );
  });

  it('stores no contract code above contractMaxSizeBytes', async () => {
    const big = padded(fixture('add_i32.wasm'), 131_072); // a 131,172-byte entry
    expect(await run(await prepared(Operation.uploadContractWasm({ wasm: big })))).toEqual({
      status: 'FAILED', op: 'invokeHostFunctionResourceLimitExceeded', fee: 766_378n, debited: 766_378n,
    });
    expect(await stored(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(big) })))).toBe(0);
    const fits = padded(fixture('add_i32.wasm'), 130_872);
    expect(await run(await prepared(Operation.uploadContractWasm({ wasm: fits })))).toMatchObject({ status: 'SUCCESS' });
  });

  it('writes no more bytes than the transaction declares', async () => {
    const op = put('w');
    const d0 = sorobanData(await prepared(op));
    const d = withResources(d0, { writeBytes: d0.resources.writeBytes - 1 });
    expect(await run(await withData(op, d))).toEqual({
      status: 'FAILED', op: 'invokeHostFunctionResourceLimitExceeded', fee: 6_067n, debited: 6_067n,
    });
    expect(await stored(dataKey(sym('w')))).toBe(0);
    expect(submit(await withData(op, d)).error).toBe('operation byte-write resources exceeds amount specified: 80 > 79');
  });

  it('reads no more classic bytes than the transaction declares', async () => {
    expect(submit(await prepared(Operation.createStellarAssetContract({ asset: Asset.native() }))).code).toBe('txSUCCESS');
    const op = Operation.invokeContractFunction({
      contract: Asset.native().contractId(PASS),
      function: 'balance',
      args: [new Address(a.publicKey()).toScVal()],
    });
    const d0 = sorobanData(await prepared(op));
    const d = withResources(d0, { diskReadBytes: d0.resources.diskReadBytes - 1 });
    const out = submit(await withData(op, d));
    expect([out.code, out.invokeResult, out.error]).toEqual([
      'txFAILED',
      'invokeHostFunctionResourceLimitExceeded',
      'operation byte-read resources exceeds amount specified: 144 > 143',
    ]);
  });

  it.each([
    ['enforceDeclaredBytes(false)', () => svm.ledger.enforceDeclaredBytes(false)],
    ['enforceDeclaredResources(false)', () => svm.ledger.enforceDeclaredResources(false)],
  ])('%s lifts the declared bytes, never the network limits', async (_, lift) => {
    lift();
    const op = put('w');
    const d = withResources(sorobanData(await prepared(op)), { writeBytes: 0 });
    expect(submit(await withData(op, d)).code).toBe('txSUCCESS');
    expect(submit(await prepared(bytes('b64', 64))).invokeResult).toBe('invokeHostFunctionResourceLimitExceeded');
  });
});

describe('apply: ExtendFootprintTTL / RestoreFootprint', () => {
  const restoreOp = Operation.restoreFootprint({});
  const archive = () => svm.ledger.advanceLedgers(svm.ledger.archivalSettings.minPersistentTtl + 1);
  /** A restore of `k` as simulated, with its declared bytes edited. */
  async function restore(k: string, edit: Partial<xdr.SorobanResources> = {}) {
    const d = sorobanData(await prepared(restoreOp, new SorobanDataBuilder().setReadWrite([dataKey(sym(k))]).build()));
    return withData(restoreOp, withResources(d, edit));
  }
  const ttl = (k: string) => svm.ledger.getEntryTtl(dataKey(sym(k)).toXdr('base64'));
  const keepContractAlive = async () => {
    expect((await run(await prepared(call('extend_instance', [u32(1_000_000), u32(1_000_000)]))))).toMatchObject({ status: 'SUCCESS' });
    const instance = (await S.getLedgerEntries(dataKey(xdr.ScVal.scvLedgerKeyContractInstance()))).entries[0];
    const code = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({
        hash: xdr.expectUnionVariant(
          xdr.expectUnionVariant(xdr.expectUnionVariant(instance.val, 'contractData').contractData.val, 'scvContractInstance')
            .instance.executable,
          'contractExecutableWasm',
        ).wasmHash,
      }),
    );
    const extend = await prepared(Operation.extendFootprintTtl({ extendTo: 1_000_000 }), new SorobanDataBuilder().setReadOnly([code]).build());
    expect(await run(extend)).toMatchObject({ status: 'SUCCESS' });
  };

  it('restores no more bytes than declared: read first, then write', async () => {
    await keepContractAlive();
    for (const k of ['r1', 'r2', 'r3', 'r4']) expect(await run(await prepared(put(k)))).toMatchObject({ status: 'SUCCESS' });
    archive();
    const cases: [string, Partial<xdr.SorobanResources>, bigint, string][] = [
      ['r1', { diskReadBytes: 79 }, 6_591n, 'operation byte-read resources exceeds amount specified: 80 > 79'],
      ['r2', { writeBytes: 79 }, 6_590n, 'operation byte-write resources exceeds amount specified: 80 > 79'],
      ['r3', { diskReadBytes: 0, writeBytes: 0 }, 6_487n, 'operation byte-read resources exceeds amount specified: 80 > 0'],
    ];
    for (const [k, edit, fee, detail] of cases) {
      const before = ttl(k);
      expect(await run(await restore(k, edit))).toEqual({
        status: 'FAILED', op: 'restoreFootprintResourceLimitExceeded', fee, debited: fee,
      });
      expect(ttl(k)).toBe(before); // still archived
      expect(submit(await restore(k, edit)).detail).toBe(detail);
    }
    expect(await run(await restore('r4'))).toMatchObject({ status: 'SUCCESS', op: 'restoreFootprintSuccess' });
  });

  it('touches no entry above the size limit: extend, read, restore', async () => {
    await keepContractAlive();
    const big = (k: string, threshold: number, extendTo: number) =>
      call('replace_with_bytes_and_extend', [sym(k), u32(3), u32(threshold), u32(extendTo)]);
    expect(await run(await prepared(big('big', 1_000_000, 1_000_000)))).toMatchObject({ status: 'SUCCESS' }); // live
    expect(await run(await prepared(big('big2', 1, 2)))).toMatchObject({ status: 'SUCCESS' }); // to archive
    archive();
    // The network lowers contractDataEntrySizeBytes under both 3,148-byte entries.
    svm.withFeeSettings({ ...QUICKSTART, maxContractDataEntrySizeBytes: 2000 });
    const detail = 'ContractData size exceeds network config maximum size: 3148 > 2000';

    const extendOp = Operation.extendFootprintTtl({ extendTo: 2_000_000 });
    const extendData = () => new SorobanDataBuilder().setReadOnly([dataKey(sym('big'))]).setResourceFee(5_000_000).build();
    const before = ttl('big');
    expect(await run(await withData(extendOp, extendData()))).toEqual({
      status: 'FAILED', op: 'extendFootprintTtlResourceLimitExceeded', fee: 2_441n, debited: 2_441n,
    });
    expect(ttl('big')).toBe(before);
    expect(submit(await withData(extendOp, extendData())).detail).toBe(detail);

    // Simulation does not check entry sizes; the node fails it at apply.
    const read = call('has_persistent', [sym('big')]);
    expect(await run(await prepared(read))).toEqual({
      status: 'FAILED', op: 'invokeHostFunctionResourceLimitExceeded', fee: 3_442n, debited: 3_442n,
    });
    expect(submit(await prepared(read)).error).toBe(detail);

    expect(await run(await restore('big2'))).toEqual({
      status: 'FAILED', op: 'restoreFootprintResourceLimitExceeded', fee: 10_552n, debited: 10_552n,
    });
    expect(submit(await restore('big2')).detail).toBe(detail);
  });
});

describe("the host's budget: txMaxInstructions and txMemoryLimit", () => {
  const LOADGEN = fixture('loadgen.wasm');
  /** ~41.6 instructions a guest cycle: 3M cycles need ~120M, 9.4M ~376M. */
  const work = (contract: string, cycles: number) =>
    Operation.invokeContractFunction({ contract, function: 'do_cpu_only_work', args: [u32(cycles), u32(0), u32(0)] });
  const declared = (tx: Transaction) => sorobanData(tx).resources.instructions;
  const stored = async (k: xdr.LedgerKey) => (await S.getLedgerEntries(k)).entries.length;
  const simError = async (op: xdr.Operation) => {
    const raw = new TransactionBuilder(await S.getAccount(a.publicKey()), { fee: '100', networkPassphrase: PASS })
      .addOperation(op)
      .setTimeout(300)
      .build();
    const sim = await S.simulateTransaction(raw);
    return rpc.Api.isSimulationError(sim) ? sim.error : 'simulated';
  };

  it('with default settings, simulates and applies what the node does between 100M and 400M', async () => {
    svm = new LiteStellar({ networkPassphrase: PASS });
    S = svm.rpcServer();
    a = fund();
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    // The node's own counts (stellar-rpc 29.0.1, txMaxInstructions 400M): the
    // host's default 100M ceiling used to fail all three in simulation.
    for (const [op, instructions] of [
      [work(loadgen, 3_000_000), 125_134_205],
      [work(loadgen, 9_400_000), 391_374_205],
      [Operation.uploadContractWasm({ wasm: padded(fixture('add_i32.wasm'), 130_872) }), 111_117_272],
    ] as const) {
      const tx = await prepared(op);
      expect(declared(tx)).toBe(instructions);
      expect(await run(tx)).toMatchObject({ status: 'SUCCESS', op: 'invokeHostFunctionSuccess' });
    }
  });

  it('charges for them what the node charges', async () => {
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    expect(await run(await prepared(work(loadgen, 3_000_000)))).toEqual({
      status: 'SUCCESS', op: 'invokeHostFunctionSuccess', fee: 90_700n, debited: 90_700n,
    });
    expect(await run(await prepared(work(loadgen, 9_400_000)))).toEqual({
      status: 'SUCCESS', op: 'invokeHostFunctionSuccess', fee: 277_068n, debited: 277_068n,
    });
    const upload = Operation.uploadContractWasm({ wasm: padded(fixture('add_i32.wasm'), 130_872) });
    expect(await run(await prepared(upload))).toEqual({
      status: 'SUCCESS', op: 'invokeHostFunctionSuccess', fee: 14_484_392n, debited: 14_484_392n,
    });
  });

  it('simulates up to txMaxInstructions: past it, padded or not, the call is refused', async () => {
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    // ~388M raw simulates; stellar-rpc's padding (x1.04) then declares more than
    // the network allows, and the node refuses it at submission.
    const padded404 = await prepared(work(loadgen, 9_700_000));
    expect(declared(padded404)).toBe(403_854_205);
    expect(submit(padded404)).toMatchObject({
      code: 'txSOROBAN_INVALID',
      detail: 'transaction instructions resources exceed network config limit: 403854205 > 400000000',
      feeCharged: 295_439n,
      debited: 0n,
    });
    // ~437M does not fit the simulation's budget at all, as on the node.
    expect(await simError(work(loadgen, 10_500_000))).toContain('Error(Budget, ExceededLimit)');
  });

  it('stops an applied call at its declared instructions: a guest out of fuel is a trap', async () => {
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    const op = work(loadgen, 3_000_000);
    const d = withResources(sorobanData(await prepared(op)), { instructions: 100_000_000 });
    // The node: "VM call trapped: OutOfFuel". The guest runs on fuel drawn from
    // what the budget has left, so it stops AT the declared count and no charge
    // passes it: InvokeHostFunctionOpFrame.cpp:737 does not fire.
    expect(await run(await withData(op, d))).toEqual({
      status: 'FAILED', op: 'invokeHostFunctionTrapped', fee: 72_930n, debited: 72_930n,
    });
  });

  it("stops a host charge past the declared instructions, and says so in core's own diagnostic", async () => {
    // The shared node, settings untouched (.probe-live-insns.mts): loadgen's
    // host cycles are u256_add host calls, so a HOST charge, not guest fuel,
    // passes the declared count. Core then fails the operation and pushes
    // ["operation instructions exceeds amount specified", consumed, declared]
    // after the host's events (InvokeHostFunctionOpFrame.cpp:737-745); its
    // getTransaction serves the meta's list as diagnosticEventsXdr. The node's
    // list also has the rust bridge's host_fn_failed just before core's event
    // (soroban_proto_any.rs:537) and 19 core_metrics after it; the harness
    // emits neither.
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    const op = Operation.invokeContractFunction({
      contract: loadgen, function: 'do_cpu_only_work', args: [u32(0), u32(5_000), u32(0)],
    });
    const full = await prepared(op);
    expect(declared(full)).toBe(25_684_205);
    const declaring = async (instructions: number) => withData(op, withResources(sorobanData(full), { instructions }));
    const limit = 'invokeHostFunctionResourceLimitExceeded';
    const message = 'operation instructions exceeds amount specified';
    for (const [instructions, consumed, fee, host] of [
      [20_000_000, 20_003_942n, 16_930n, ['fn_call', 'error']],
      [2_000_000, 2_000_567n, 4_330n, ['fn_call', 'error']],
      // Out before the guest runs, on the module's instantiation: no host error.
      [100_000, 151_745n, 3_000n, ['fn_call']],
    ] as const) {
      expect(await run(await declaring(instructions))).toEqual({ status: 'FAILED', op: limit, fee, debited: fee });
      const diagnostics: xdr.DiagnosticEvent[] = polled.diagnosticEventsXdr;
      expect(diagnostics.map(firstTopic), `${instructions}`).toEqual([...host, 'error']);
      expect(coreError(diagnostics.at(-1)!)).toEqual(['sceBudget', 'scecExceededLimit', message, consumed, BigInt(instructions)]);
      expect(polled.resultMetaXdr.v4.diagnosticEvents.map((e: xdr.DiagnosticEvent) => e.toXdr('base64'))).toEqual(
        diagnostics.map((e) => e.toXdr('base64')),
      );
    }
    // The node's event for 20,000,000, byte for byte.
    expect(submit(await declaring(20_000_000)).diagnosticEventsXdr!.at(-1)).toBe(
      'AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAACAAAADwAAAAVlcnJvcgAAAAAAAAIAAAAHAAAABQAAABAAAAABAAAAAwAAAA4AAAAvb3BlcmF0aW9uIGluc3RydWN0aW9ucyBleGNlZWRzIGFtb3VudCBzcGVjaWZpZWQAAAAABQAAAAABMTxmAAAABQAAAAABMS0A',
    );
    // The classic layer: `detail` is core's diagnostic, `error` still the host's.
    expect(submit(await declaring(2_000_000))).toMatchObject({
      invokeResult: limit,
      detail: `${message}: 2000567 > 2000000`,
      error: expect.stringContaining('Error(Budget, ExceededLimit)'),
    });
  });

  it("is the fee settings' txMaxInstructions: one value bounds simulation and submission", async () => {
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    const tx = await prepared(work(loadgen, 3_000_000));
    // A network that allows 100M per transaction: the same call no longer
    // simulates, and what was simulated under 400M is refused at submission.
    svm.withFeeSettings({ ...QUICKSTART, txMaxInstructions: 100_000_000 });
    expect(await simError(work(loadgen, 3_000_000))).toContain('Error(Budget, ExceededLimit)');
    expect(declared(await prepared(work(loadgen, 2_400_000)))).toBe(100_174_205);
    expect(submit(tx).detail).toBe('transaction instructions resources exceed network config limit: 125134205 > 100000000');
  });

  it('cost params price the work; their limits, when they carry any, go to the fee settings', async () => {
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    // The shipped table carries no limits, so it leaves the network's alone.
    svm.withNetworkCostParams();
    expect(svm.ledger.feeSettings.txMaxInstructions).toBe(400_000_000);
    expect(declared(await prepared(work(loadgen, 3_000_000)))).toBe(125_134_205);
    // loadCostParamsFromRpc's cpuLimit / memLimit are ContractComputeV0's.
    svm.withNetworkCostParams({ ...PROTOCOL_27_COST_PARAMS, cpuLimit: 100_000_000n, memLimit: 20_000_000n });
    expect(svm.ledger.feeSettings).toMatchObject({ txMaxInstructions: 100_000_000, txMemoryLimit: 20_000_000 });
    expect(await simError(work(loadgen, 3_000_000))).toContain('Error(Budget, ExceededLimit)');
    expect(TESTNET_FEE_SETTINGS).toMatchObject({ txMaxInstructions: 400_000_000, txMemoryLimit: 41_943_040 });
  });

  it('is txMemoryLimit for memory, simulated and applied, as on a node lowered to 2,000,000 bytes', async () => {
    // A private quickstart with testnet's limits, its ContractComputeV0 then
    // upgraded to txMemoryLimit 2,000,000 (core's minimum, NetworkConfig.h:34)
    // (.probe-live-mem.mts): each transaction prepared under 41,943,040 bytes,
    // sent after the upgrade, then simulated again. Its fee settings were
    // QUICKSTART's.
    const alloc = await deploy(fixture('alloc.wasm'), Buffer.alloc(32, 3));
    const loadgen = await deploy(LOADGEN, Buffer.alloc(32, 2));
    const invoke = (contract: string, fn: string, args: xdr.ScVal[]) =>
      Operation.invokeContractFunction({ contract, function: fn, args });
    const upload = (bytes: number) => Operation.uploadContractWasm({ wasm: padded(fixture('add_i32.wasm'), bytes) });
    const ok = 'invokeHostFunctionSuccess';
    const trapped = 'invokeHostFunctionTrapped';
    const limit = 'invokeHostFunctionResourceLimitExceeded';
    // Core calls a failure RESOURCE_LIMIT_EXCEEDED only when the budget's PEAK
    // memory passed txMemoryLimit (InvokeHostFunctionOpFrame.cpp:747, with
    // out.mem_bytes = get_mem_bytes_consumed, soroban_proto_any.rs:484). A
    // guest's linear memory that cannot grow is refused WITHOUT being charged
    // (budget/wasmi_helper.rs:33-47), so the peak stays under the limit and
    // the node reports a trap: "GrowthOperationLimited", "OutOfBoundsGrowth".
    // Past it, core pushes its own diagnostic, ["operation memory usage exceeds
    // network config limit", peak, txMemoryLimit] (:746-753); the node's peak
    // is the fourth column where its text was read.
    const memory = 'operation memory usage exceeds network config limit';
    const events = invoke(loadgen, 'do_cpu_only_work', [u32(0), u32(0), u32(1_000)]);
    const cases: [xdr.Operation, string, bigint, bigint?][] = [
      [invoke(alloc, 'sum', [u32(10)]), ok, 4_168n],
      [invoke(alloc, 'sum', [u32(100)]), trapped, 12_951n],
      [invoke(loadgen, 'do_cpu_only_work', [u32(0), u32(5_000), u32(0)]), ok, 21_085n],
      [invoke(loadgen, 'do_cpu_only_work', [u32(0), u32(20_000), u32(0)]), limit, 74_144n],
      // the node: "operation memory usage exceeds network config limit: 2000207, 2000000"
      [events, limit, 9_289n, 2_000_207n],
      [upload(20_000), trapped, 121_794n],
      // the node: "operation memory usage exceeds network config limit: 2612663, 2000000"
      [upload(60_000), limit, 353_925n, 2_612_663n],
    ];
    const sent: [Transaction, Keypair][] = [];
    for (const [op] of cases) {
      a = fund();
      sent.push([await prepared(op), a]);
    }
    a = fund();
    const viaClassic: [Transaction, Keypair] = [await prepared(events), a];
    svm.withFeeSettings({ ...QUICKSTART, txMemoryLimit: 2_000_000 });
    for (const [i, [op, code, fee, peak]] of cases.entries()) {
      const [tx, payer] = sent[i];
      expect(await run(tx, payer), `case ${i}`).toEqual({
        status: code === ok ? 'SUCCESS' : 'FAILED', op: code, fee, debited: fee,
      });
      if (peak !== undefined) {
        expect(coreError(polled.diagnosticEventsXdr.at(-1)), `case ${i}`).toEqual([
          'sceBudget', 'scecExceededLimit', memory, peak, 2_000_000n,
        ]);
      }
      // Simulation runs under the same 2,000,000 bytes: what failed for memory
      // no longer simulates.
      a = fund();
      expect(await simError(op), `case ${i}`).toEqual(code === ok ? 'simulated' : expect.stringContaining('Error(Budget, ExceededLimit)'));
    }
    // The classic layer: `detail` is core's diagnostic, `error` still the host's.
    expect(submit(...viaClassic)).toMatchObject({
      invokeResult: limit,
      detail: `${memory}: 2000207 > 2000000`,
      error: expect.stringContaining('Error(Budget, ExceededLimit)'),
    });
  });
});
