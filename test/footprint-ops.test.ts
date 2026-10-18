/**
 * ExtendFootprintTTL and RestoreFootprint, applied and simulated.
 *
 * Rules from stellar-core v29.0.0 (ExtendFootprintTTLOpFrame.cpp,
 * RestoreFootprintOpFrame.cpp) and soroban-simulation 29.0.2 (resources.rs),
 * and checked against a local protocol-29 network (stellar/quickstart:
 * stellar-core 29.0.0, stellar-rpc 29.0.1): extend by 200k, a shorter extend, a
 * missing key, every MALFORMED shape, restoring a live entry, and every
 * simulation result and error below matched the node. Restoring an ARCHIVED
 * entry follows core's source here: on that network a persistent entry needs
 * 120,960 ledgers to expire. A private node started with minPersistentTTL 20
 * later restored one, and refused one declaring fewer bytes than the entry
 * (test/resource-limits.test.ts).
 *
 * Rent is pinned in test/fees.test.ts, the network's limits in
 * test/resource-limits.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { LiteStellar } from '../src/litestellar.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });

function world() {
  const svm = new LiteStellar();
  const kp = Keypair.random();
  svm.ledger.fund(kp.publicKey(), { balance: 10_000n * 10_000_000n });
  const contract = svm.deployContract(CONTRACT_DATA);
  const server = svm.rpcServer();
  const key = (name: string, durability: 'persistent' | 'temporary' = 'persistent') =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contract.contractId).toScAddress(),
        key: sym(name),
        durability: xdr.ContractDataDurability[durability](),
      }),
    );
  const ttl = (k: xdr.LedgerKey) => svm.ledger.getEntryTtl(k.toXDR('base64'));

  const build = async (
    op: xdr.Operation,
    fp: { ro?: xdr.LedgerKey[]; rw?: xdr.LedgerKey[] },
    bytes: { read?: number; write?: number } = {},
  ) => {
    const acct = await server.getAccount(kp.publicKey());
    const data = new SorobanDataBuilder()
      .setReadOnly(fp.ro ?? [])
      .setReadWrite(fp.rw ?? [])
      .setResources(0, bytes.read ?? 0, bytes.write ?? 0)
      .setResourceFee(10_000_000)
      .build();
    return new TransactionBuilder(acct, { fee: '10100000', networkPassphrase: svm.networkPassphrase })
      .setSorobanData(data)
      .addOperation(op)
      .setTimeout(300)
      .build();
  };
  const send = (tx: Transaction) => {
    tx.sign(kp);
    return svm.sendTransaction(tx.toXDR());
  };
  const put = async (name: string) => {
    const acct = await server.getAccount(kp.publicKey());
    const tx = (await server.prepareTransaction(
      new TransactionBuilder(acct, { fee: '1000', networkPassphrase: svm.networkPassphrase })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contract.contractId,
            function: 'put_persistent',
            args: [sym(name), nativeToScVal(1n, { type: 'u64' })],
          }),
        )
        .setTimeout(300)
        .build(),
    )) as Transaction;
    expect(send(tx).code).toBe('txSUCCESS');
  };
  const simulate = async (op: xdr.Operation, fp: { ro?: xdr.LedgerKey[]; rw?: xdr.LedgerKey[] }) => {
    const sim: any = await server.simulateTransaction(await build(op, fp));
    if (sim.error) return { error: String(sim.error) };
    const r = sim.transactionData.build().resources();
    return {
      ro: r.footprint().readOnly().length,
      rw: r.footprint().readWrite().length,
      read: r.diskReadBytes(),
      write: r.writeBytes(),
      instructions: r.instructions(),
    };
  };
  return { svm, kp, key, ttl, build, send, put, simulate };
}

const extend = (extendTo: number) => Operation.extendFootprintTtl({ extendTo });
const restore = () => Operation.restoreFootprint({});

describe('ExtendFootprintTTL', () => {
  it('raises a live entry to exactly ledger + extendTo', async () => {
    const w = world();
    await w.put('k');
    expect(await w.simulate(extend(200_000), { ro: [w.key('k')] })).toEqual({
      ro: 1, rw: 0, read: 0, write: 0, instructions: 0,
    });
    const ledger = w.svm.ledger.ledgerSeq;
    const out = w.send(await w.build(extend(200_000), { ro: [w.key('k')] }));
    expect([out.code, out.footprintOpResult]).toEqual(['txSUCCESS', 'extendFootprintTtlSuccess']);
    expect(w.ttl(w.key('k'))).toBe(ledger + 200_000);
  });

  it('leaves alone an entry that already lives longer, and a missing one', async () => {
    const w = world();
    await w.put('k');
    const before = w.ttl(w.key('k'));
    expect(await w.simulate(extend(1000), { ro: [w.key('k'), w.key('nope')] })).toEqual({
      ro: 0, rw: 0, read: 0, write: 0, instructions: 0,
    });
    expect(w.send(await w.build(extend(1000), { ro: [w.key('k'), w.key('nope')] })).code).toBe('txSUCCESS');
    expect(w.ttl(w.key('k'))).toBe(before);
  });

  it('skips an archived entry on apply; simulation says it must be restored first', async () => {
    const w = world();
    await w.put('k');
    // Expired in the last closed ledger too, which is where stellar-rpc
    // preflights (simulate_transaction.go, LedgerSeq: latestLedger).
    w.svm.advanceLedgers(w.ttl(w.key('k'))! - w.svm.ledger.ledgerSeq + 2);
    const expired = w.ttl(w.key('k'));
    expect((await w.simulate(extend(200_000), { ro: [w.key('k')] })).error).toMatch(
      /^Can't extend for an expired entry .* The entry must be restored before it can be extended\.$/,
    );
    expect(w.send(await w.build(extend(200_000), { ro: [w.key('k')] })).code).toBe('txSUCCESS');
    expect(w.ttl(w.key('k'))).toBe(expired);
  });

  const malformed: [string, (w: ReturnType<typeof world>) => { op: xdr.Operation; ro?: xdr.LedgerKey[]; rw?: xdr.LedgerKey[] }][] = [
    ['a read-write footprint', (w) => ({ op: extend(1000), rw: [w.key('k')] })],
    ['a key without a TTL', (w) => ({
      op: extend(1000),
      ro: [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: w.kp.xdrAccountId() }))],
    })],
    ['extendTo past maxEntryTTL - 1', (w) => ({ op: extend(w.svm.ledger.archivalSettings.maxEntryTtl), ro: [w.key('k')] })],
  ];
  for (const [name, make] of malformed) {
    it(`rejects ${name} at submission: txFAILED [extendFootprintTtlMalformed], nothing taken`, async () => {
      const w = world();
      const { op, ro, rw } = make(w);
      const seq = w.svm.getAccount(w.kp.publicKey())!.seqNum().toString();
      const out = w.send(await w.build(op, { ro, rw }));
      expect([out.code, out.footprintOpResult, out.rejected]).toEqual(['txFAILED', 'extendFootprintTtlMalformed', true]);
      expect(w.svm.getAccount(w.kp.publicKey())!.seqNum().toString()).toBe(seq);
    });
  }

  it('simulating a key without a TTL is an error, in soroban-simulation\'s words', async () => {
    const w = world();
    const acctKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: w.kp.xdrAccountId() }));
    expect((await w.simulate(extend(1000), { ro: [acctKey] })).error).toMatch(
      /^Can't extend TTL for ledger entry with key `Account\(.*\)`\. Only entries with TTL \(contract data or code entries\) can have it extended$/,
    );
  });
});

describe('RestoreFootprint', () => {
  it('restores an archived entry to ledger + minPersistentTTL - 1 (core source; see header)', async () => {
    const w = world();
    await w.put('k');
    w.svm.advanceLedgers(w.ttl(w.key('k'))! - w.svm.ledger.ledgerSeq + 2); // archived as of latestLedger
    const entryBytes = Buffer.from(w.svm.ledger.getEntry(w.key('k').toXDR('base64'))!, 'base64').length;
    expect(await w.simulate(restore(), { rw: [w.key('k')] })).toEqual({
      ro: 0, rw: 1, read: entryBytes, write: entryBytes, instructions: 0,
    });
    const ledger = w.svm.ledger.ledgerSeq;
    const out = w.send(await w.build(restore(), { rw: [w.key('k')] }, { read: entryBytes, write: entryBytes }));
    expect([out.code, out.footprintOpResult]).toEqual(['txSUCCESS', 'restoreFootprintSuccess']);
    expect(w.ttl(w.key('k'))).toBe(ledger + w.svm.ledger.archivalSettings.minPersistentTtl - 1);
  });

  it('leaves a live entry alone', async () => {
    const w = world();
    await w.put('k');
    const before = w.ttl(w.key('k'));
    expect(await w.simulate(restore(), { rw: [w.key('k')] })).toEqual({ ro: 0, rw: 0, read: 0, write: 0, instructions: 0 });
    expect(w.send(await w.build(restore(), { rw: [w.key('k')] })).code).toBe('txSUCCESS');
    expect(w.ttl(w.key('k'))).toBe(before);
  });

  it('rejects a read-only footprint, and a temporary key, as restoreFootprintMalformed', async () => {
    const w = world();
    for (const fp of [{ ro: [w.key('k')] }, { rw: [w.key('k', 'temporary')] }]) {
      const out = w.send(await w.build(restore(), fp));
      expect([out.code, out.footprintOpResult, out.rejected]).toEqual(['txFAILED', 'restoreFootprintMalformed', true]);
    }
  });

  it('simulating a temporary or a missing key is an error, as soroban-simulation words it', async () => {
    const w = world();
    expect((await w.simulate(restore(), { rw: [w.key('k', 'temporary')] })).error).toMatch(
      /^Can't restore a ledger entry with key: .*\. Only persistent ledger entries with TTL can be restored\.$/,
    );
    expect((await w.simulate(restore(), { rw: [w.key('nope')] })).error).toMatch(/^Missing entry to restore for key ContractData\(/);
  });
});
