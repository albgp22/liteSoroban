/**
 * THROWAWAY SPIKE — thin TypeScript ergonomics over the wasm Soroban host.
 *
 * This is deliberately NOT the eventual harness API. It exists to answer two
 * questions: does wasm-pack produce a usable npm module from soroban-env-host,
 * and does the enforcing apply path work end to end with state that persists
 * between transactions.
 */
import { createRequire } from 'node:module';
import { xdr, Networks, hash as sha256 } from '@stellar/stellar-sdk';
import { applyTransaction, fundAccount as classicFundAccount } from './classic.js';
import type { TxOutcome, FundOptions } from './classic.js';

const require = createRequire(import.meta.url);
// wasm-pack --target nodejs emits CommonJS.
const wasm = require('../pkg/soroban_host.js');

/** The protocol version the pinned soroban-env-host actually implements. */
export const HOST_PROTOCOL: number = wasm.hostProtocolVersion();

export interface FootprintSimulation {
  ok: boolean;
  error?: string;
  /** `SorobanResources` XDR, when ok. */
  resourcesXdr?: string;
}

export interface SimulateResult {
  ok: boolean;
  error?: string;
  returnValueXdr?: string;
  resourcesXdr: string;
  authXdr: string[];
  restoredRwEntryIndices: number[];
  instructions: number;
  readBytes: number;
  writeBytes: number;
  cpuInsns: bigint;
  memBytes: bigint;
  readOnlyKeys: string[];
  readWriteKeys: string[];
  eventsXdr: string[];
  /** Host diagnostics: fn_call, fn_return, error, contract events. Always present. */
  diagnosticEventsXdr: string[];
  /** Instruction count padded the way stellar-rpc pads it; this is in resourcesXdr. */
  adjustedInstructions: number;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  returnValueXdr?: string;
  changedKeys: string[];
  removedKeys: string[];
  eventsXdr: string[];
  diagnosticEventsXdr: string[];
  cpuInsns: bigint;
  memBytes: bigint;
  /** Entries that only had their TTL bumped — invisible in changedKeys. */
  ttlChangedKeys: string[];
}

export class Ledger {
  private env: any;
  /** Defaults to testnet's, so an app configured for testnet needs no change. */
  readonly networkPassphrase: string;

  constructor(
    opts: { protocolVersion?: number; ledgerSeq?: number; networkPassphrase?: string } = {},
  ) {
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
    const want = opts.protocolVersion ?? HOST_PROTOCOL;
    if (want !== HOST_PROTOCOL) {
      // Fail loudly rather than silently simulating the wrong protocol —
      // this is the failure mode that makes a harness worse than useless.
      throw new Error(
        `pinned soroban-env-host implements protocol ${HOST_PROTOCOL}, but protocol ${want} was requested`,
      );
    }
    this.env = new wasm.SorobanEnv(want, opts.ledgerSeq ?? 1_000_000);
    // Keep the host's network id in step with the passphrase, or every
    // custom-account __check_auth will reject a correctly signed payload.
    this.env.setNetworkId(sha256(this.networkPassphrase));
  }

  get protocolVersion(): number {
    return this.env.protocolVersion;
  }
  get ledgerSeq(): number {
    return this.env.ledgerSeq;
  }
  advanceLedgers(n: number): void {
    this.env.advanceLedgers(n);
  }
  entryCount(): number {
    return this.env.entryCount();
  }

  /**
   * Install a network's cost calibration. The pinned host already meters with
   * the protocol-27 table this repo ships, so this changes no count until a
   * network's table moves away from it; use it to match a specific network.
   */
  setCostParams(cpuParamsB64: string, memParamsB64: string, cpuLimit: bigint, memLimit: bigint): void {
    this.env.setCostParams(cpuParamsB64, memParamsB64, cpuLimit, memLimit);
  }

  get hasNetworkCostParams(): boolean {
    return this.env.hasNetworkCostParams;
  }

  /**
   * Cap `send()` at the instruction count the transaction DECLARES, the way
   * stellar-core does. On by default: a transaction whose simulation recorded
   * less work than it then does (state that grew in between, or an unsigned
   * custom-account call whose `__check_auth` was never run) fails with
   * `Error(Budget, ExceededLimit)` instead of the host's more specific error.
   * Pass `false` to see that error, or to send resources whose instruction count
   * you do not control. The cap is the smaller of the declared count and the
   * `cpuLimit` given to `setCostParams`.
   */
  enforceDeclaredResources(on: boolean): void {
    this.env.enforceDeclaredResources(on);
  }

  /** Hash of the ENTIRE ledger. Equal hashes mean byte-identical state. */
  stateHash(): string {
    return this.env.stateHash();
  }

  /** Every LedgerKey in the ledger, base64, in key order. */
  allKeys(): string[] {
    return this.env.allKeys();
  }

  get timestamp(): number {
    return Number(this.env.timestamp);
  }
  setTimestamp(t: number | bigint): void {
    this.env.setTimestamp(BigInt(t));
  }

  /** Requirement 5: a funded account, with no network and no friendbot. */
  fundAccount(seed: number): string {
    return this.env.fundAccount(seed);
  }

  /**
   * Requirement 5, the version you actually want: a funded account for a real
   * keypair, so its transactions can be signed and the signature checked.
   */
  fund(publicKey: string, opts: FundOptions = {}): void {
    classicFundAccount(this, publicKey, opts);
  }

  /** General ledger-entry write — the classic layer builds AccountEntry XDR. */
  putEntry(entryB64: string, liveUntil?: number): string {
    return this.env.putEntry(entryB64, liveUntil);
  }
  removeEntry(keyB64: string): boolean {
    return this.env.removeEntry(keyB64);
  }

  /**
   * Requirement 1, for real: submit a signed transaction envelope. Validates
   * envelope shape, sequence number, timebounds, signature weights and fees
   * before dispatching the operation to the host.
   */
  sendTransaction(envelopeB64: string): TxOutcome {
    return applyTransaction(this, envelopeB64, this.networkPassphrase);
  }

  /** Requirement 5: contract code present in the ledger before any test runs. */
  seedWasm(bytes: Uint8Array): string {
    return this.env.seedWasm(bytes);
  }

  getEntry(keyB64: string): string | undefined {
    return this.env.getEntry(keyB64);
  }
  getEntryTtl(keyB64: string): number | undefined {
    return this.env.getEntryTtl(keyB64);
  }

  /** The state-archival settings the host runs with. */
  get archivalSettings(): { minTemporaryTtl: number; minPersistentTtl: number; maxEntryTtl: number } {
    const [minTemporaryTtl, minPersistentTtl, maxEntryTtl] = this.env.archivalSettings();
    return { minTemporaryTtl, minPersistentTtl, maxEntryTtl };
  }

  /**
   * stellar-rpc's preflight for ExtendFootprintTTL / RestoreFootprint
   * (soroban-simulation's simulate_extend_ttl_op / simulate_restore_op): the
   * SorobanResources to submit, or the reason there are none.
   */
  simulateExtendTtl(keysB64: string[], extendTo: number): FootprintSimulation {
    return this.env.simulateExtendTtl(keysB64, extendTo);
  }
  simulateRestore(keysB64: string[]): FootprintSimulation {
    return this.env.simulateRestore(keysB64);
  }

  /** Requirement 4: isolation. */
  snapshot(): number {
    return this.env.snapshot();
  }
  restore(id: number): void {
    this.env.restore(id);
  }

  /**
   * Requirement 2. Records auth; does NOT run a custom account's __check_auth.
   * `instructionLeeway` is stellar-rpc's `resourceConfig.instructionLeeway`: the
   * returned instructions are padded by max(50_000, leeway), or x1.04 if larger.
   */
  simulate(hostFn: xdr.HostFunction, sourceB64: string, instructionLeeway?: number): SimulateResult {
    return this.env.simulate(hostFn.toXDR('base64'), sourceB64, instructionLeeway);
  }

  /**
   * Re-simulate with signed auth entries under ENFORCING auth. Required for
   * custom accounts: only this pass actually runs `__check_auth`, so only this
   * pass records the ledger entries it reads into the footprint.
   */
  simulateWithAuth(
    hostFn: xdr.HostFunction,
    sourceB64: string,
    authB64: string[],
    instructionLeeway?: number,
  ): SimulateResult {
    return this.env.simulateWithAuth(hostFn.toXDR('base64'), sourceB64, authB64, instructionLeeway);
  }

  /** Requirement 1. */
  send(
    hostFn: xdr.HostFunction,
    sourceB64: string,
    resourcesB64: string,
    authB64: string[],
    restored: number[] = [],
  ): SendResult {
    return this.env.send(
      hostFn.toXDR('base64'),
      sourceB64,
      resourcesB64,
      authB64,
      Uint32Array.from(restored),
    );
  }

  /** simulate -> send, the shape an app's submit path actually takes. */
  simulateAndSend(hostFn: xdr.HostFunction, sourceB64: string): { sim: SimulateResult; sent: SendResult } {
    const sim = this.simulate(hostFn, sourceB64);
    if (!sim.ok) throw new Error(`simulation failed: ${sim.error}`);
    const sent = this.send(hostFn, sourceB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    return { sim, sent };
  }
}

// -- host function builders -------------------------------------------------

export function accountScAddress(accountIdB64: string): xdr.ScAddress {
  return xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.fromXDR(accountIdB64, 'base64'));
}

export function uploadWasmHostFn(code: Uint8Array): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from(code));
}

export function createContractHostFn(
  deployerB64: string,
  wasmHashB64: string,
  salt: Buffer = Buffer.alloc(32),
  constructorArgs: xdr.ScVal[] = [],
): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: accountScAddress(deployerB64),
          salt,
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(
        Buffer.from(wasmHashB64, 'base64'),
      ),
      constructorArgs,
    }),
  );
}

export function invokeHostFn(
  contractAddress: xdr.ScAddress,
  fn: string,
  args: xdr.ScVal[],
): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress,
      functionName: fn,
      args,
    }),
  );
}
