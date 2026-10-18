/**
 * The fee settings and limits of the local stellar/quickstart (stellar-core
 * 29.0.0, protocol 29) the live comparisons ran against, as
 * loadFeeSettingsFromRpc read them on 2026-10-18. Not a test file.
 */
import type { NetworkFeeSettings } from '../src/litestellar.js';

/**
 * The local quickstart's fee settings, read at ledger 7,920; its limits, read at
 * ledger 9,968 (`txMemoryLimit` at 12,527), are testnet's.
 */
export const QUICKSTART: NetworkFeeSettings = {
  feeRatePerInstructionsIncrement: 7,
  txMaxInstructions: 400_000_000,
  txMemoryLimit: 41_943_040,
  txMaxDiskReadEntries: 200,
  txMaxDiskReadBytes: 200_000,
  txMaxWriteLedgerEntries: 200,
  txMaxWriteBytes: 132_096,
  feeDiskReadLedgerEntry: 1563,
  feeWriteLedgerEntry: 2500,
  feeDiskRead1kb: 447,
  sorobanStateTargetSizeBytes: 4_000_000_000,
  rentFee1kbSorobanStateSizeLow: -17_000,
  rentFee1kbSorobanStateSizeHigh: 10_000,
  sorobanStateRentFeeGrowthFactor: 5000,
  txMaxFootprintEntries: 400,
  feeWrite1kb: 875,
  feeHistorical1kb: 4059,
  txMaxContractEventsSizeBytes: 16_384,
  feeContractEvents1kb: 5000,
  txMaxSizeBytes: 132_096,
  feeTxSize1kb: 406,
  maxContractSizeBytes: 131_072,
  maxContractDataKeySizeBytes: 250,
  maxContractDataEntrySizeBytes: 65_536,
  persistentRentRateDenominator: 1215,
  tempRentRateDenominator: 2430,
  averageSorobanStateSize: 4_074_449,
};
