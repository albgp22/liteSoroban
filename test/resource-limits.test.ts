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
 *
 * Every code, diagnostic and fee pinned here was first observed on a local
 * stellar/quickstart (stellar-core 29.0.0, stellar-rpc 29.0.1, protocol 29) on
 * 2026-10-18 by the same scenario through rpc.Server (.probe-live-limits.mts):
 * submission and invocation cases on the node whose settings QUICKSTART holds,
 * restore and oversized-entry cases on a private one started with testnet's
 * limits but minPersistentTTL 20, then upgraded to contractDataEntrySizeBytes
 * 2,000. Core puts the values in its diagnostic's arguments; `detail` writes
 * them `value > limit`. Successful calls are not compared on fees here: their
 * rent follows the state-archival TTLs, which are not yet the node's.
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
import { LiteStellar, PROTOCOL_27_COST_PARAMS } from '../src/litestellar.js';
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

const balance = (k: Keypair) => BigInt(svm.getAccount(k.publicKey())!.balance().toString());
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
  xdr.SorobanTransactionData.fromXDR(tx.toEnvelope().v1().tx().ext().sorobanData().toXDR());

/** Through the classic layer, for the outcome's diagnostic. */
function submit(tx: Transaction | FeeBumpTransaction, payer = a) {
  tx.sign(payer);
  const before = balance(payer);
  const out = svm.sendTransaction(tx.toXDR());
  return { ...out, debited: before - balance(payer) };
}

/** Through rpc.Server, as an app sees it. */
async function run(tx: Transaction) {
  tx.sign(a);
  const before = balance(a);
  const sent = await S.sendTransaction(tx);
  if (sent.status === 'ERROR') return { status: `ERROR ${sent.errorResult!.result().switch().name}`, op: '', fee: 0n, debited: 0n };
  const got: any = await S.pollTransaction(sent.hash);
  const result: xdr.TransactionResult = got.resultXdr;
  return {
    status: got.status as string,
    op: result.result().results()[0].tr().value().switch().name as string,
    fee: BigInt(result.feeCharged().toString()),
    debited: before - balance(a),
  };
}

async function deploy(wasm: Buffer): Promise<string> {
  expect((await run(await prepared(Operation.uploadContractWasm({ wasm })))).status).toBe('SUCCESS');
  const create = await prepared(
    Operation.createCustomContract({ address: new Address(a.publicKey()), wasmHash: hash(wasm), salt: Buffer.alloc(32, 1) }),
  );
  const out = submit(create);
  expect(out.code).toBe('txSUCCESS');
  return Address.fromScVal(xdr.ScVal.fromXDR(out.returnValueXdr!, 'base64')).toString();
}

const dataKey = (k: xdr.ScVal, durability: 'persistent' | 'temporary' = 'persistent') =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(store).toScAddress(),
      key: k,
      durability: xdr.ContractDataDurability[durability](),
    }),
  );
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
  const res = (d: Fp) => d.resources();
  const addRo = (d: Fp, keys: xdr.LedgerKey[]) => res(d).footprint().readOnly([...res(d).footprint().readOnly(), ...keys]);
  const addRw = (d: Fp, keys: xdr.LedgerKey[]) => res(d).footprint().readWrite([...res(d).footprint().readWrite(), ...keys]);
  const junk = (n: number) => Array.from({ length: n }, (_, i) => dataKey(sym(`j${i}`)));
  const accounts = (n: number) => Array.from({ length: n }, () => accountKey(Keypair.random()));
  const bytesKey = (n: number) => dataKey(nativeToScVal(Buffer.alloc(n, 1)));
  const trustline = (asset: xdr.TrustLineAsset) =>
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: a.xdrAccountId(), asset }));
  const archived = (indexes: number[]) => (d: Fp) =>
    d.ext(new (xdr.SorobanTransactionDataExt as any)(1, new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: indexes })));

  /** A simulated put_persistent with its SorobanTransactionData edited. Its footprint is
   * 3 entries: the instance and the code read-only, the key read-write. */
  async function edited(edit: (d: Fp) => void, enoughFee = false) {
    const op = put('k');
    const d = sorobanData(await prepared(op));
    edit(d);
    if (enoughFee) {
      d.resourceFee(new xdr.Int64(50_000_000n));
      if (res(d).instructions() < 100_000_000) res(d).instructions(100_000_000);
    }
    return withData(op, d);
  }

  const over: [string, (d: Fp) => void, string][] = [
    ['instructions', (d) => res(d).instructions(400_000_001),
      'transaction instructions resources exceed network config limit: 400000001 > 400000000'],
    ['disk read bytes', (d) => res(d).diskReadBytes(200_001),
      'transaction byte-read resources exceed network config limit: 200001 > 200000'],
    ['write bytes', (d) => res(d).writeBytes(132_097),
      'transaction byte-write resources exceed network config limit: 132097 > 132096'],
    ['instructions and disk read bytes: the first check wins', (d) => {
      res(d).instructions(400_000_001);
      res(d).diskReadBytes(200_001);
    }, 'transaction instructions resources exceed network config limit: 400000001 > 400000000'],
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
    ["the issuer's own trustline", (d) => addRo(d, [trustline(new Asset('USD', a.publicKey()).toTrustLineXDRObject())]),
      'transaction footprint contains invalid trustline asset'],
    ['an asset code with a zero in the middle', (d) => addRo(d, [trustline(
      xdr.TrustLineAsset.assetTypeCreditAlphanum4(
        new xdr.AlphaNum4({ assetCode: Buffer.from([0x55, 0, 0x53, 0]), issuer: Keypair.random().xdrAccountId() }),
      ),
    )]), 'transaction footprint contains invalid trustline asset'],
    ['archived indexes out of order', (d) => {
      addRw(d, junk(1));
      archived([0, 0])(d);
    }, 'archivedSorobanEntries must be sorted in ascending order'],
    ['an archived index past the read-write footprint', archived([5]),
      'archivedSorobanEntries index is out of bounds: 5 >= 1'],
    ['an archived index on a temporary key', (d) => {
      res(d).footprint().readWrite([dataKey(sym('t'), 'temporary'), ...res(d).footprint().readWrite()]);
      archived([0])(d);
    }, 'archivedSorobanEntries index points to a non-persistent entry: 0, key type 6'],
  ];

  it.each(over)('over the limit: %s', async (_, edit, detail) => {
    const tx = await edited(edit);
    const out = submit(tx);
    expect([out.code, out.rejected, out.detail]).toEqual(['txSOROBAN_INVALID', true, detail]);
    // Nothing moves; the result reports the declared resource fee + baseFee.
    const declared = BigInt(sorobanData(tx).resourceFee().toString());
    expect([out.debited, out.feeCharged]).toEqual([0n, declared + 100n]);
  });

  it('every limit is inclusive: a transaction AT each one is accepted and applies', async () => {
    const at: ((d: Fp) => void)[] = [
      (d) => res(d).instructions(400_000_000),
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
    const d = sorobanData(await prepared(op));
    res(d).instructions(400_000_001);
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
    const declared = res(sorobanData(tx)).instructions();
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
    // Parsing 128 KB of Wasm takes more than the host's default 100M-instruction
    // ceiling; the node's is its txMaxInstructions, 400M.
    svm.withNetworkCostParams({ ...PROTOCOL_27_COST_PARAMS, cpuLimit: 400_000_000n });
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
    const d = sorobanData(await prepared(op));
    d.resources().writeBytes(d.resources().writeBytes() - 1);
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
    const d = sorobanData(await prepared(op));
    d.resources().diskReadBytes(d.resources().diskReadBytes() - 1);
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
    const d = sorobanData(await prepared(op));
    d.resources().writeBytes(0);
    expect(submit(await withData(op, d)).code).toBe('txSUCCESS');
    expect(submit(await prepared(bytes('b64', 64))).invokeResult).toBe('invokeHostFunctionResourceLimitExceeded');
  });
});

describe('apply: ExtendFootprintTTL / RestoreFootprint', () => {
  const restoreOp = Operation.restoreFootprint({});
  const archive = () => svm.ledger.advanceLedgers(svm.ledger.archivalSettings.minPersistentTtl + 1);
  /** A restore of `k` as simulated, with its declared bytes edited. */
  async function restore(k: string, edit: (r: xdr.SorobanResources) => void = () => {}) {
    const d = sorobanData(await prepared(restoreOp, new SorobanDataBuilder().setReadWrite([dataKey(sym(k))]).build()));
    edit(d.resources());
    return withData(restoreOp, d);
  }
  const ttl = (k: string) => svm.ledger.getEntryTtl(dataKey(sym(k)).toXDR('base64'));
  const keepContractAlive = async () => {
    expect((await run(await prepared(call('extend_instance', [u32(1_000_000), u32(1_000_000)]))))).toMatchObject({ status: 'SUCCESS' });
    const instance = (await S.getLedgerEntries(dataKey(xdr.ScVal.scvLedgerKeyContractInstance()))).entries[0];
    const code = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: instance.val.contractData().val().instance().executable().wasmHash() }),
    );
    const extend = await prepared(Operation.extendFootprintTtl({ extendTo: 1_000_000 }), new SorobanDataBuilder().setReadOnly([code]).build());
    expect(await run(extend)).toMatchObject({ status: 'SUCCESS' });
  };

  it('restores no more bytes than declared: read first, then write', async () => {
    await keepContractAlive();
    for (const k of ['r1', 'r2', 'r3', 'r4']) expect(await run(await prepared(put(k)))).toMatchObject({ status: 'SUCCESS' });
    archive();
    const cases: [string, (r: xdr.SorobanResources) => void, bigint, string][] = [
      ['r1', (r) => r.diskReadBytes(79), 6_591n, 'operation byte-read resources exceeds amount specified: 80 > 79'],
      ['r2', (r) => r.writeBytes(79), 6_590n, 'operation byte-write resources exceeds amount specified: 80 > 79'],
      ['r3', (r) => (r.diskReadBytes(0), r.writeBytes(0)), 6_487n, 'operation byte-read resources exceeds amount specified: 80 > 0'],
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
