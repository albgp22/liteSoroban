/**
 * Network state-archival settings: the TTL a new entry starts with and the
 * longest TTL any entry can reach, from the `ConfigSettingStateArchival`
 * ledger entry.
 *
 * The harness runs testnet's by default, the network its default passphrase
 * names. `loadArchivalSettingsFromRpc` reads any node's own, the way
 * `loadCostParamsFromRpc` reads its cost tables.
 */
import { xdr, rpc } from '@stellar/stellar-sdk';

export interface ArchivalSettings {
  /** minTemporaryTTL: a new temporary entry lives until `ledger + this - 1`. */
  minTemporaryTtl: number;
  /**
   * minPersistentTTL: the same for a new persistent entry or contract code,
   * and the TTL a RestoreFootprint or an auto-restore grants.
   */
  minPersistentTtl: number;
  /** maxEntryTTL: no TTL reaches past `ledger + this - 1`. */
  maxEntryTtl: number;
}

/**
 * Testnet's, read with getLedgerEntries from soroban-testnet.stellar.org on
 * 2026-10-18 (ledger 5,264,566; the entry was last modified at ledger 2,332).
 * A local stellar/quickstart (core 29.0.0, rpc 29.0.1) carries the same three,
 * since it applies testnet's settings upgrade.
 */
export const TESTNET_ARCHIVAL_SETTINGS: Readonly<ArchivalSettings> = Object.freeze({
  minTemporaryTtl: 720,
  minPersistentTtl: 120_960,
  maxEntryTtl: 3_110_400,
});

/**
 * Read the state-archival TTLs off a live node. Point this at mainnet, testnet,
 * or a local quickstart — whichever network the TTLs need to match.
 */
export async function loadArchivalSettingsFromRpc(server: rpc.Server): Promise<ArchivalSettings> {
  const res = await server.getLedgerEntries(
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({
        configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
      }),
    ),
  );
  const data = res.entries[0]?.val;
  const cs = data?.type === 'configSetting' ? data.configSetting : null;
  if (!cs || cs.type !== 'configSettingStateArchival') {
    throw new Error(
      'node returned no ConfigSettingStateArchival entry — is it running Soroban?',
    );
  }
  const s = cs.stateArchivalSettings;
  return {
    minTemporaryTtl: s.minTemporaryTtl,
    minPersistentTtl: s.minPersistentTtl,
    maxEntryTtl: s.maxEntryTtl,
  };
}
