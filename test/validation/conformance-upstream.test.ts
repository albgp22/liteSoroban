/**
 * Conformance against upstream `soroban-env-host` 27.0.1 e2e tests.
 *
 * GROUND TRUTH
 *   <scratch>/
 *     scratchpad/v27/soroban-env-host-27.0.1/src/test/e2e_tests.rs
 *   (helpers: ../../src/e2e_testutils.rs, ../../src/e2e_invoke.rs)
 *
 * Every expected number here is copied from that file, NOT read back from this
 * harness. The pinned host is 27.0.1; note that 28.0.1 has completely different
 * expectations for the same tests (e.g. 1528075 instead of 1767593 for the
 * ADD_I32 upload preflight), so numbers must come from the 27.0.1 file.
 *
 * SETUP FIDELITY
 *   `default_ledger_info()` (e2e_testutils.rs:106) is
 *     protocol 27, sequence_number 1_000_000, timestamp 12_345_678,
 *     network_id [5;32], base_reserve 5_000_000, min_temp_entry_ttl 16,
 *     min_persistent_entry_ttl 100_000, max_entry_ttl 10_000_000.
 *   crates/host-wasm/src/lib.rs hardcodes base_reserve and the three TTL
 *   constants to exactly those values, so only `timestamp` has to be set here.
 *
 *   NETWORK ID: `Ledger` overrides the host's DEFAULT_NETWORK_ID ([5;32]) with
 *   sha256(networkPassphrase) and offers no way back. That changes exactly one
 *   thing in these tests: the contract id, which is
 *   sha256(HashIDPreimage::ContractId{network_id, preimage}) — see
 *   e2e_testutils.rs:get_contract_id_hash. So contract addresses are recomputed
 *   here with the harness's network id, using upstream's formula. Instruction
 *   counts are unaffected (the preimage has the same shape and size either way),
 *   which the recording-mode tests below confirm by matching upstream exactly.
 *
 *   SOURCE ACCOUNT: upstream passes `get_account_id([123;32])` and an EMPTY
 *   ledger — the source account entry does not exist. `L.fundAccount()` would
 *   create it, so it is deliberately not used; the AccountId is built directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, hash as sha256 } from '@stellar/stellar-sdk';
import { Ledger, uploadWasmHostFn, invokeHostFn, accountScAddress } from '../../src/index.js';

// --- upstream wasm blobs ----------------------------------------------------
// soroban_test_wasms::{ADD_I32, ADD_F32, CONTRACT_STORAGE, LINEAR_MEMORY} are
// wasm-workspace/opt/20/{example_add_i32, example_add_f32,
// example_contract_data, example_linear_memory}.wasm. NOTE: the pre-existing
// test/fixtures/add_i32.wasm is opt/22 (ADD_I32_P22) and
// test/fixtures/contract_data.wasm is opt/26 (CONTRACT_STORAGE_P26) — different
// blobs, which would produce different instruction counts.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const ADD_I32 = fixture('e2e_add_i32.wasm');
const ADD_F32 = fixture('e2e_add_f32.wasm');
const SUM_I32 = fixture('e2e_sum_i32.wasm');
const CONTRACT_STORAGE = fixture('e2e_contract_storage.wasm');
const LINEAR_MEMORY = fixture('e2e_linear_memory.wasm');

// --- default_ledger_info() --------------------------------------------------
const DEFAULT_LEDGER_SEQ = 1_000_000;
const DEFAULT_TIMESTAMP = 12_345_678;
const MIN_TEMP_ENTRY_TTL = 16;
const MIN_PERSISTENT_ENTRY_TTL = 100_000;

function e2eLedger(): Ledger {
  const L = new Ledger({ ledgerSeq: DEFAULT_LEDGER_SEQ });
  L.setTimestamp(DEFAULT_TIMESTAMP);
  return L;
}

// --- e2e_testutils.rs ports -------------------------------------------------

/** `get_account_id([seed; 32])` */
function getAccountId(seed: number): xdr.AccountId {
  return xdr.AccountId.publicKeyTypeEd25519(Buffer.alloc(32, seed));
}
const SOURCE = getAccountId(123).toXDR('base64');

/** `get_wasm_hash(wasm)` */
const wasmHash = (code: Uint8Array) => sha256(Buffer.from(code));

/** `get_wasm_key(wasm)` */
function getWasmKey(code: Uint8Array): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHash(code) }),
  );
}
const b64 = (k: { toXDR(f: 'base64'): string }) => k.toXDR('base64');

/** `bytes_sc_val(&get_wasm_hash(wasm))` */
const wasmHashScVal = (code: Uint8Array) => xdr.ScVal.scvBytes(wasmHash(code));

/** `resources(instructions, ro_footprint, rw_footprint)` (e2e_tests.rs:67) */
function resources(
  instructions: number,
  readOnly: xdr.LedgerKey[],
  readWrite: xdr.LedgerKey[],
): string {
  return new xdr.SorobanResources({
    footprint: new xdr.LedgerFootprint({ readOnly, readWrite }),
    instructions,
    diskReadBytes: 0,
    writeBytes: 0,
  }).toXDR('base64');
}

/** `get_contract_id_preimage_from_address(address, salt)` */
function contractIdPreimage(address: xdr.ScAddress, salt: number): xdr.ContractIdPreimage {
  return xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({ address, salt: Buffer.alloc(32, salt) }),
  );
}

/**
 * `get_contract_id_hash(preimage)` — with the harness's network id rather than
 * the host's DEFAULT_NETWORK_ID; see the header note.
 */
function contractIdHash(networkId: Buffer, preimage: xdr.ContractIdPreimage): Buffer {
  return sha256(
    xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({ networkId, contractIdPreimage: preimage }),
    ).toXDR(),
  );
}

/** `ledger_entry(le_data)` — last_modified_ledger_seq 0, ext V0. */
function ledgerEntry(data: xdr.LedgerEntryData): xdr.LedgerEntry {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 0,
    data,
    ext: new xdr.LedgerEntryExt(0),
  });
}

/** `contract_data_key(contract, key, durability)` (e2e_tests.rs:705) */
function contractDataKey(
  contract: xdr.ScAddress,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract, key, durability }),
  );
}

/** `contract_data_entry(contract, key, val, durability)` (e2e_tests.rs:717) */
function contractDataEntry(
  contract: xdr.ScAddress,
  key: xdr.ScVal,
  val: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerEntry {
  return ledgerEntry(
    xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract,
        key,
        durability,
        val,
      }),
    ),
  );
}

const symbolScVal = (s: string) => xdr.ScVal.scvSymbol(s);
const u64ScVal = (v: bigint) => xdr.ScVal.scvU64(new xdr.Uint64(v));
const u32ScVal = (v: number) => xdr.ScVal.scvU32(v);

/** The `CreateContractData` struct of e2e_testutils.rs, for one Ledger. */
interface CreateContractData {
  deployer: string;
  wasmKey: xdr.LedgerKey;
  contractKey: xdr.LedgerKey;
  contractEntry: xdr.LedgerEntry;
  contractAddress: xdr.ScAddress;
  authEntry: xdr.SorobanAuthorizationEntry;
  hostFn: xdr.HostFunction;
}

function createContractData(L: Ledger, salt: number, code: Uint8Array): CreateContractData {
  const networkId = sha256(L.networkPassphrase);
  // `CreateContractData::new` always uses get_account_id([123; 32]) as source.
  const deployerAddress = accountScAddress(SOURCE);
  const preimage = contractIdPreimage(deployerAddress, salt);
  const executable = xdr.ContractExecutable.contractExecutableWasm(wasmHash(code));
  const contractAddress = xdr.ScAddress.scAddressTypeContract(
    contractIdHash(networkId, preimage),
  );

  // NOTE: upstream builds the V1 `HostFunction::CreateContract` here even
  // though the auth entry it expects is `CreateContractV2HostFn`; the host
  // normalises V1 into V2 for authorization. src/index.ts's
  // `createContractHostFn` only builds V2, so the V1 form is built by hand.
  const hostFn = xdr.HostFunction.hostFunctionTypeCreateContract(
    new xdr.CreateContractArgs({ contractIdPreimage: preimage, executable }),
  );

  const contractKey = contractDataKey(
    contractAddress,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ContractDataDurability.persistent(),
  );
  const contractEntry = contractDataEntry(
    contractAddress,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({ executable, storage: null }),
    ),
    xdr.ContractDataDurability.persistent(),
  );

  return {
    deployer: SOURCE,
    wasmKey: getWasmKey(code),
    contractKey,
    contractEntry,
    contractAddress,
    authEntry: createContractAuth(preimage, code),
    hostFn,
  };
}

/** `create_contract_auth(preimage, wasm)` — source-account credentials. */
function createContractAuth(
  preimage: xdr.ContractIdPreimage,
  code: Uint8Array,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
        new xdr.CreateContractArgsV2({
          contractIdPreimage: preimage,
          executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash(code)),
          constructorArgs: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** `invoke_contract_host_fn(contract, fn_name, args)` */
const invokeContractHostFn = invokeHostFn;

// --- harness plumbing -------------------------------------------------------

/**
 * Upstream passes `(LedgerEntry, Option<u32>)` pairs straight into the host.
 * The harness only accepts entries it can re-encode, and the ContractCode entry
 * upstream uses (`wasm_entry`, i.e. WITH refined cost inputs) cannot be built in
 * TypeScript. `seedWasm` calls that exact `e2e_testutils::wasm_entry` helper, so
 * seed then re-put with the TTL the upstream test wants.
 */
function putWasmEntry(L: Ledger, code: Uint8Array, liveUntil: number): string {
  L.seedWasm(code);
  const key = b64(getWasmKey(code));
  const entry = L.getEntry(key)!;
  L.putEntry(entry, liveUntil);
  return entry;
}

interface Outcome {
  ok: boolean;
  error?: string;
  returnValueXdr?: string;
  changedKeys: string[];
  removedKeys: string[];
  eventsXdr: string[];
  cpuInsns: bigint;
  threw: boolean;
}

/**
 * `invoke_host_function_helper`. Upstream distinguishes a thrown `HostError`
 * (the whole invocation could not run — e.g. the budget was exhausted decoding
 * the inputs) from `Ok(res)` with `res.invoke_result` being `Err`. The harness
 * turns the former into a thrown JsError, so both are normalised here.
 */
function send(
  L: Ledger,
  hostFn: xdr.HostFunction,
  source: string,
  res: string,
  auth: xdr.SorobanAuthorizationEntry[] = [],
  restored: number[] = [],
): Outcome {
  try {
    const r = L.send(hostFn, source, res, auth.map((a) => a.toXDR('base64')), restored);
    return { ...r, threw: false };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error).message ?? e),
      changedKeys: [],
      removedKeys: [],
      eventsXdr: [],
      cpuInsns: 0n,
      threw: true,
    };
  }
}

/** `HostError::result_matches_err(res, (ScErrorType::X, ScErrorCode::Y))` */
function expectHostError(o: { ok: boolean; error?: string }, type: string, code: string) {
  expect(o.ok, `expected Error(${type}, ${code}), got success`).toBe(false);
  expect(o.error ?? '').toMatch(new RegExp(`Error\\(${type}, ${code}\\)`));
}

const scValEq = (b: string | undefined, v: xdr.ScVal) => expect(b).toBe(v.toXDR('base64'));

// ===========================================================================
describe('upstream e2e_tests.rs :: wasm upload', () => {
  // e2e_tests.rs:786 test_wasm_upload_success
  it('test_wasm_upload_success', () => {
    const L = e2eLedger();
    const ledgerKey = getWasmKey(ADD_I32);

    const res = send(L, uploadWasmHostFn(ADD_I32), SOURCE, resources(10_000_000, [], [ledgerKey]));

    expect(res.ok, res.error).toBe(true);
    expect(res.eventsXdr).toEqual([]); // res.contract_events.is_empty()
    scValEq(res.returnValueXdr, wasmHashScVal(ADD_I32));

    // ledger_changes == [one RW change, new_value = wasm_entry(ADD_I32),
    //                    ttl 0 -> seq + min_persistent_entry_ttl - 1]
    expect(res.changedKeys).toEqual([b64(ledgerKey)]);
    expect(res.removedKeys).toEqual([]);
    expect(L.getEntryTtl(b64(ledgerKey))).toBe(
      DEFAULT_LEDGER_SEQ + MIN_PERSISTENT_ENTRY_TTL - 1,
    );

    // `new_value: Some(wasm_entry(ADD_I32))`. `wasm_entry` is the same
    // e2e_testutils helper `seedWasm` calls, so a reference ledger gives the
    // exact expected bytes (including the V1 refined cost inputs).
    const reference = e2eLedger();
    reference.seedWasm(ADD_I32);
    expect(L.getEntry(b64(ledgerKey))).toBe(reference.getEntry(b64(ledgerKey)));

    expect(res.cpuInsns > 0n).toBe(true);
  });

  // e2e_tests.rs:855 test_wasm_upload_success_in_recording_mode
  it('test_wasm_upload_success_in_recording_mode', () => {
    const L = e2eLedger();
    const ledgerKey = getWasmKey(ADD_I32);

    const sim = L.simulate(uploadWasmHostFn(ADD_I32), SOURCE);

    expect(sim.ok, sim.error).toBe(true);
    expect(sim.eventsXdr).toEqual([]);
    scValEq(sim.returnValueXdr, wasmHashScVal(ADD_I32));
    expect(sim.authXdr).toEqual([]);

    expect(sim.instructions).toBe(1767593); // expect!["1767593"]
    expect(sim.writeBytes).toBe(684); //       expect!["684"]
    expect(sim.readBytes).toBe(0); //          disk_read_bytes: 0
    expect(sim.readOnlyKeys).toEqual([]);
    expect(sim.readWriteKeys).toEqual([b64(ledgerKey)]);
  });

  // e2e_tests.rs:829 test_wasm_upload_failure_due_to_unsupported_wasm_features
  it('test_wasm_upload_failure_due_to_unsupported_wasm_features', () => {
    const L = e2eLedger();
    const res = send(
      L,
      uploadWasmHostFn(ADD_F32),
      SOURCE,
      resources(10_000_000, [], [getWasmKey(ADD_F32)]),
    );
    expectHostError(res, 'WasmVm', 'InvalidAction');
    expect(res.cpuInsns >= 0n).toBe(true);
  });

  // e2e_tests.rs:911 test_wasm_upload_failure_in_recording_mode
  it('test_wasm_upload_failure_in_recording_mode', () => {
    const L = e2eLedger();
    const sim = L.simulate(uploadWasmHostFn(new Uint8Array(1000)), SOURCE);

    expectHostError(sim, 'WasmVm', 'InvalidAction');
    expect(sim.eventsXdr).toEqual([]);
    expect(sim.instructions).toBe(1093647); // expect!["1093647"]
    expect(sim.readOnlyKeys).toEqual([]);
    expect(sim.readWriteKeys).toEqual([]);
    expect(sim.readBytes).toBe(0);
    expect(sim.writeBytes).toBe(0);
  });

  // e2e_tests.rs:949 test_unsupported_wasm_upload_failure_in_recording_mode
  it('test_unsupported_wasm_upload_failure_in_recording_mode', () => {
    const L = e2eLedger();
    const sim = L.simulate(uploadWasmHostFn(ADD_F32), SOURCE);
    expectHostError(sim, 'WasmVm', 'InvalidAction');
    expect(sim.eventsXdr).toEqual([]);
  });

  // e2e_tests.rs:1004 test_wasm_upload_budget_exceeded
  //
  // Upstream limits the enforcing budget to `resources.instructions`
  // (e2e_tests.rs:385 `budget.reset_cpu_limit(resources.instructions)`); 1M is
  // not enough to upload CONTRACT_STORAGE, so the call fails with
  // (Budget, ExceededLimit) and ends with zero instructions remaining.
  //
  // FAILS — HARNESS GAP. `SorobanEnv::send` (crates/host-wasm/src/lib.rs:498)
  // hands `invoke_host_function` a plain `Budget::default()`, i.e. the 100M
  // default CPU limit, and never calls `reset_cpu_limit`. `invoke_host_function`
  // does not read `resources.instructions` itself (e2e_invoke.rs:407-421 only
  // decodes the footprint out of it), so the declared instruction count is
  // decorative here: this upload succeeds with ~3.6M CPU consumed against a
  // 1M declaration. On-chain the transaction would fail.
  it('test_wasm_upload_budget_exceeded', () => {
    const L = e2eLedger();
    const res = send(
      L,
      uploadWasmHostFn(CONTRACT_STORAGE),
      SOURCE,
      resources(1_000_000, [], [getWasmKey(CONTRACT_STORAGE)]),
    );
    expectHostError(res, 'Budget', 'ExceededLimit');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
  });

  // e2e_tests.rs:1029 test_wasm_upload_with_incorrect_footprint_fails
  it('test_wasm_upload_with_incorrect_footprint_fails', () => {
    const L = e2eLedger();
    // RO footprint instead of RW
    const res = send(
      L,
      uploadWasmHostFn(ADD_I32),
      getAccountId(111).toXDR('base64'),
      resources(10_000_000, [getWasmKey(ADD_I32)], []),
    );
    expectHostError(res, 'Storage', 'ExceededLimit');
    expect(res.changedKeys).toEqual([]);
    expect(res.removedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    expect(L.getEntry(b64(getWasmKey(ADD_I32)))).toBeUndefined();
  });

  // e2e_tests.rs:1056 test_wasm_upload_without_footprint_fails
  it('test_wasm_upload_without_footprint_fails', () => {
    const L = e2eLedger();
    const res = send(L, uploadWasmHostFn(ADD_I32), SOURCE, resources(10_000_000, [], []));
    expectHostError(res, 'Storage', 'ExceededLimit');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    // res.diagnostic_events.len() >= 1 — the harness does not return diagnostic
    // events, but HostError's Debug output embeds the event log.
    expect(res.error).toMatch(/Diagnostic Event/);
    expect(res.error).toMatch(/outside of the footprint/);
  });

  // e2e_tests.rs:1080 test_wasm_reupload_is_no_op
  it('test_wasm_reupload_is_no_op', () => {
    const L = e2eLedger();
    // (wasm_entry(ADD_I32), Some(ledger_info.sequence_number))
    const seeded = putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ);
    const key = b64(getWasmKey(ADD_I32));

    const res = send(
      L,
      uploadWasmHostFn(ADD_I32),
      SOURCE,
      resources(10_000_000, [], [getWasmKey(ADD_I32)]),
    );

    expect(res.ok, res.error).toBe(true);
    scValEq(res.returnValueXdr, wasmHashScVal(ADD_I32));
    // One RW change whose new value is identical to the old one, and whose TTL
    // change is old == new == sequence_number: a re-upload does NOT bump rent.
    expect(res.changedKeys).toEqual([key]);
    expect(L.getEntry(key)).toBe(seeded);
    expect(L.getEntryTtl(key)).toBe(DEFAULT_LEDGER_SEQ);
    expect(res.cpuInsns > 0n).toBe(true);
  });

  // e2e_tests.rs:1126 test_wasm_upload_success_with_extra_footprint_entries
  it('test_wasm_upload_success_with_extra_footprint_entries', () => {
    const L = e2eLedger();
    // Only LINEAR_MEMORY exists, at seq + 1000. CONTRACT_STORAGE is named in the
    // RO footprint but absent from the ledger.
    putWasmEntry(L, LINEAR_MEMORY, DEFAULT_LEDGER_SEQ + 1000);
    const lmEntry = L.getEntry(b64(getWasmKey(LINEAR_MEMORY)))!;

    const res = send(
      L,
      uploadWasmHostFn(ADD_I32),
      SOURCE,
      resources(
        10_000_000,
        [getWasmKey(CONTRACT_STORAGE)],
        [getWasmKey(ADD_I32), getWasmKey(LINEAR_MEMORY)],
      ),
    );

    expect(res.ok, res.error).toBe(true);
    scValEq(res.returnValueXdr, wasmHashScVal(ADD_I32));

    // Three ledger changes upstream: ADD_I32 written; LINEAR_MEMORY rewritten
    // unchanged with its TTL untouched; CONTRACT_STORAGE a read-only no-op with
    // no value. The harness reports only the two that carry a new value.
    expect(res.changedKeys).toEqual([
      b64(getWasmKey(ADD_I32)),
      b64(getWasmKey(LINEAR_MEMORY)),
    ]);
    expect(res.removedKeys).toEqual([]);

    expect(L.getEntryTtl(b64(getWasmKey(ADD_I32)))).toBe(
      DEFAULT_LEDGER_SEQ + MIN_PERSISTENT_ENTRY_TTL - 1,
    );
    // old_live_until == new_live_until == seq + 1000, and the value is unchanged.
    expect(L.getEntryTtl(b64(getWasmKey(LINEAR_MEMORY)))).toBe(DEFAULT_LEDGER_SEQ + 1000);
    expect(L.getEntry(b64(getWasmKey(LINEAR_MEMORY)))).toBe(lmEntry);
    // The absent RO entry is not created.
    expect(L.getEntry(b64(getWasmKey(CONTRACT_STORAGE)))).toBeUndefined();
  });
});

// ===========================================================================
describe('upstream e2e_tests.rs :: create contract', () => {
  // e2e_tests.rs:1210 test_create_contract_success
  it('test_create_contract_success', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    const wasmEntry = putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);

    const res = send(
      L,
      cd.hostFn,
      cd.deployer,
      resources(10_000_000, [cd.wasmKey], [cd.contractKey]),
      [cd.authEntry],
    );

    expect(res.ok, res.error).toBe(true);
    scValEq(res.returnValueXdr, xdr.ScVal.scvAddress(cd.contractAddress));
    expect(res.eventsXdr).toEqual([]);

    // ledger_changes: the new instance entry, plus a no-op change for the Wasm.
    expect(res.changedKeys).toEqual([b64(cd.contractKey)]);
    expect(res.removedKeys).toEqual([]);
    expect(L.getEntry(b64(cd.contractKey))).toBe(cd.contractEntry.toXDR('base64'));
    expect(L.getEntryTtl(b64(cd.contractKey))).toBe(
      DEFAULT_LEDGER_SEQ + MIN_PERSISTENT_ENTRY_TTL - 1,
    );
    // no_op_change(&cd.wasm_entry, seq + 100): value and TTL both unchanged.
    expect(L.getEntry(b64(cd.wasmKey))).toBe(wasmEntry);
    expect(L.getEntryTtl(b64(cd.wasmKey))).toBe(DEFAULT_LEDGER_SEQ + 100);
    expect(res.cpuInsns > 0n).toBe(true);
  });

  // e2e_tests.rs:1403 test_create_contract_success_in_recording_mode
  it('test_create_contract_success_in_recording_mode', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);

    const sim = L.simulate(cd.hostFn, cd.deployer);

    expect(sim.ok, sim.error).toBe(true);
    scValEq(sim.returnValueXdr, xdr.ScVal.scvAddress(cd.contractAddress));
    expect(sim.eventsXdr).toEqual([]);
    // assert_eq!(res.auth, vec![cd.auth_entry]);
    expect(sim.authXdr).toEqual([cd.authEntry.toXDR('base64')]);

    expect(sim.instructions).toBe(663637); // expect!["663637"]
    expect(sim.writeBytes).toBe(104); //     expect!["104"]
    expect(sim.readBytes).toBe(0);
    expect(sim.readOnlyKeys).toEqual([b64(cd.wasmKey)]);
    expect(sim.readWriteKeys).toEqual([b64(cd.contractKey)]);
  });

  // e2e_tests.rs:1612 test_create_contract_success_in_recording_mode_with_enforced_auth
  //
  // `RecordingInvocationAuthMode::Enforcing(vec![auth_entry])` — the mode
  // `simulateWithAuth` exposes. Costs 1501 instructions more than recording auth
  // (665138 vs 663637) because the supplied entry is verified rather than
  // recorded.
  it('test_create_contract_success_in_recording_mode_with_enforced_auth', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);

    const sim = L.simulateWithAuth(cd.hostFn, cd.deployer, [cd.authEntry.toXDR('base64')]);

    expect(sim.ok, sim.error).toBe(true);
    scValEq(sim.returnValueXdr, xdr.ScVal.scvAddress(cd.contractAddress));
    expect(sim.eventsXdr).toEqual([]);
    // The entries passed in are passed straight back out.
    expect(sim.authXdr).toEqual([cd.authEntry.toXDR('base64')]);

    expect(sim.instructions).toBe(665138); // expect!["665138"]
    expect(sim.writeBytes).toBe(104); //     expect!["104"]
    expect(sim.readBytes).toBe(0);
    expect(sim.readOnlyKeys).toEqual([b64(cd.wasmKey)]);
    expect(sim.readWriteKeys).toEqual([b64(cd.contractKey)]);
  });

  // e2e_tests.rs:1698 test_create_contract_success_with_extra_footprint_entries
  it('test_create_contract_success_with_extra_footprint_entries', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    const cd2 = createContractData(L, 222, CONTRACT_STORAGE);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);
    putWasmEntry(L, CONTRACT_STORAGE, DEFAULT_LEDGER_SEQ + 200);

    const res = send(
      L,
      cd.hostFn,
      cd.deployer,
      resources(
        10_000_000,
        [cd.wasmKey, cd2.wasmKey],
        [cd.contractKey, cd2.contractKey],
      ),
      [cd.authEntry],
    );

    expect(res.ok, res.error).toBe(true);
    scValEq(res.returnValueXdr, xdr.ScVal.scvAddress(cd.contractAddress));

    // Upstream: cd.contract_key written; cd2.contract_key is an RW change with
    // `new_value: None` (it never existed); both Wasm entries no-op.
    expect(res.changedKeys).toEqual([b64(cd.contractKey)]);
    expect(res.removedKeys).toEqual([b64(cd2.contractKey)]);
    expect(L.getEntry(b64(cd2.contractKey))).toBeUndefined();
    expect(L.getEntryTtl(b64(cd.wasmKey))).toBe(DEFAULT_LEDGER_SEQ + 100);
    expect(L.getEntryTtl(b64(cd2.wasmKey))).toBe(DEFAULT_LEDGER_SEQ + 200);
  });

  // e2e_tests.rs:1776 test_create_contract_without_footprint_fails
  it('test_create_contract_without_footprint_fails', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    const res = send(L, cd.hostFn, cd.deployer, resources(10_000_000, [], []), [cd.authEntry]);

    expectHostError(res, 'Storage', 'ExceededLimit');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    expect(res.error).toMatch(/Diagnostic Event/);
  });

  // e2e_tests.rs:1802 test_create_contract_without_auth_fails
  it('test_create_contract_without_auth_fails', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    const res = send(
      L,
      cd.hostFn,
      cd.deployer,
      resources(10_000_000, [cd.wasmKey], [cd.contractKey]),
      [], // no auth
    );
    expectHostError(res, 'Auth', 'InvalidAction');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    expect(res.error).toMatch(/Diagnostic Event/);
  });

  // e2e_tests.rs:1828 test_create_contract_without_wasm_entry_fails
  it('test_create_contract_without_wasm_entry_fails', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    // Footprint names the Wasm key, but no Wasm entry exists.
    const res = send(
      L,
      cd.hostFn,
      cd.deployer,
      resources(10_000_000, [cd.wasmKey], [cd.contractKey]),
      [cd.authEntry],
    );
    expectHostError(res, 'Storage', 'MissingValue');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
  });

  // e2e_tests.rs:1853 test_create_contract_with_incorrect_auth_fails
  it('test_create_contract_with_incorrect_auth_fails', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);

    // Auth entry is for a different salt.
    const wrongAuth = createContractAuth(
      contractIdPreimage(accountScAddress(cd.deployer), 1),
      ADD_I32,
    );
    const res = send(
      L,
      cd.hostFn,
      cd.deployer,
      resources(10_000_000, [cd.wasmKey], [cd.contractKey]),
      [wrongAuth],
    );
    expectHostError(res, 'Auth', 'InvalidAction');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    expect(L.getEntry(b64(cd.contractKey))).toBeUndefined();
  });

  // The contract id the host derives must equal the one derived in TypeScript
  // from HashIDPreimage::ContractId with the harness's network id. This is what
  // makes every contract-address assertion above meaningful despite the
  // DEFAULT_NETWORK_ID override.
  it('contract id derivation agrees with the host (with the harness network id)', () => {
    const L = e2eLedger();
    expect(sha256(L.networkPassphrase).equals(Buffer.alloc(32, 5))).toBe(false);
    const cd = createContractData(L, 111, ADD_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);
    const sim = L.simulate(cd.hostFn, cd.deployer);
    scValEq(sim.returnValueXdr, xdr.ScVal.scvAddress(cd.contractAddress));
  });
});

// ===========================================================================
describe('upstream e2e_tests.rs :: invoke contract', () => {
  const KEY = symbolScVal('key');
  const VAL = u64ScVal(0xffff_ffff_ffff_ffffn); // u64::MAX

  /** The shared `CreateContractData::new([111;32], CONTRACT_STORAGE)` setup. */
  function storageSetup(L: Ledger) {
    const cd = createContractData(L, 111, CONTRACT_STORAGE);
    const wasmEntry = putWasmEntry(L, CONTRACT_STORAGE, DEFAULT_LEDGER_SEQ + 100);
    L.putEntry(cd.contractEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 1000);
    const dataKey = contractDataKey(
      cd.contractAddress,
      KEY,
      xdr.ContractDataDurability.temporary(),
    );
    return { cd, wasmEntry, dataKey };
  }

  // e2e_tests.rs:1883 test_invoke_contract_with_storage_ops_success
  it('test_invoke_contract_with_storage_ops_success', () => {
    const L = e2eLedger();
    const { cd, wasmEntry, dataKey } = storageSetup(L);
    const hostFn = invokeContractHostFn(cd.contractAddress, 'put_temporary', [KEY, VAL]);

    const res = send(
      L,
      hostFn,
      cd.deployer,
      resources(10_000_000, [cd.contractKey, cd.wasmKey], [dataKey]),
    );

    expect(res.ok, res.error).toBe(true);
    scValEq(res.returnValueXdr, xdr.ScVal.scvVoid());
    expect(res.eventsXdr).toEqual([]);
    expect(res.cpuInsns > 0n).toBe(true);

    // One RW change (the new temporary entry) plus two no-op changes.
    expect(res.changedKeys).toEqual([b64(dataKey)]);
    expect(res.removedKeys).toEqual([]);
    const newEntry = contractDataEntry(
      cd.contractAddress,
      KEY,
      VAL,
      xdr.ContractDataDurability.temporary(),
    );
    expect(L.getEntry(b64(dataKey))).toBe(newEntry.toXDR('base64'));
    expect(L.getEntryTtl(b64(dataKey))).toBe(DEFAULT_LEDGER_SEQ + MIN_TEMP_ENTRY_TTL - 1);
    expect(L.getEntry(b64(cd.contractKey))).toBe(cd.contractEntry.toXDR('base64'));
    expect(L.getEntryTtl(b64(cd.contractKey))).toBe(DEFAULT_LEDGER_SEQ + 1000);
    expect(L.getEntry(b64(cd.wasmKey))).toBe(wasmEntry);
    expect(L.getEntryTtl(b64(cd.wasmKey))).toBe(DEFAULT_LEDGER_SEQ + 100);

    // Second half of the upstream test: extend_temporary(key, 501, 5000) on a
    // fresh ledger where the entry exists with live_until = seq + 500.
    const L2 = e2eLedger();
    const s2 = storageSetup(L2);
    L2.putEntry(newEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 500);
    const extendFn = invokeContractHostFn(s2.cd.contractAddress, 'extend_temporary', [
      KEY,
      u32ScVal(501),
      u32ScVal(5000),
    ]);
    const extended = send(
      L2,
      extendFn,
      s2.cd.deployer,
      resources(10_000_000, [s2.cd.contractKey, s2.cd.wasmKey, s2.dataKey], []),
    );

    expect(extended.ok, extended.error).toBe(true);
    scValEq(extended.returnValueXdr, xdr.ScVal.scvVoid());
    expect(extended.eventsXdr).toEqual([]);
    // A read-only entry whose only change is the TTL: 500 -> 5000 ledgers out.
    expect(extended.changedKeys).toEqual([]);
    expect(extended.removedKeys).toEqual([]);
    expect(L2.getEntryTtl(b64(s2.dataKey))).toBe(DEFAULT_LEDGER_SEQ + 5000);
    expect(L2.getEntry(b64(s2.dataKey))).toBe(newEntry.toXDR('base64'));
  });

  // e2e_tests.rs:2024 test_invoke_contract_with_storage_ops_success_in_recording_mode
  it('test_invoke_contract_with_storage_ops_success_in_recording_mode', () => {
    const L = e2eLedger();
    const { cd, dataKey } = storageSetup(L);
    const hostFn = invokeContractHostFn(cd.contractAddress, 'put_temporary', [KEY, VAL]);

    const sim = L.simulate(hostFn, cd.deployer);

    expect(sim.ok, sim.error).toBe(true);
    scValEq(sim.returnValueXdr, xdr.ScVal.scvVoid());
    expect(sim.eventsXdr).toEqual([]);
    expect(sim.restoredRwEntryIndices).toEqual([]);

    expect(sim.instructions).toBe(898006); // expect!["898006"]
    expect(sim.writeBytes).toBe(80); //      expect!["80"]
    expect(sim.readBytes).toBe(0);
    expect(sim.readOnlyKeys).toEqual([b64(cd.contractKey), b64(cd.wasmKey)]);
    expect(sim.readWriteKeys).toEqual([b64(dataKey)]);

    // extend_temporary in recording mode.
    const L2 = e2eLedger();
    const s2 = storageSetup(L2);
    const newEntry = contractDataEntry(
      s2.cd.contractAddress,
      KEY,
      VAL,
      xdr.ContractDataDurability.temporary(),
    );
    L2.putEntry(newEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 500);
    const extendSim = L2.simulate(
      invokeContractHostFn(s2.cd.contractAddress, 'extend_temporary', [
        KEY,
        u32ScVal(501),
        u32ScVal(5000),
      ]),
      s2.cd.deployer,
    );

    expect(extendSim.ok, extendSim.error).toBe(true);
    scValEq(extendSim.returnValueXdr, xdr.ScVal.scvVoid());
    expect(extendSim.instructions).toBe(1009860); // expect!["1009860"]
    expect(extendSim.writeBytes).toBe(0);
    expect(extendSim.readBytes).toBe(0);
    expect(extendSim.readOnlyKeys).toEqual([
      b64(s2.dataKey),
      b64(s2.cd.contractKey),
      b64(s2.cd.wasmKey),
    ]);
    expect(extendSim.readWriteKeys).toEqual([]);
  });

  // e2e_tests.rs:3089 test_invoke_contract_without_footprint_fails
  it('test_invoke_contract_without_footprint_fails', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, CONTRACT_STORAGE);
    const hostFn = invokeContractHostFn(cd.contractAddress, 'put_temporary', [KEY, VAL]);
    const res = send(L, hostFn, cd.deployer, resources(10_000_000, [], []));

    expectHostError(res, 'Storage', 'ExceededLimit');
    expect(res.changedKeys).toEqual([]);
    expect(res.eventsXdr).toEqual([]);
    expect(res.error).toMatch(/Diagnostic Event/);
  });
});

// ===========================================================================
describe('upstream e2e_tests.rs :: budget', () => {
  // e2e_tests.rs:750 test_run_out_of_budget_before_calling_host
  //
  // `resources.instructions` is the CPU limit for the whole enforcing call
  // (e2e_tests.rs:385). With 1000 instructions the host cannot even decode its
  // inputs, so `invoke_host_function` itself returns Err(Budget, ExceededLimit)
  // — before any footprint or auth check runs.
  //
  // FAILS — HARNESS GAP, same root cause as test_wasm_upload_budget_exceeded.
  // With no CPU limit the call runs all the way to the footprint check and
  // reports Error(Storage, ExceededLimit) instead. The wrong error class is
  // worse than the wrong number: a test written against this harness would
  // conclude its transaction had a footprint bug rather than a fee/resource bug.
  it('test_run_out_of_budget_before_calling_host', () => {
    const L = e2eLedger();
    const res = send(
      L,
      uploadWasmHostFn(ADD_I32),
      getAccountId(0).toXDR('base64'),
      resources(1000, [], []),
    );
    expectHostError(res, 'Budget', 'ExceededLimit');
  });


  // The invariant behind `invoke_host_function_using_simulation`
  // (e2e_tests.rs:609-672): the enforcing run is given
  // `recorded_instructions * 1.02` as its CPU limit and must succeed within it.
  // A simulation that under-reports by more than 2% produces a transaction that
  // cannot apply.
  //
  // The three tests below that involve a contract module FAIL — HARNESS GAP.
  // `SorobanEnv::send` passes `module_cache: None` to `invoke_host_function`
  // (crates/host-wasm/src/lib.rs:515), while upstream passes a `ModuleCache`
  // built outside the metered budget (e2e_tests.rs:443
  // `build_module_cache_for_entries`, called at :381), and stellar-core keeps
  // one per ledger. Without it, `instantiate_vm` (host/frame.rs:763) takes the
  // "throwaway module with its own engine" path and charges the parse to the
  // real budget. Recording mode meanwhile deliberately charges that same parse
  // to the SHADOW budget (frame.rs:835-838: "We will simulate a hit by doing a
  // fresh parse but charging it to the shadow budget"), precisely because it
  // assumes enforcing mode will hit a cache. The two halves of this harness
  // therefore disagree by the whole cost of compiling every contract the call
  // touches: 1.25x for one 584-byte module, 1.59x for one 2.9KB module, 1.47x
  // for a two-contract call. Combined with the missing CPU limit above, a
  // simulate->send round trip here silently succeeds where the real network
  // would reject it for insufficient declared instructions.
  const RECORDING_MODE_INSTRUCTIONS_RANGE = 0.02;

  function roundTrip(L: Ledger, hostFn: xdr.HostFunction, source: string) {
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    const sent = L.send(
      hostFn,
      source,
      sim.resourcesXdr,
      sim.authXdr,
      sim.restoredRwEntryIndices,
    );
    expect(sent.ok, sent.error).toBe(true);
    return { sim, sent };
  }

  // e2e_tests.rs:972 test_wasm_upload_success_using_simulation
  it('test_wasm_upload_success_using_simulation', () => {
    const L = e2eLedger();
    const { sim, sent } = roundTrip(L, uploadWasmHostFn(ADD_I32), SOURCE);
    const limit = Math.floor(sim.instructions * (1 + RECORDING_MODE_INSTRUCTIONS_RANGE));
    expect(
      Number(sent.cpuInsns),
      `enforcing run used ${sent.cpuInsns} CPU but simulation declared ${sim.instructions}`,
    ).toBeLessThanOrEqual(limit);
  });

  // e2e_tests.rs:1676 test_create_contract_success_using_simulation
  it('test_create_contract_success_using_simulation', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, ADD_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);
    const { sim, sent } = roundTrip(L, cd.hostFn, cd.deployer);
    const limit = Math.floor(sim.instructions * (1 + RECORDING_MODE_INSTRUCTIONS_RANGE));
    expect(
      Number(sent.cpuInsns),
      `enforcing run used ${sent.cpuInsns} CPU but simulation declared ${sim.instructions}`,
    ).toBeLessThanOrEqual(limit);
  });

  // e2e_tests.rs:3024 test_invoke_contract_with_storage_ops_success_using_simulation
  it('test_invoke_contract_with_storage_ops_success_using_simulation', () => {
    const L = e2eLedger();
    const cd = createContractData(L, 111, CONTRACT_STORAGE);
    putWasmEntry(L, CONTRACT_STORAGE, DEFAULT_LEDGER_SEQ + 100);
    L.putEntry(cd.contractEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 1000);

    const hostFn = invokeContractHostFn(cd.contractAddress, 'put_temporary', [
      symbolScVal('key'),
      u64ScVal(0xffff_ffff_ffff_ffffn),
    ]);
    const { sim, sent } = roundTrip(L, hostFn, cd.deployer);
    const limit = Math.floor(sim.instructions * (1 + RECORDING_MODE_INSTRUCTIONS_RANGE));
    expect(
      Number(sent.cpuInsns),
      `enforcing run used ${sent.cpuInsns} CPU but simulation declared ${sim.instructions}`,
    ).toBeLessThanOrEqual(limit);
  });

  // e2e_tests.rs:3215 test_cap_54_55_56_module_cache_recording_fidelity
  //
  // SUM_I32 calls into ADD_I32, so a whole invocation runs TWO contract
  // modules. Recording mode charges both parses to the shadow budget
  // (frame.rs:835 "simulate a hit"), betting that enforcing mode will find both
  // in a prepopulated ModuleCache — which is exactly what makes this the test
  // for module-cache fidelity.
  it('test_cap_54_55_56_module_cache_recording_fidelity', () => {
    const L = e2eLedger();
    const addCd = createContractData(L, 111, ADD_I32);
    const sumCd = createContractData(L, 222, SUM_I32);
    putWasmEntry(L, ADD_I32, DEFAULT_LEDGER_SEQ + 100);
    putWasmEntry(L, SUM_I32, DEFAULT_LEDGER_SEQ + 100);
    L.putEntry(addCd.contractEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 1000);
    L.putEntry(sumCd.contractEntry.toXDR('base64'), DEFAULT_LEDGER_SEQ + 1000);

    const hostFn = invokeContractHostFn(sumCd.contractAddress, 'sum', [
      xdr.ScVal.scvAddress(addCd.contractAddress),
      xdr.ScVal.scvVec([1, 2, 3, 4, 5].map((i) => xdr.ScVal.scvI32(i))),
    ]);
    const { sim, sent } = roundTrip(L, hostFn, sumCd.deployer);

    // assert_eq!(res.invoke_result.unwrap(), ScVal::I32(15));
    scValEq(sent.returnValueXdr, xdr.ScVal.scvI32(15));

    const limit = Math.floor(sim.instructions * (1 + RECORDING_MODE_INSTRUCTIONS_RANGE));
    expect(
      Number(sent.cpuInsns),
      `enforcing run used ${sent.cpuInsns} CPU but simulation declared ${sim.instructions}`,
    ).toBeLessThanOrEqual(limit);
  });
});

// ===========================================================================
// Upstream assertions that cannot be expressed against this harness at all.
// Each one is a missing capability, not a disagreement about a value.
describe('upstream e2e_tests.rs :: assertions the harness cannot express', () => {
  // e2e_tests.rs:768 test_run_out_of_budget_before_calling_host_in_recording_mode
  //
  // MISSING: a recording-mode CPU limit. Upstream's helper takes
  // `max_instructions_override` and calls `budget.reset_cpu_limit(1000)` before
  // `invoke_host_function_in_recording_mode` (e2e_tests.rs:474-477).
  // `SorobanEnv::simulate` builds its own `Budget::default()`
  // (crates/host-wasm/src/lib.rs:386) and takes no limit argument, so
  // "preflight this transaction under a 1000-instruction cap" is inexpressible.
  it.skip('test_run_out_of_budget_before_calling_host_in_recording_mode', () => {
    // L.simulate(uploadWasmHostFn(ADD_I32), source, { maxInstructions: 1000 })
    //   -> expectHostError(sim, 'Budget', 'ExceededLimit')
  });

  // MISSING: memory metering on the enforcing path. Nearly every upstream
  // enforcing test ends with `assert!(res.budget.get_mem_bytes_consumed() > 0)`
  // (e.g. e2e_tests.rs:825, 1052, 1122, 1261). `SimulateResult` carries
  // `memBytes` but `SendResult` (lib.rs:149-157) carries only `cpuInsns`, so
  // the enforcing path's memory consumption — the other half of the metered
  // budget, and a real transaction failure mode — is not observable.
  it.skip('enforcing path exposes mem_bytes_consumed', () => {
    // expect(send(...).memBytes > 0n).toBe(true)
  });

  // MISSING: diagnostic events, and control over `enable_diagnostics`.
  // e2e_tests.rs:1029 test_wasm_upload_with_incorrect_footprint_fails passes
  // `enable_diagnostics = false` and asserts `res.diagnostic_events.is_empty()`;
  // ten other tests assert `res.diagnostic_events.len() >= 1`. Both `simulate`
  // and `send` hardcode `true` (lib.rs:393, 503) and drop the collected vector
  // on the floor. The only diagnostics that survive are the ones HostError's
  // Debug formatting happens to embed in the error string on FAILURE — a
  // successful call's diagnostic events are unreachable.
  it.skip('diagnostic events are returned and enable_diagnostics is settable', () => {
    // const res = send(L, hostFn, src, resources, [], { diagnostics: false })
    //   -> expect(res.diagnosticEventsXdr).toEqual([])
  });

  // MISSING: the LedgerEntryChange detail from the enforcing path.
  // Upstream compares full `LedgerEntryChange`s: `read_only`,
  // `old_entry_size_bytes_for_rent`, `new_value`, and a `ttl_change` carrying
  // key_hash / entry_type / durability / old_live_until / new_live_until.
  // `SendResult` reduces all of that to `changedKeys` + `removedKeys`
  // (lib.rs:524-557), so the tests above have to reconstruct what they can from
  // `getEntry`/`getEntryTtl` afterwards. Two things stay invisible:
  //   * `old_entry_size_bytes_for_rent` — the input stellar-core uses to charge
  //     rent, and the whole point of e2e_tests.rs:1105 in test_wasm_reupload_is_no_op.
  //   * the distinction between a read-only entry with a TTL bump and an entry
  //     that was not touched at all.
  it.skip('enforcing path returns full LedgerEntryChanges', () => {
    // expect(res.ledgerChanges[0].oldEntrySizeBytesForRent).toBe(...)
  });

  // MISSING: `contract_events_and_return_value_size` from recording mode.
  // The host returns it (e2e_invoke.rs:InvokeHostFunctionRecordingModeResult)
  // and upstream pins it at e2e_tests.rs:661-667; it is the input to the
  // events-and-return-value component of the refundable resource fee.
  // `SimulateResult` (lib.rs:129-145) does not carry it, which is part of why
  // fake-rpc.ts has to invent the resource fee.
  it.skip('recording mode returns contract_events_and_return_value_size', () => {
    // expect(sim.contractEventsAndReturnValueSize).toBe(...)
  });

  // MISSING: a way to run against the host's own DEFAULT_NETWORK_ID.
  // `Ledger`'s constructor unconditionally overwrites the network id with
  // sha256(networkPassphrase) (src/index.ts:68) and exposes no setter, so an
  // upstream fixture whose expected contract id was computed with [5u8; 32]
  // cannot be reproduced byte-for-byte. Harmless for instruction counts (proven
  // above), but it means literal contract addresses from upstream tests, from
  // stellar-core testdata, or from a captured mainnet transaction cannot be
  // replayed as-is.
  it.skip('network id is settable independently of the passphrase', () => {
    // new Ledger({ networkId: Buffer.alloc(32, 5) })
  });
});
