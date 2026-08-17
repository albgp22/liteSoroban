/**
 * Network cost calibration.
 *
 * `soroban-env-host`'s `Budget::default()` is byte-for-byte stellar-core's
 * `initialCpuCostParamsEntryForV20` — the table a network carries only until its
 * first settings upgrade. Every live network meters with the upgraded table in
 * `ConfigSettingContractCostParamsCpuInstructions`. 18 of 86 CPU entries differ,
 * dominated by `ValDeser` const_term 59,052 (host default) vs 331 (network), and
 * the harness over-meters by 15-249% until the real table is installed.
 *
 * Install one and instruction counts become comparable with a real node.
 */
import { xdr, rpc } from '@stellar/stellar-sdk';
import protocol27 from './costparams/protocol27.json' with { type: 'json' };

export interface CostParams {
  /** base64 `ContractCostParams` XDR */
  cpuInstructions: string;
  /** base64 `ContractCostParams` XDR */
  memoryBytes: string;
  /** Network instruction ceiling. */
  cpuLimit?: bigint;
  /** Network memory ceiling, in bytes. */
  memLimit?: bigint;
}

/** Mainnet's protocol-27 ledger limits. */
export const P27_CPU_LIMIT = 100_000_000n;
export const P27_MEM_LIMIT = 41_943_040n;

/**
 * The calibration a protocol-27 stellar-core ships, captured from a
 * `stellar/quickstart` node's own `ConfigSetting` entries. Good enough to make
 * numbers transfer; read the live table with `loadCostParamsFromRpc` when you
 * need to be exact about a specific network at a specific time.
 */
export const PROTOCOL_27_COST_PARAMS: CostParams = {
  cpuInstructions: (protocol27 as any).cpuInstructions,
  memoryBytes: (protocol27 as any).memoryBytes,
  cpuLimit: P27_CPU_LIMIT,
  memLimit: P27_MEM_LIMIT,
};

function configSettingKey(id: xdr.ConfigSettingId): xdr.LedgerKey {
  return xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id }));
}

/**
 * js-xdr cannot serialise the `ContractCostParams` typedef on its own
 * ("value is not array"), so wrap it back into its `ConfigSettingEntry` arm and
 * drop the 4-byte union discriminant.
 */
function encodeParams(arm: string, params: unknown): string {
  const entry = (xdr.ConfigSettingEntry as any)[arm](params) as xdr.ConfigSettingEntry;
  return Buffer.from(entry.toXDR().subarray(4)).toString('base64');
}

/**
 * Read the cost tables off a live node. Point this at mainnet, testnet, or a
 * local quickstart — whichever network the numbers need to match.
 */
export async function loadCostParamsFromRpc(server: rpc.Server): Promise<CostParams> {
  const CPU = 'configSettingContractCostParamsCpuInstructions';
  const MEM = 'configSettingContractCostParamsMemoryBytes';
  const COMPUTE = 'configSettingContractComputeV0';

  const res = await server.getLedgerEntries(
    configSettingKey(xdr.ConfigSettingId.configSettingContractCostParamsCpuInstructions()),
    configSettingKey(xdr.ConfigSettingId.configSettingContractCostParamsMemoryBytes()),
    configSettingKey(xdr.ConfigSettingId.configSettingContractComputeV0()),
  );

  let cpuInstructions: string | undefined;
  let memoryBytes: string | undefined;
  let cpuLimit: bigint | undefined;
  let memLimit: bigint | undefined;

  for (const e of res.entries) {
    const cs = e.val.configSetting();
    const arm = cs.switch().name;
    if (arm === CPU) cpuInstructions = encodeParams(CPU, cs.value());
    else if (arm === MEM) memoryBytes = encodeParams(MEM, cs.value());
    else if (arm === COMPUTE) {
      const c: any = cs.value();
      cpuLimit = BigInt(c.txMaxInstructions().toString());
      memLimit = BigInt(c.txMemoryLimit().toString());
    }
  }

  if (!cpuInstructions || !memoryBytes) {
    throw new Error(
      'node returned no ContractCostParams ConfigSetting entries — is it running Soroban?',
    );
  }
  return { cpuInstructions, memoryBytes, cpuLimit, memLimit };
}
