/**
 * State-archival settings: the network's, not a fixture's.
 *
 * Ground truth: soroban-testnet.stellar.org's ConfigSettingStateArchival entry,
 * read with getLedgerEntries on 2026-10-18 (latest ledger 5,264,566). Its
 * LedgerEntryData bytes are TESTNET_ENTRY below, verbatim. A local
 * stellar/quickstart (core 29.0.0, rpc 29.0.1) reports the same TTLs. The host
 * turns them into TTLs as `ledger + ttl - 1` (soroban-env-host 29.0.2,
 * ledger_info.rs:16-30), for contract data, the contract instance and uploaded
 * code alike (lifecycle.rs:400).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Address, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  LiteStellar,
  TESTNET_ARCHIVAL_SETTINGS,
  loadArchivalSettingsFromRpc,
} from '../src/litestellar.js';
import { Ledger } from '../src/index.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });

/** `entries[0].xdr` of testnet's getLedgerEntries answer for the key AAAACAAAAAo=. */
const TESTNET_ENTRY =
  'AAAACAAAAAoAL3YAAAAC0AAB2IAAAAAAAAAEvwAAAAAAAAl+AAAD6AAAAB4AAABAAAehIAAAAAc=';

/** Just enough of rpc.Server: what getLedgerEntries hands back once parsed. */
const stubServer = (entryXdr: string) =>
  ({
    getLedgerEntries: async () => ({
      latestLedger: 5_264_566,
      entries: [{ val: xdr.LedgerEntryData.fromXdr(entryXdr, 'base64'), lastModifiedLedgerSeq: 2_332 }],
    }),
  }) as unknown as rpc.Server;

function dataKey(contractId: string, name: string, durability: 'persistent' | 'temporary'): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: sym(name),
      durability: xdr.ContractDataDurability[durability],
    }),
  ).toXdr('base64');
}

const codeKey = (hashB64: string) =>
  xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(hashB64, 'base64') }),
  ).toXdr('base64');

describe('state-archival settings', () => {
  it("decodes testnet's ConfigSettingStateArchival entry", async () => {
    expect(await loadArchivalSettingsFromRpc(stubServer(TESTNET_ENTRY))).toEqual({
      minTemporaryTtl: 720,
      minPersistentTtl: 120_960,
      maxEntryTtl: 3_110_400,
    });
  });

  it("a fresh ledger runs testnet's", async () => {
    const live = await loadArchivalSettingsFromRpc(stubServer(TESTNET_ENTRY));
    expect(TESTNET_ARCHIVAL_SETTINGS).toEqual(live);
    expect(new Ledger().archivalSettings).toEqual(live);
  });

  it('refuses an entry that is not the state-archival setting', async () => {
    const compute = xdr.LedgerEntryData.configSetting(
      xdr.ConfigSettingEntry.configSettingContractMaxSizeBytes(65_536),
    ).toXdr('base64');
    await expect(loadArchivalSettingsFromRpc(stubServer(compute))).rejects.toThrow(
      /ConfigSettingStateArchival/,
    );
  });

  it('new entries live until ledger + minimum - 1', () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    const seq = svm.ledger.ledgerSeq;
    c.invoke('put_persistent', [sym('p'), u64(1n)]);
    c.invoke('put_temporary', [sym('t'), u64(1n)]);

    expect(svm.getEntryTtl(dataKey(c.contractId, 'p', 'persistent'))).toBe(seq + 120_960 - 1);
    expect(svm.getEntryTtl(dataKey(c.contractId, 't', 'temporary'))).toBe(seq + 720 - 1);
  });

  it('seeded code gets the TTL an upload at the same ledger gets', () => {
    const seeded = new LiteStellar();
    const uploaded = new LiteStellar();
    const hash = seeded.addContract(CONTRACT_DATA);
    const ret = uploaded.uploadContract(CONTRACT_DATA);
    expect(
      Buffer.from(xdr.expectUnionVariant(xdr.ScVal.fromXdr(ret, 'base64'), 'scvBytes').bytes.toBytes()).toString('base64'),
    ).toBe(hash);

    const ttl = uploaded.getEntryTtl(codeKey(hash));
    expect(ttl).toBe(uploaded.ledger.ledgerSeq + 120_960 - 1);
    expect(seeded.getEntryTtl(codeKey(hash))).toBe(ttl);
  });

  it("another network's settings apply to entries written from then on", () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(CONTRACT_DATA);
    c.invoke('put_persistent', [sym('before'), u64(1n)]);
    const before = svm.getEntryTtl(dataKey(c.contractId, 'before', 'persistent'));

    // Any other configuration; these are the host's own testutils.rs ledger.
    const other = { minTemporaryTtl: 16, minPersistentTtl: 4_096, maxEntryTtl: 6_312_000 };
    svm.withArchivalSettings(other);
    expect(svm.ledger.archivalSettings).toEqual(other);

    const seq = svm.ledger.ledgerSeq;
    c.invoke('put_persistent', [sym('after'), u64(1n)]);
    c.invoke('put_temporary', [sym('t'), u64(1n)]);
    expect(svm.getEntryTtl(dataKey(c.contractId, 'after', 'persistent'))).toBe(seq + 4_096 - 1);
    expect(svm.getEntryTtl(dataKey(c.contractId, 't', 'temporary'))).toBe(seq + 16 - 1);
    expect(svm.getEntryTtl(dataKey(c.contractId, 'before', 'persistent'))).toBe(before);
  });

  it('refuses a zero TTL', () => {
    const L = new Ledger();
    expect(() =>
      L.setArchivalSettings({ minTemporaryTtl: 0, minPersistentTtl: 120_960, maxEntryTtl: 3_110_400 }),
    ).toThrow(/at least 1/);
    expect(L.archivalSettings).toEqual(TESTNET_ARCHIVAL_SETTINGS);
  });
});
