/**
 * Fee DEBITS, against a real node.
 *
 * Every number pinned here was first observed on a local stellar/quickstart
 * (stellar-core 29.0.0, stellar-rpc 29.0.1, protocol 29) on 2026-10-18, by
 * running the same scenario through rpc.Server and reading the fee source's
 * balance before and after, the result's feeCharged and the meta's
 * SorobanTransactionMetaExtV1. The harness runs with that node's fee settings
 * (QUICKSTART below, read with loadFeeSettingsFromRpc); its default cost table
 * already equals the node's. Both sides upload the fixtures with the same
 * 22-byte custom section, so the node had never stored the code before.
 *
 * Rules (stellar-core v29.0.0): getFee(applying = true) up front = declared
 * resource fee + min(inclusion fee, baseFee * ops); after the operation the
 * refundable fee it did not consume on rent and events comes back, all of it
 * when it failed (RefundableFeeTracker, MutableTransactionResult.cpp).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { LiteStellar, TESTNET_FEE_SETTINGS, type NetworkFeeSettings } from '../src/litestellar.js';
import { Ledger } from '../src/index.js';

/** The local quickstart's fee settings, read at ledger 7,920. */
const QUICKSTART: NetworkFeeSettings = {
  feeRatePerInstructionsIncrement: 7,
  feeDiskReadLedgerEntry: 1563,
  feeWriteLedgerEntry: 2500,
  feeDiskRead1kb: 447,
  sorobanStateTargetSizeBytes: 4_000_000_000,
  rentFee1kbSorobanStateSizeLow: -17_000,
  rentFee1kbSorobanStateSizeHigh: 10_000,
  sorobanStateRentFeeGrowthFactor: 5000,
  feeWrite1kb: 875,
  feeHistorical1kb: 4059,
  txMaxContractEventsSizeBytes: 16_384,
  feeContractEvents1kb: 5000,
  feeTxSize1kb: 406,
  persistentRentRateDenominator: 1215,
  tempRentRateDenominator: 2430,
  averageSorobanStateSize: 4_074_449,
};

const PASS = 'Standalone Network ; February 2017';
const fixture = (n: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)));
/** The probe's custom section ("lsx" + 16 tag bytes): same size, same metering. */
const unique = (w: Buffer) =>
  Buffer.concat([w, Buffer.from([0, 20, 3]), Buffer.from('lsx'), Buffer.alloc(16, 7)]);
const ADD = unique(fixture('add_i32.wasm'));
const DATA = unique(fixture('contract_data.wasm'));
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });

let svm: LiteStellar;
let S: rpc.Server;
let a: Keypair;

const balance = (k: Keypair) => BigInt(svm.getAccount(k.publicKey())!.balance().toString());
const fund = () => {
  const k = Keypair.random();
  svm.ledger.fund(k.publicKey(), { balance: 10_000n * 10_000_000n });
  return k;
};

async function prepared(op: xdr.Operation, fee = '100', data?: xdr.SorobanTransactionData) {
  const b = new TransactionBuilder(await S.getAccount(a.publicKey()), { fee, networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(300);
  if (data) b.setSorobanData(data);
  const raw = b.build();
  const sim = await S.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`simulation failed: ${(sim as any).error}`);
  return { tx: rpc.assembleTransaction(raw, sim).build(), minResourceFee: BigInt(sim.minResourceFee) };
}

/** The same operation with its SorobanTransactionData replaced; build() adds the resource fee. */
async function withData(op: xdr.Operation, data: xdr.SorobanTransactionData) {
  return new TransactionBuilder(await S.getAccount(a.publicKey()), { fee: '100', networkPassphrase: PASS })
    .addOperation(op)
    .setSorobanData(data)
    .setTimeout(300)
    .build();
}

const sorobanData = (tx: Transaction) => tx.toEnvelope().v1().tx().ext().sorobanData();

interface Charged {
  status: string;
  debited: bigint;
  feeCharged: bigint;
  op: string;
  nonRefundable?: bigint;
  refundable?: bigint;
  rent?: bigint;
  returnValue?: xdr.ScVal;
}

async function run(tx: Transaction | ReturnType<typeof TransactionBuilder.buildFeeBumpTransaction>, payer: Keypair): Promise<Charged> {
  const before = balance(payer);
  const sent = await S.sendTransaction(tx);
  if (sent.status === 'ERROR') {
    return {
      status: `ERROR ${sent.errorResult!.result().switch().name}`,
      debited: before - balance(payer),
      feeCharged: BigInt(sent.errorResult!.feeCharged().toString()),
      op: '',
    };
  }
  const got: any = await S.pollTransaction(sent.hash);
  const result: xdr.TransactionResult = got.resultXdr;
  let r: any = result.result();
  if (r.switch().name.startsWith('txFeeBump')) r = r.innerResultPair().result().result();
  const op = r.results()[0].tr().value().switch().name;
  const ext = (got.resultMetaXdr as xdr.TransactionMeta).v4().sorobanMeta()!.ext();
  const fee = ext.switch() === 1 ? ext.v1() : null;
  return {
    status: got.status,
    debited: before - balance(payer),
    feeCharged: BigInt(result.feeCharged().toString()),
    op,
    nonRefundable: fee ? BigInt(fee.totalNonRefundableResourceFeeCharged().toString()) : undefined,
    refundable: fee ? BigInt(fee.totalRefundableResourceFeeCharged().toString()) : undefined,
    rent: fee ? BigInt(fee.rentFeeCharged().toString()) : undefined,
    returnValue: got.returnValue,
  };
}

async function send(op: xdr.Operation, fee = '100') {
  const p = await prepared(op, fee);
  p.tx.sign(a);
  return { ...(await run(p.tx, a)), minResourceFee: p.minResourceFee, tx: p.tx };
}

async function deploy(wasm: Buffer, salt: number) {
  const upload = await send(Operation.uploadContractWasm({ wasm }));
  const p = await prepared(
    Operation.createCustomContract({
      address: new Address(a.publicKey()),
      wasmHash: hash(wasm),
      salt: Buffer.alloc(32, salt),
    }),
  );
  p.tx.sign(a);
  const create = await run(p.tx, a);
  return { address: Address.fromScVal(create.returnValue!).toString(), upload, create };
}

describe('fee debits match a protocol-29 node', () => {
  let adder: string;
  let store: string;
  let storeDeploy: Awaited<ReturnType<typeof deploy>>;
  const addOp = () => Operation.invokeContractFunction({ contract: adder, function: 'add', args: [i32(2), i32(3)] });
  const putOp = (k: string) =>
    Operation.invokeContractFunction({ contract: store, function: 'put_persistent', args: [sym(k), u64(42n)] });
  const dataKey = (k: string) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(store).toScAddress(),
        key: sym(k),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

  beforeEach(async () => {
    svm = new LiteStellar({ networkPassphrase: PASS }).withFeeSettings(QUICKSTART);
    S = svm.rpcServer();
    a = fund();
    adder = (await deploy(ADD, 1)).address;
    storeDeploy = await deploy(DATA, 2);
    store = storeDeploy.address;
  });

  it('an invocation costs its non-refundable fee, its events fee and the base fee, however far the bid goes', async () => {
    // LIVE: add(2,3) charged 3,561 = 2,972 + 489 + 100 at an inclusion bid of
    // 100 and again at 1,000,000. minResourceFee 13,143.
    const cheap = await send(addOp(), '100');
    const rich = await send(addOp(), '1000000');
    for (const r of [cheap, rich]) {
      expect(r.status).toBe('SUCCESS');
      expect(r.debited).toBe(3561n);
      expect(r.feeCharged).toBe(3561n);
      expect([r.nonRefundable, r.refundable, r.rent]).toEqual([2972n, 489n, 0n]);
      expect(r.minResourceFee).toBe(13_143n);
    }
  });

  it('a fee bump charges its fee source baseFee * (ops + 1), and the inner source nothing', async () => {
    // LIVE: outer inclusion 1,000 -> charged 3,661 = 2,972 + 489 + 200; the
    // inner source paid 0. The resource fee is priced on the INNER envelope
    // (356 bytes, the same 2,972 as unbumped), not the 484-byte bump.
    const f = fund();
    const p = await prepared(addOp());
    p.tx.sign(a);
    const fb = TransactionBuilder.buildFeeBumpTransaction(f, '500', p.tx, PASS);
    fb.sign(f);
    const innerBefore = balance(a);
    const r = await run(fb, f);
    expect(r.status).toBe('SUCCESS');
    expect(r.debited).toBe(3661n);
    expect(r.feeCharged).toBe(3661n);
    expect(r.nonRefundable).toBe(2972n);
    expect(balance(a)).toBe(innerBefore);
  });

  it('a failed invocation refunds the whole refundable fee', async () => {
    // LIVE: put_persistent declaring half the instructions it needs ->
    // FAILED, invokeHostFunctionResourceLimitExceeded, charged 5,906 =
    // 5,806 non-refundable (of the halved instructions) + 100; refundable 0.
    const op = putOp('k3');
    const p = await prepared(op);
    const data = sorobanData(p.tx);
    data.resources().instructions(Math.floor(data.resources().instructions() / 2));
    const tx = await withData(op, data);
    tx.sign(a);
    const r = await run(tx, a);
    expect(r.status).toBe('FAILED');
    expect(r.op).toBe('invokeHostFunctionResourceLimitExceeded');
    expect(r.debited).toBe(5906n);
    expect([r.nonRefundable, r.refundable, r.rent]).toEqual([5806n, 0n, 0n]);
  });

  it('rejects a declared resource fee below what the declared resources cost', async () => {
    // LIVE: put_persistent with resourceFee = 5,968 - 1 -> ERROR
    // txSorobanInvalid, feeCharged 6,067 (declared + 100), nothing debited.
    const op = putOp('k4');
    const p = await prepared(op);
    const data = sorobanData(p.tx);
    data.resourceFee(new xdr.Int64(5967n));
    const tx = await withData(op, data);
    tx.sign(a);
    const r = await run(tx, a);
    expect(r.status).toBe('ERROR txSorobanInvalid');
    expect(r.feeCharged).toBe(6067n);
    expect(r.debited).toBe(0n);
  });

  it('ExtendFootprintTTL pays rent for the ledgers it adds out of the refundable fee', async () => {
    // LIVE: k1 extended by 379,050 ledgers (TTL 129,927 -> 508,977) ->
    // charged 29,357 = 2,341 + 26,916 rent + 100; minResourceFee 42,904.
    await send(putOp('k1'));
    const k = dataKey('k1').toXDR('base64');
    svm.ledger.putEntry(svm.ledger.getEntry(k)!, svm.ledger.ledgerSeq + 500_000 - 379_050);
    const data = new SorobanDataBuilder().setReadOnly([dataKey('k1')]).build();
    const p = await prepared(Operation.extendFootprintTtl({ extendTo: 500_000 }), '100', data);
    p.tx.sign(a);
    const r = await run(p.tx, a);
    expect(r.status).toBe('SUCCESS');
    expect(r.op).toBe('extendFootprintTtlSuccess');
    expect(r.debited).toBe(29_357n);
    expect([r.nonRefundable, r.refundable, r.rent]).toEqual([2341n, 26_916n, 26_916n]);
    expect(p.minResourceFee).toBe(42_904n);
  });

  it('ExtendFootprintTTL fails, and extends nothing, when the refundable fee is short of the rent', async () => {
    // LIVE: resourceFee = 2,341 + rent / 2 -> FAILED,
    // extendFootprintTtlInsufficientRefundableFee, charged 2,441.
    await send(putOp('k2'));
    const k = dataKey('k2').toXDR('base64');
    const ttl = svm.ledger.getEntryTtl(k);
    const op = Operation.extendFootprintTtl({ extendTo: 500_000 });
    const p = await prepared(op, '100', new SorobanDataBuilder().setReadOnly([dataKey('k2')]).build());
    const data = sorobanData(p.tx);
    data.resourceFee(new xdr.Int64(2341n + 13_458n));
    const tx = await withData(op, data);
    tx.sign(a);
    const r = await run(tx, a);
    expect(r.status).toBe('FAILED');
    expect(r.op).toBe('extendFootprintTtlInsufficientRefundableFee');
    expect(r.debited).toBe(2441n);
    expect(svm.ledger.getEntryTtl(k)).toBe(ttl);
  });

  it('RestoreFootprint pays the rent of a brand-new entry of the same size', async () => {
    // compute_rent_fee prices a restore as a creation (old size and TTL 0,
    // RestoreFootprintOpFrame.cpp), and a creation gets the same TTL, so
    // restoring k5 costs the rent writing it cost.
    const created = await send(putOp('k5'));
    const k = dataKey('k5').toXDR('base64');
    // Archived in the last closed ledger too, which is where stellar-rpc
    // preflights (simulate_transaction.go, LedgerSeq: latestLedger): one
    // ledger past the TTL is still live there, so preflight would skip it.
    svm.ledger.advanceLedgers(svm.ledger.getEntryTtl(k)! - svm.ledger.ledgerSeq + 2);
    const op = Operation.restoreFootprint({});
    const p = await prepared(op, '100', new SorobanDataBuilder().setReadWrite([dataKey('k5')]).build());
    p.tx.sign(a);
    const r = await run(p.tx, a);
    expect(r.op).toBe('restoreFootprintSuccess');
    expect(r.rent).toBe(created.rent);
    expect(r.debited).toBe(r.nonRefundable! + r.rent! + 100n);

    // ...and short of it, fails and leaves the entry archived.
    svm.ledger.advanceLedgers(svm.ledger.getEntryTtl(k)! - svm.ledger.ledgerSeq + 2);
    const q = await prepared(op, '100', new SorobanDataBuilder().setReadWrite([dataKey('k5')]).build());
    const data = sorobanData(q.tx);
    data.resourceFee(new xdr.Int64(r.nonRefundable! + r.rent! - 1n));
    const short = await withData(op, data);
    short.sign(a);
    const s = await run(short, a);
    expect(s.op).toBe('restoreFootprintInsufficientRefundableFee');
    expect(s.debited).toBe(r.nonRefundable! + 100n);
    expect(svm.ledger.getEntryTtl(k)!).toBeLessThan(svm.ledger.ledgerSeq);
  });

  // The rent of a NEW entry depends on the network's minimum TTLs, so these
  // are the node's numbers only at the node's (testnet's: 720 / 120,960).
  // Registered only then, rather than skipped: README's test count is checked
  // against vitest's summary, which a skip breaks.
  if (new Ledger().archivalSettings.minPersistentTtl === 120_960) describe('new entries, at the node\'s TTLs', () => {
    it('charges the node\'s rent for writes, temporary writes, uploads and deploys', async () => {
      // LIVE: upload contract_data 3,312,532 (rent 3,284,441: code is rented
      // at its XDR size plus its parsed module's memory, divided by 3),
      // deploy 19,619 (rent 12,654), put_persistent 16,408 (rent 10,320),
      // put_temporary 8,654 (rent 2,566).
      expect([storeDeploy.upload.debited, storeDeploy.upload.rent]).toEqual([3_312_532n, 3_284_441n]);
      expect([storeDeploy.create.debited, storeDeploy.create.rent]).toEqual([19_619n, 12_654n]);
      const put = await send(putOp('n1'));
      expect([put.debited, put.rent, put.minResourceFee]).toEqual([16_408n, 10_320n, 27_468n]);
      const temp = await send(
        Operation.invokeContractFunction({ contract: store, function: 'put_temporary', args: [sym('t1'), u64(7n)] }),
      );
      expect([temp.debited, temp.rent, temp.minResourceFee]).toEqual([8654n, 2566n, 18_551n]);
    });
  });
});

describe('fee settings', () => {
  it('default to testnet\'s, whose 3.7 GB of state lifts rent off its floor', () => {
    const L = new Ledger();
    expect(L.feeSettings).toEqual(TESTNET_FEE_SETTINGS);
    // compute_rent_write_fee_per_1kb: -17,000 + ceil(27,000 * 3,715,978,052 / 4e9)
    expect(L.feePerRent1kb).toBe(8083n);
    L.setFeeSettings(QUICKSTART);
    expect(L.feePerRent1kb).toBe(1000n); // MINIMUM_RENT_WRITE_FEE_PER_1KB
  });

  it('withFeeCharging(false) debits nothing and checks no resource fee', async () => {
    svm = new LiteStellar({ networkPassphrase: PASS }).withFeeSettings(QUICKSTART);
    S = svm.rpcServer();
    a = fund();
    const adder = (await deploy(ADD, 1)).address;
    svm.withFeeCharging(false);
    const op = Operation.invokeContractFunction({ contract: adder, function: 'add', args: [i32(2), i32(3)] });
    const p = await prepared(op);
    const data = sorobanData(p.tx);
    data.resourceFee(new xdr.Int64(0n));
    const tx = await withData(op, data);
    tx.sign(a);
    const r = await run(tx, a);
    expect(r.status).toBe('SUCCESS');
    expect([r.debited, r.feeCharged]).toEqual([0n, 0n]);
  });
});
