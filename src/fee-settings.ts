/**
 * A network's Soroban fee settings: what its `ConfigSetting` entries say a
 * resource costs. The classic layer charges with them and the RPC facade quotes
 * `minResourceFee` with them; the arithmetic itself is soroban-env-host's
 * `fees` module, the same code stellar-core and stellar-rpc run.
 *
 * Fees are a network parameter, not a protocol constant: testnet's rates are
 * half a local stellar/quickstart's, and the rent rate follows each network's
 * live Soroban state size. Install the network you are testing against with
 * `loadFeeSettingsFromRpc`.
 */
import { xdr, rpc } from '@stellar/stellar-sdk';

/** Field for field the `ConfigSetting` values stellar-core's SorobanNetworkConfig reads. */
export interface NetworkFeeSettings {
  /** CONFIG_SETTING_CONTRACT_COMPUTE_V0 */
  feeRatePerInstructionsIncrement: number;
  /** CONFIG_SETTING_CONTRACT_LEDGER_COST_V0 */
  feeDiskReadLedgerEntry: number;
  feeWriteLedgerEntry: number;
  feeDiskRead1kb: number;
  sorobanStateTargetSizeBytes: number;
  rentFee1kbSorobanStateSizeLow: number;
  rentFee1kbSorobanStateSizeHigh: number;
  sorobanStateRentFeeGrowthFactor: number;
  /** CONFIG_SETTING_CONTRACT_LEDGER_COST_EXT_V0 */
  feeWrite1kb: number;
  /** CONFIG_SETTING_CONTRACT_HISTORICAL_DATA_V0 */
  feeHistorical1kb: number;
  /** CONFIG_SETTING_CONTRACT_EVENTS_V0 */
  txMaxContractEventsSizeBytes: number;
  feeContractEvents1kb: number;
  /** CONFIG_SETTING_CONTRACT_BANDWIDTH_V0 */
  feeTxSize1kb: number;
  /** CONFIG_SETTING_STATE_ARCHIVAL */
  persistentRentRateDenominator: number;
  tempRentRateDenominator: number;
  /**
   * CONFIG_SETTING_LIVE_SOROBAN_STATE_SIZE_WINDOW, averaged with integer
   * division as core does. Sets the rent rate: below ~2.67 GB of state it is
   * the 1,000-stroop floor per KB.
   */
  averageSorobanStateSize: number;
}

/**
 * Testnet's, read with getLedgerEntries from soroban-testnet.stellar.org on
 * 2026-10-18 at ledger 5,264,749 (protocol 29). Its live state then averaged
 * 3.72 GB, so rent costs 8,083 stroops per KB-period, not the floor.
 */
export const TESTNET_FEE_SETTINGS: NetworkFeeSettings = {
  feeRatePerInstructionsIncrement: 3,
  feeDiskReadLedgerEntry: 781,
  feeWriteLedgerEntry: 1250,
  feeDiskRead1kb: 223,
  sorobanStateTargetSizeBytes: 4_000_000_000,
  rentFee1kbSorobanStateSizeLow: -17_000,
  rentFee1kbSorobanStateSizeHigh: 10_000,
  sorobanStateRentFeeGrowthFactor: 5000,
  feeWrite1kb: 437,
  feeHistorical1kb: 2029,
  txMaxContractEventsSizeBytes: 16_384,
  feeContractEvents1kb: 2500,
  feeTxSize1kb: 203,
  persistentRentRateDenominator: 1215,
  tempRentRateDenominator: 2430,
  averageSorobanStateSize: 3_715_978_052,
};

const ID = xdr.ConfigSettingId;
const SETTINGS = [
  ID.configSettingContractComputeV0(),
  ID.configSettingContractLedgerCostV0(),
  ID.configSettingContractLedgerCostExtV0(),
  ID.configSettingContractHistoricalDataV0(),
  ID.configSettingContractEventsV0(),
  ID.configSettingContractBandwidthV0(),
  ID.configSettingStateArchival(),
  ID.configSettingLiveSorobanStateSizeWindow(),
];

/**
 * Read a network's fee settings off a live node: mainnet, testnet or a local
 * quickstart, whichever the numbers need to match.
 */
export async function loadFeeSettingsFromRpc(server: rpc.Server): Promise<NetworkFeeSettings> {
  const res = await server.getLedgerEntries(
    ...SETTINGS.map((configSettingId) =>
      xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId })),
    ),
  );
  const n = (v: { toString(): string } | number) => Number(v.toString());
  const out: Partial<NetworkFeeSettings> = {};
  for (const e of res.entries) {
    const cs = e.val.configSetting();
    const v: any = cs.value();
    switch (cs.switch().name) {
      case 'configSettingContractComputeV0':
        out.feeRatePerInstructionsIncrement = n(v.feeRatePerInstructionsIncrement());
        break;
      case 'configSettingContractLedgerCostV0':
        out.feeDiskReadLedgerEntry = n(v.feeDiskReadLedgerEntry());
        out.feeWriteLedgerEntry = n(v.feeWriteLedgerEntry());
        out.feeDiskRead1kb = n(v.feeDiskRead1Kb());
        out.sorobanStateTargetSizeBytes = n(v.sorobanStateTargetSizeBytes());
        out.rentFee1kbSorobanStateSizeLow = n(v.rentFee1KbSorobanStateSizeLow());
        out.rentFee1kbSorobanStateSizeHigh = n(v.rentFee1KbSorobanStateSizeHigh());
        out.sorobanStateRentFeeGrowthFactor = n(v.sorobanStateRentFeeGrowthFactor());
        break;
      case 'configSettingContractLedgerCostExtV0':
        out.feeWrite1kb = n(v.feeWrite1Kb());
        break;
      case 'configSettingContractHistoricalDataV0':
        out.feeHistorical1kb = n(v.feeHistorical1Kb());
        break;
      case 'configSettingContractEventsV0':
        out.txMaxContractEventsSizeBytes = n(v.txMaxContractEventsSizeBytes());
        out.feeContractEvents1kb = n(v.feeContractEvents1Kb());
        break;
      case 'configSettingContractBandwidthV0':
        out.feeTxSize1kb = n(v.feeTxSize1Kb());
        break;
      case 'configSettingStateArchival':
        out.persistentRentRateDenominator = n(v.persistentRentRateDenominator());
        out.tempRentRateDenominator = n(v.tempRentRateDenominator());
        break;
      case 'configSettingLiveSorobanStateSizeWindow': {
        const sizes = (v as { toString(): string }[]).map((s) => BigInt(s.toString()));
        if (sizes.length === 0) throw new Error('live Soroban state size window is empty');
        out.averageSorobanStateSize = Number(sizes.reduce((a, b) => a + b, 0n) / BigInt(sizes.length));
        break;
      }
    }
  }
  const missing = Object.keys(TESTNET_FEE_SETTINGS).filter((k) => !(k in out));
  if (missing.length > 0) {
    throw new Error(`node returned no fee setting for ${missing.join(', ')}: is it running protocol 23+?`);
  }
  return out as NetworkFeeSettings;
}
