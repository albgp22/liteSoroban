/**
 * A network's Soroban fee settings: what its `ConfigSetting` entries say a
 * resource costs, and how much of each one a transaction may use. The classic
 * layer charges and enforces with them and the RPC facade quotes
 * `minResourceFee` with them; the fee arithmetic itself is soroban-env-host's
 * `fees` module, the same code stellar-core and stellar-rpc run.
 *
 * `txMaxInstructions` and `txMemoryLimit` are also the host's budget: a
 * simulation runs under them, as stellar-rpc's preflight does
 * (soroban-simulation `NetworkConfig::create_budget`), and an applied
 * transaction under its declared instructions and `txMemoryLimit`, as
 * stellar-core does. They are the only copy of those limits in the harness.
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
  /** Refused above at submission; the ceiling of every simulation. */
  txMaxInstructions: number;
  /** Bytes of host memory a transaction may use, simulated or applied. */
  txMemoryLimit: number;
  /** CONFIG_SETTING_CONTRACT_LEDGER_COST_V0 */
  txMaxDiskReadEntries: number;
  txMaxDiskReadBytes: number;
  txMaxWriteLedgerEntries: number;
  txMaxWriteBytes: number;
  feeDiskReadLedgerEntry: number;
  feeWriteLedgerEntry: number;
  feeDiskRead1kb: number;
  sorobanStateTargetSizeBytes: number;
  rentFee1kbSorobanStateSizeLow: number;
  rentFee1kbSorobanStateSizeHigh: number;
  sorobanStateRentFeeGrowthFactor: number;
  /** CONFIG_SETTING_CONTRACT_LEDGER_COST_EXT_V0 */
  txMaxFootprintEntries: number;
  feeWrite1kb: number;
  /** CONFIG_SETTING_CONTRACT_HISTORICAL_DATA_V0 */
  feeHistorical1kb: number;
  /** CONFIG_SETTING_CONTRACT_EVENTS_V0 */
  txMaxContractEventsSizeBytes: number;
  feeContractEvents1kb: number;
  /** CONFIG_SETTING_CONTRACT_BANDWIDTH_V0 */
  txMaxSizeBytes: number;
  feeTxSize1kb: number;
  /** CONFIG_SETTING_CONTRACT_MAX_SIZE_BYTES: a ContractCode entry's XDR size. */
  maxContractSizeBytes: number;
  /** CONFIG_SETTING_CONTRACT_DATA_KEY_SIZE_BYTES: any footprint key's XDR size. */
  maxContractDataKeySizeBytes: number;
  /** CONFIG_SETTING_CONTRACT_DATA_ENTRY_SIZE_BYTES: a ContractData entry's XDR size. */
  maxContractDataEntrySizeBytes: number;
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
 * 2026-10-18 at ledger 5,264,749 (protocol 29); the limits at ledger
 * 5,265,020 the same day, `txMemoryLimit` at 5,265,532 (ContractComputeV0 last
 * modified at 5,194,532). Its live state then averaged 3.72 GB, so rent costs
 * 8,083 stroops per KB-period, not the floor. A local stellar/quickstart's
 * limits were the same, apart from the ledger-wide ones this harness does not
 * model.
 */
export const TESTNET_FEE_SETTINGS: NetworkFeeSettings = {
  feeRatePerInstructionsIncrement: 3,
  txMaxInstructions: 400_000_000,
  txMemoryLimit: 41_943_040,
  txMaxDiskReadEntries: 200,
  txMaxDiskReadBytes: 200_000,
  txMaxWriteLedgerEntries: 200,
  txMaxWriteBytes: 132_096,
  feeDiskReadLedgerEntry: 781,
  feeWriteLedgerEntry: 1250,
  feeDiskRead1kb: 223,
  sorobanStateTargetSizeBytes: 4_000_000_000,
  rentFee1kbSorobanStateSizeLow: -17_000,
  rentFee1kbSorobanStateSizeHigh: 10_000,
  sorobanStateRentFeeGrowthFactor: 5000,
  txMaxFootprintEntries: 400,
  feeWrite1kb: 437,
  feeHistorical1kb: 2029,
  txMaxContractEventsSizeBytes: 16_384,
  feeContractEvents1kb: 2500,
  txMaxSizeBytes: 132_096,
  feeTxSize1kb: 203,
  maxContractSizeBytes: 131_072,
  maxContractDataKeySizeBytes: 250,
  maxContractDataEntrySizeBytes: 65_536,
  persistentRentRateDenominator: 1215,
  tempRentRateDenominator: 2430,
  averageSorobanStateSize: 3_715_978_052,
};

const ID = xdr.ConfigSettingId;
const SETTINGS = [
  ID.configSettingContractComputeV0,
  ID.configSettingContractLedgerCostV0,
  ID.configSettingContractLedgerCostExtV0,
  ID.configSettingContractHistoricalDataV0,
  ID.configSettingContractEventsV0,
  ID.configSettingContractBandwidthV0,
  ID.configSettingContractMaxSizeBytes,
  ID.configSettingContractDataKeySizeBytes,
  ID.configSettingContractDataEntrySizeBytes,
  ID.configSettingStateArchival,
  ID.configSettingLiveSorobanStateSizeWindow,
];

/**
 * Read a network's fee settings and limits off a live node: mainnet, testnet
 * or a local quickstart, whichever the numbers need to match.
 */
export async function loadFeeSettingsFromRpc(server: rpc.Server): Promise<NetworkFeeSettings> {
  const res = await server.getLedgerEntries(
    ...SETTINGS.map((configSettingId) =>
      xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId })),
    ),
  );
  const n = (v: bigint | number) => Number(v);
  const out: Partial<NetworkFeeSettings> = {};
  for (const e of res.entries) {
    const cs = xdr.expectUnionVariant(e.val, 'configSetting').configSetting;
    const v: any = cs.value;
    switch (cs.type) {
      case 'configSettingContractComputeV0':
        out.feeRatePerInstructionsIncrement = n(v.feeRatePerInstructionsIncrement);
        out.txMaxInstructions = n(v.txMaxInstructions);
        out.txMemoryLimit = n(v.txMemoryLimit);
        break;
      case 'configSettingContractLedgerCostV0':
        out.txMaxDiskReadEntries = n(v.txMaxDiskReadEntries);
        out.txMaxDiskReadBytes = n(v.txMaxDiskReadBytes);
        out.txMaxWriteLedgerEntries = n(v.txMaxWriteLedgerEntries);
        out.txMaxWriteBytes = n(v.txMaxWriteBytes);
        out.feeDiskReadLedgerEntry = n(v.feeDiskReadLedgerEntry);
        out.feeWriteLedgerEntry = n(v.feeWriteLedgerEntry);
        out.feeDiskRead1kb = n(v.feeDiskRead1Kb);
        out.sorobanStateTargetSizeBytes = n(v.sorobanStateTargetSizeBytes);
        out.rentFee1kbSorobanStateSizeLow = n(v.rentFee1KbSorobanStateSizeLow);
        out.rentFee1kbSorobanStateSizeHigh = n(v.rentFee1KbSorobanStateSizeHigh);
        out.sorobanStateRentFeeGrowthFactor = n(v.sorobanStateRentFeeGrowthFactor);
        break;
      case 'configSettingContractLedgerCostExtV0':
        out.txMaxFootprintEntries = n(v.txMaxFootprintEntries);
        out.feeWrite1kb = n(v.feeWrite1Kb);
        break;
      case 'configSettingContractHistoricalDataV0':
        out.feeHistorical1kb = n(v.feeHistorical1Kb);
        break;
      case 'configSettingContractEventsV0':
        out.txMaxContractEventsSizeBytes = n(v.txMaxContractEventsSizeBytes);
        out.feeContractEvents1kb = n(v.feeContractEvents1Kb);
        break;
      case 'configSettingContractBandwidthV0':
        out.txMaxSizeBytes = n(v.txMaxSizeBytes);
        out.feeTxSize1kb = n(v.feeTxSize1Kb);
        break;
      case 'configSettingContractMaxSizeBytes':
        out.maxContractSizeBytes = n(v);
        break;
      case 'configSettingContractDataKeySizeBytes':
        out.maxContractDataKeySizeBytes = n(v);
        break;
      case 'configSettingContractDataEntrySizeBytes':
        out.maxContractDataEntrySizeBytes = n(v);
        break;
      case 'configSettingStateArchival':
        out.persistentRentRateDenominator = n(v.persistentRentRateDenominator);
        out.tempRentRateDenominator = n(v.tempRentRateDenominator);
        break;
      case 'configSettingLiveSorobanStateSizeWindow': {
        const sizes = v as bigint[];
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
