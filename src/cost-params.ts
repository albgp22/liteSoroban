/**
 * Network cost calibration.
 *
 * Up to 27.0.1, `soroban-env-host`'s `Budget::default()` was byte-for-byte
 * stellar-core's `initialCpuCostParamsEntryForV20` — the table a network carries
 * only until its first settings upgrade — and the harness over-metered by
 * 15-249% until a real table was installed. 28.0.0 replaced those defaults with
 * the live network's calibration (`ValDeser` const_term 331, not 59,052), and
 * on the pinned 29.0.2 every CPU and memory entry equals the protocol-27 table
 * shipped here, so installing it changes no count.
 *
 * Install a table when a network's calibration moves away from the host's
 * defaults: `loadCostParamsFromRpc` reads the live one.
 *
 * A table prices work; it does not cap it. The caps are the network's
 * `txMaxInstructions` and `txMemoryLimit`, which live in the fee settings
 * (src/fee-settings.ts) and bound simulation and apply alike.
 */
import { xdr, rpc } from '@stellar/stellar-sdk';
import protocol27 from './costparams/protocol27.json' with { type: 'json' };

export interface CostParams {
  /** base64 `ContractCostParams` XDR */
  cpuInstructions: string;
  /** base64 `ContractCostParams` XDR */
  memoryBytes: string;
  /**
   * The network's `txMaxInstructions` (ContractComputeV0), as
   * `loadCostParamsFromRpc` reads it. Given, installing these params writes it
   * into the fee settings, the one place the ceiling lives.
   */
  cpuLimit?: bigint;
  /** The network's `txMemoryLimit`, in bytes; written through like `cpuLimit`. */
  memLimit?: bigint;
}

/**
 * soroban-env-host's own default budget limits (budget/limits.rs:45-46,
 * `DEFAULT_CPU_INSN_LIMIT` / `DEFAULT_MEM_BYTES_LIMIT`), which were this
 * harness's ceiling until it took the network's. Testnet and a local
 * quickstart allow 400M instructions and the same 40 MiB.
 */
export const P27_CPU_LIMIT = 100_000_000n;
export const P27_MEM_LIMIT = 41_943_040n;

/**
 * The calibration a protocol-27 stellar-core ships, captured from a
 * `stellar/quickstart` node's own `ConfigSetting` entries. Good enough to make
 * numbers transfer; read the live table with `loadCostParamsFromRpc` when you
 * need to be exact about a specific network at a specific time. It carries no
 * limits, so installing it leaves the fee settings' ceiling alone.
 */
export const PROTOCOL_27_COST_PARAMS: CostParams = {
  cpuInstructions: (protocol27 as any).cpuInstructions,
  memoryBytes: (protocol27 as any).memoryBytes,
};

function configSettingKey(id: xdr.ConfigSettingId): xdr.LedgerKey {
  return xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id }));
}

/** The `ContractCostParams` typedef: a length-prefixed `ContractCostParamEntry` array. */
function encodeParams(params: readonly xdr.ContractCostParamEntry[]): string {
  return xdr.encodeArray(xdr.ContractCostParamEntry, params, 'base64');
}

/**
 * Read the cost tables off a live node. Point this at mainnet, testnet, or a
 * local quickstart — whichever network the numbers need to match.
 */
export async function loadCostParamsFromRpc(server: rpc.Server): Promise<CostParams> {
  const res = await server.getLedgerEntries(
    configSettingKey(xdr.ConfigSettingId.configSettingContractCostParamsCpuInstructions),
    configSettingKey(xdr.ConfigSettingId.configSettingContractCostParamsMemoryBytes),
    configSettingKey(xdr.ConfigSettingId.configSettingContractComputeV0),
  );

  let cpuInstructions: string | undefined;
  let memoryBytes: string | undefined;
  let cpuLimit: bigint | undefined;
  let memLimit: bigint | undefined;

  for (const e of res.entries) {
    const cs = xdr.expectUnionVariant(e.val, 'configSetting').configSetting;
    if (cs.type === 'configSettingContractCostParamsCpuInstructions') {
      cpuInstructions = encodeParams(cs.contractCostParamsCpuInsns);
    } else if (cs.type === 'configSettingContractCostParamsMemoryBytes') {
      memoryBytes = encodeParams(cs.contractCostParamsMemBytes);
    } else if (cs.type === 'configSettingContractComputeV0') {
      cpuLimit = cs.contractCompute.txMaxInstructions;
      memLimit = BigInt(cs.contractCompute.txMemoryLimit);
    }
  }

  if (!cpuInstructions || !memoryBytes) {
    throw new Error(
      'node returned no ContractCostParams ConfigSetting entries — is it running Soroban?',
    );
  }
  return { cpuInstructions, memoryBytes, cpuLimit, memLimit };
}
