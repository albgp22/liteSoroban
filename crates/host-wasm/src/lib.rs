//! An in-process Soroban ledger for JavaScript tests.
//!
//! This is the LiteSVM-shaped core: the *real* `soroban-env-host` (including the
//! wasmi interpreter and the metered budget) compiled to `wasm32-unknown-unknown`,
//! driving a plain `BTreeMap` of ledger entries that lives on the JS side of the
//! fence only as an opaque handle.
//!
//! Two host entry points do all the work:
//!   * `invoke_host_function_in_recording_mode` -> what stellar-rpc's
//!     `simulateTransaction` wraps. Produces the footprint, resources and auth.
//!   * `invoke_host_function` -> the *enforcing* apply path. Takes the footprint
//!     as a constraint and returns `LedgerEntryChange`s that we merge back.
//!
//! PROTOCOL PINNING (read this before bumping the dependency):
//! P27's `invoke_host_function` takes 14 args with `encoded_ledger_entries` and
//! `encoded_ttl_entries` as two parallel, equal-length iterators. P28 changed it
//! to 13 args with TTL folded into a single iterator via `TtlLedgerEntryMeta`.
//! The recording-mode signature is identical across both.
//!
//! This crate targets the P28 shape. The single iterator has invariants the
//! compiler cannot check, and breaking any of them fails the call with
//! `Error(Storage, InternalError)` rather than a type error:
//!   * exactly one item per footprint key, `read_only` keys first and then
//!     `read_write`, because the host zips the iterator against the footprint;
//!   * an absent key is `(None, None)`: skipping it shifts every later entry
//!     onto the wrong key;
//!   * ContractData/ContractCode entries carry `Some(TtlLedgerEntryMeta)`,
//!     every other entry type carries `None`;
//!   * no TTL in it is below the current ledger, so an archived entry the
//!     transaction restores goes in with its post-restore TTL.

use base64::Engine;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

use soroban_env_host::budget::{AsBudget, Budget};
use soroban_env_host::e2e_invoke::{
    entry_size_for_rent, extract_rent_changes, invoke_host_function,
    invoke_host_function_in_recording_mode, RecordingInvocationAuthMode, TtlLedgerEntryMeta,
};
use soroban_env_host::fees::{compute_rent_fee, LedgerEntryRentChange};
use soroban_env_host::e2e_testutils::{
    account_entry, get_account_id, get_wasm_hash, get_wasm_key, wasm_entry, DEFAULT_NETWORK_ID,
};
use soroban_env_host::storage::{EntryWithLiveUntil, SnapshotSource};
use soroban_env_host::xdr::{
    AccountEntry, AccountEntryExt, AccountEntryExtensionV1, AccountEntryExtensionV1Ext,
    AccountEntryExtensionV2, AccountEntryExtensionV2Ext, AccountEntryExtensionV3, ExtensionPoint,
    LedgerFootprint, Liabilities, SponsorshipDescriptor, TimePoint,
    AccountId, HostFunction, LedgerEntry, LedgerEntryData, LedgerKey, LedgerKeyAccount,
    LedgerKeyContractCode, LedgerKeyContractData, LedgerKeyTrustLine, Limits, ReadXdr,
    ContractCostParams, ContractDataDurability, ExtendFootprintTtlOp, Hash,
    InvokeHostFunctionOp, OperationBody, RestoreFootprintOp, SorobanAuthorizationEntry,
    SorobanResources, WriteXdr,
};
use soroban_env_host::{
    CompilationContext, Error as ScError, ErrorHandler, HostError, LedgerInfo, ModuleCache, Val,
};

use sha2::{Digest, Sha256};

mod fees;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn b64d(s: &str) -> Result<Vec<u8>, JsError> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| JsError::new(&format!("base64 decode: {e}")))
}

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn xdr_err<E: std::fmt::Debug>(e: E) -> JsError {
    JsError::new(&format!("xdr: {e:?}"))
}

fn host_err(e: HostError) -> JsError {
    JsError::new(&format!("host: {e:?}"))
}

fn to_xdr_b64<T: WriteXdr>(v: &T) -> Result<String, JsError> {
    Ok(b64e(&v.to_xdr(Limits::none()).map_err(xdr_err)?))
}

fn from_xdr_b64<T: ReadXdr>(s: &str) -> Result<T, JsError> {
    T::from_xdr(b64d(s)?, Limits::none()).map_err(xdr_err)
}

/// Derive the `LedgerKey` for an entry. `ledger_entry_to_ledger_key` is
/// `pub(crate)` in the host, so we mirror it for the types we support.
fn key_of(e: &LedgerEntry) -> Result<LedgerKey, JsError> {
    Ok(match &e.data {
        LedgerEntryData::Account(a) => LedgerKey::Account(LedgerKeyAccount {
            account_id: a.account_id.clone(),
        }),
        LedgerEntryData::Trustline(t) => LedgerKey::Trustline(LedgerKeyTrustLine {
            account_id: t.account_id.clone(),
            asset: t.asset.clone(),
        }),
        LedgerEntryData::ContractData(d) => LedgerKey::ContractData(LedgerKeyContractData {
            contract: d.contract.clone(),
            key: d.key.clone(),
            durability: d.durability,
        }),
        LedgerEntryData::ContractCode(c) => LedgerKey::ContractCode(LedgerKeyContractCode {
            hash: c.hash.clone(),
        }),
        _ => return Err(JsError::new("unsupported ledger entry type for key derivation")),
    })
}

/// stellar-rpc never returns the raw recorded instruction count: recording mode
/// measures slightly less work than the enforcing pass actually does, so it
/// pads it before handing resources back. Submitting the raw number produces
/// `Error(Budget, ExceededLimit)` on apply.
///
/// This is soroban-simulation's `SimulationAdjustmentFactor::adjust_u32` with
/// `default_adjustment()`'s instruction factor (x1.04, +50_000), where
/// stellar-rpc first raises the additive part to the caller's
/// `resourceConfig.instructionLeeway` (stellar-rpc v29.0.1,
/// lib/preflight/src/shared.rs). Same f64 floor, and 0 stays 0.
fn adjust_instructions(raw: u32, instruction_leeway: u32) -> u32 {
    if raw == 0 {
        return 0;
    }
    let additive = DEFAULT_INSTRUCTION_ADDITIVE.max(instruction_leeway);
    raw.saturating_add(additive)
        .max(((raw as f64) * 1.04).clamp(0.0, u32::MAX as f64).floor() as u32)
}

/// soroban-simulation `default_adjustment()`: instructions additive factor.
const DEFAULT_INSTRUCTION_ADDITIVE: u32 = 50_000;

/// Testnet's `ConfigSettingStateArchival`, the defaults `ledger_info()` hands
/// the host: read with getLedgerEntries from soroban-testnet.stellar.org on
/// 2026-10-18 (ledger 5,264,566; the entry was last modified at ledger 2,332).
/// A local stellar/quickstart (core 29.0.0, rpc 29.0.1) reports the same three,
/// since it applies testnet's settings upgrade. The values these replace,
/// 16 / 100_000 / 10_000_000, were soroban-env-host's own e2e_testutils.rs
/// fixture and matched no network.
const TESTNET_MIN_TEMP_ENTRY_TTL: u32 = 720;
const TESTNET_MIN_PERSISTENT_ENTRY_TTL: u32 = 120_960;
const TESTNET_MAX_ENTRY_TTL: u32 = 3_110_400;

fn is_temporary(k: &LedgerKey) -> bool {
    matches!(k, LedgerKey::ContractData(d) if d.durability == ContractDataDurability::Temporary)
}

/// Only ContractData/ContractCode carry a TTL. The host rejects those two
/// without `TtlLedgerEntryMeta`, and rejects the others with it.
fn needs_ttl(k: &LedgerKey) -> bool {
    matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_))
}

fn encode_diagnostics(events: &[soroban_env_host::xdr::DiagnosticEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| e.to_xdr(Limits::none()).ok().map(|b| b64e(&b)))
        .collect()
}

// ---------------------------------------------------------------------------
// ledger state
// ---------------------------------------------------------------------------

type Store = BTreeMap<Rc<LedgerKey>, EntryWithLiveUntil>;

#[derive(Clone)]
struct LedgerSnapshot {
    store: Store,
    ledger_seq: u32,
    timestamp: u64,
    prng_counter: u64,
}

/// Adapts the map to the host's `SnapshotSource`. Recording mode reads the whole
/// ledger through this to discover the footprint.
struct StoreSnapshot(Rc<RefCell<Store>>);

impl SnapshotSource for StoreSnapshot {
    fn get(&self, key: &Rc<LedgerKey>) -> Result<Option<EntryWithLiveUntil>, HostError> {
        Ok(self.0.borrow().get(key).cloned())
    }
}

/// What stellar-rpc's preflight actually reads through: soroban-simulation's
/// `SimulationSnapshotSource` (snapshot_source.rs, 29.0.2), which wraps the
/// snapshot right before recording mode and hands the host every AccountEntry
/// already promoted to the ext v1 -> v2 -> v3 chain, "to emulate any ledger
/// entry modifying logic that Core might perform before the Soroban host
/// operation is invoked". Without it a never-transacted account simulates 52
/// bytes small, and so does every native SAC transfer that touches one.
/// Simulation only: on apply, core promotes just the transaction source, when
/// it bumps the sequence (the classic layer does that).
struct SimulationSnapshot {
    inner: StoreSnapshot,
    updated: RefCell<BTreeMap<Rc<LedgerKey>, Option<EntryWithLiveUntil>>>,
}

impl SnapshotSource for SimulationSnapshot {
    fn get(&self, key: &Rc<LedgerKey>) -> Result<Option<EntryWithLiveUntil>, HostError> {
        if let Some(e) = self.updated.borrow().get(key) {
            return Ok(e.clone());
        }
        let entry = self.inner.get(key)?;
        if let Some((e, live_until)) = &entry {
            if let LedgerEntryData::Account(_) = &e.data {
                let mut updated = (**e).clone();
                if let LedgerEntryData::Account(acc) = &mut updated.data {
                    update_account_entry(acc);
                }
                let v = Some((Rc::new(updated), *live_until));
                self.updated.borrow_mut().insert(Rc::clone(key), v.clone());
                return Ok(v);
            }
        }
        Ok(entry)
    }
}

/// soroban-simulation `update_account_entry`: fill in whatever part of the
/// v1 -> v2 -> v3 chain is missing, zeroed, keeping what is already there.
fn update_account_entry(acc: &mut AccountEntry) {
    let signers = acc.signers.len();
    let fill_v3 = |v2: &mut AccountEntryExtensionV2| {
        if let AccountEntryExtensionV2Ext::V0 = v2.ext {
            v2.ext = AccountEntryExtensionV2Ext::V3(AccountEntryExtensionV3 {
                ext: ExtensionPoint::V0,
                seq_ledger: 0,
                seq_time: TimePoint(0),
            });
        }
    };
    let fill_v2 = |v1: &mut AccountEntryExtensionV1| match &mut v1.ext {
        AccountEntryExtensionV1Ext::V0 => {
            let mut v2 = AccountEntryExtensionV2 {
                num_sponsored: 0,
                num_sponsoring: 0,
                signer_sponsoring_i_ds: vec![SponsorshipDescriptor(None); signers]
                    .try_into()
                    .unwrap_or_default(),
                ext: AccountEntryExtensionV2Ext::V0,
            };
            fill_v3(&mut v2);
            v1.ext = AccountEntryExtensionV1Ext::V2(v2);
        }
        AccountEntryExtensionV1Ext::V2(v2) => fill_v3(v2),
    };
    match &mut acc.ext {
        AccountEntryExt::V0 => {
            let mut v1 = AccountEntryExtensionV1 {
                liabilities: Liabilities { buying: 0, selling: 0 },
                ext: AccountEntryExtensionV1Ext::V0,
            };
            fill_v2(&mut v1);
            acc.ext = AccountEntryExt::V1(v1);
        }
        AccountEntryExt::V1(v1) => fill_v2(v1),
    }
}

/// Where contract code is compiled for the module cache. The host's own
/// reference embedder (`E2eTestCompilationContext`, test-only and so not
/// reachable) does the same: compilation happens outside any transaction, so it
/// runs against an unlimited budget that nothing else observes.
#[derive(Clone)]
struct CompileCtx(Budget);

impl CompileCtx {
    fn new() -> Result<Self, HostError> {
        let budget = Budget::default();
        budget.reset_unlimited()?;
        Ok(Self(budget))
    }
}

impl ErrorHandler for CompileCtx {
    fn map_err<T, E>(&self, res: Result<T, E>) -> Result<T, HostError>
    where
        ScError: From<E>,
        E: std::fmt::Debug,
    {
        res.map_err(HostError::from)
    }

    fn error(&self, error: ScError, _msg: &str, _args: &[Val]) -> HostError {
        HostError::from(error)
    }
}

impl AsBudget for CompileCtx {
    fn as_budget(&self) -> &Budget {
        &self.0
    }
}

impl CompilationContext for CompileCtx {}

// ---------------------------------------------------------------------------
// results returned to JS
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SimulateResult {
    ok: bool,
    error: Option<String>,
    return_value_xdr: Option<String>,
    /// `SorobanResources` XDR: footprint + instructions + read/write bytes.
    resources_xdr: String,
    auth_xdr: Vec<String>,
    restored_rw_entry_indices: Vec<u32>,
    /// Raw recorded count, comparable with upstream's own e2e expectations.
    instructions: u32,
    /// Padded the way stellar-rpc pads it; this is what `resources_xdr` carries.
    adjusted_instructions: u32,
    /// stellar-rpc's `minResourceFee` for these resources; 0 when the call
    /// failed. See `fees::preflight_resource_fee`.
    min_resource_fee: i64,
    read_bytes: u32,
    write_bytes: u32,
    cpu_insns: u64,
    mem_bytes: u64,
    read_only_keys: Vec<String>,
    read_write_keys: Vec<String>,
    events_xdr: Vec<String>,
    /// The host fills these on EVERY call, success or failure — fn_call,
    /// fn_return, error, and each contract event tagged with
    /// in_successful_contract_call. Previously computed and thrown away.
    diagnostic_events_xdr: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SendResult {
    ok: bool,
    error: Option<String>,
    return_value_xdr: Option<String>,
    changed_keys: Vec<String>,
    removed_keys: Vec<String>,
    events_xdr: Vec<String>,
    diagnostic_events_xdr: Vec<String>,
    cpu_insns: u64,
    mem_bytes: u64,
    /// TTL bumps applied to entries that were otherwise untouched. Invisible in
    /// changed_keys, because nothing about the entry itself changed.
    ttl_changed_keys: Vec<String>,
    /// The InvokeHostFunctionResultCode stellar-core would report for a failed
    /// call, as the js-xdr arm name; None on success.
    result_code: Option<String>,
    /// On success: the rent the ledger changes cost (`compute_rent_fee`), the
    /// size of the contract events plus the return value, and what the call
    /// consumed of the refundable resource fee (rent + events fee). 0 otherwise.
    rent_fee: i64,
    contract_events_size_bytes: u32,
    refundable_fee_consumed: i64,
}

// ---------------------------------------------------------------------------
// the environment
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct SorobanEnv {
    store: Rc<RefCell<Store>>,
    snapshots: Vec<LedgerSnapshot>,
    ledger_seq: u32,
    timestamp: u64,
    protocol_version: u32,
    network_id: [u8; 32],
    /// Recording auth derives the auth-entry nonce from the base PRNG seed. A
    /// fixed seed makes two simulations against the same address produce the
    /// SAME nonce, and the second one dies with
    /// `Error(Auth, ExistingValue) / "nonce already exists for address"`.
    /// stellar-rpc feeds each preflight fresh entropy; we count instead, which
    /// keeps a fresh ledger fully reproducible while still varying per call.
    prng_counter: std::cell::Cell<u64>,
    /// Cost calibration. Unset, `Budget::default()` applies. Up to 27.0.1 that
    /// was stellar-core's `initialCpuCostParamsEntryForV20` — the table a
    /// network has BEFORE its first settings upgrade — which over-metered
    /// against any live node. From 28.0.0 the defaults are the live
    /// calibration: on the pinned 29.0.2 they equal the protocol-27 table this
    /// repo ships, so installing it with `setCostParams` changes no count. Load
    /// a network's own table to match that network once it moves away from the
    /// host's defaults.
    cpu_cost_params: Option<ContractCostParams>,
    mem_cost_params: Option<ContractCostParams>,
    cpu_limit: u64,
    mem_limit: u64,
    /// The network's `StateArchivalSettings` TTLs: the host gives a new entry
    /// `ledger + min - 1` and caps any TTL at `ledger + max - 1`
    /// (ledger_info.rs), and RestoreFootprint / auto-restore use the persistent
    /// minimum. Testnet's by default; like the cost params, network
    /// configuration rather than ledger state, so not part of a snapshot.
    min_temp_entry_ttl: u32,
    min_persistent_entry_ttl: u32,
    max_entry_ttl: u32,
    /// Cap the enforcing pass at the DECLARED instruction count, the way
    /// stellar-core does. On by default. Off, the declared bytes go unchecked
    /// too (`enforce_declared_bytes`); the network's limits apply either way.
    ///
    /// This used to be off, because the enforcing pass ran with
    /// `module_cache: None`: it paid the full `VmInstantiation` Wasm-parse cost
    /// (const_term 451,626) where recording mode charges the cached price to its
    /// shadow budget, the two halves disagreed by 71-188% per invocation, and
    /// enforcing the declared limit failed every deploy with
    /// Error(Budget, ExceededLimit). `send` now hands the host a module cache
    /// (see `prepare_module_cache`) and the applied count tracks the recorded
    /// one to within 1%, so every deploy and invocation in the calibration
    /// scenarios fits its declared count with 3.8-27% to spare.
    ///
    /// The floor of that margin is stellar-rpc's own padding
    /// (`max(raw + 50_000, raw * 1.04)`): an apply that costs more than 4% over
    /// what the simulation recorded is refused, exactly as on a network, e.g.
    /// when state grows between simulate and send. The same goes for a
    /// simulation that left work out, such as an unsigned custom-account call
    /// whose `__check_auth` the recording never ran: it now dies with
    /// Error(Budget, ExceededLimit) before the host gets to reject the
    /// signature. The limit is the smaller of the declared count and the
    /// configured `cpu_limit`. Turn this off to send resources whose
    /// instruction count you do not control.
    enforce_declared_resources: bool,
    /// Fail the enforcing pass when it reads more classic or restored entry
    /// bytes than the transaction declares, or writes more, as stellar-core's
    /// InvokeHostFunctionOpFrame does (`addReads` / `recordStorageChanges`).
    /// On by default. The host itself never checks them: upstream's own e2e
    /// tests declare 0 and pass.
    enforce_declared_bytes: bool,
    /// Parsed contract code, shared by every `send` on this environment, built
    /// lazily so `new()` stays free. It is content-addressed by wasm hash, so it
    /// is deliberately NOT part of a snapshot: after `restore()` it can hold
    /// modules whose code is gone from the ledger, and the host checks storage
    /// before it trusts a cache hit. `None` until the first contract call.
    module_cache: Option<ModuleCache>,
    /// The network's fee settings; see `fees.rs`. The TS layer installs them.
    fee_settings: Option<fees::NetworkFeeSettings>,
}

#[wasm_bindgen]
impl SorobanEnv {
    #[wasm_bindgen(constructor)]
    pub fn new(protocol_version: u32, ledger_seq: u32) -> SorobanEnv {
        SorobanEnv {
            store: Rc::new(RefCell::new(Store::new())),
            snapshots: Vec::new(),
            ledger_seq,
            timestamp: 1_700_000_000,
            protocol_version,
            network_id: DEFAULT_NETWORK_ID,
            prng_counter: std::cell::Cell::new(0),
            cpu_cost_params: None,
            mem_cost_params: None,
            cpu_limit: 100_000_000,
            mem_limit: 41_943_040,
            min_temp_entry_ttl: TESTNET_MIN_TEMP_ENTRY_TTL,
            min_persistent_entry_ttl: TESTNET_MIN_PERSISTENT_ENTRY_TTL,
            max_entry_ttl: TESTNET_MAX_ENTRY_TTL,
            enforce_declared_resources: true,
            enforce_declared_bytes: true,
            module_cache: None,
            fee_settings: None,
        }
    }

    /// See `enforce_declared_resources`. On by default; pass `false` to send
    /// resources whose declared instruction count should not be enforced.
    #[wasm_bindgen(js_name = enforceDeclaredResources)]
    pub fn set_enforce_declared_resources(&mut self, on: bool) {
        self.enforce_declared_resources = on;
    }

    /// See `enforce_declared_bytes`. On by default.
    #[wasm_bindgen(js_name = enforceDeclaredBytes)]
    pub fn set_enforce_declared_bytes(&mut self, on: bool) {
        self.enforce_declared_bytes = on;
    }

    /// Install the network's real cost calibration, as base64
    /// `ContractCostParams` XDR (from the `ConfigSetting` ledger entries).
    /// Without this the harness meters with the host's defaults, which on the
    /// pinned host equal the shipped protocol-27 table.
    #[wasm_bindgen(js_name = setCostParams)]
    pub fn set_cost_params(
        &mut self,
        cpu_params_b64: &str,
        mem_params_b64: &str,
        cpu_limit: u64,
        mem_limit: u64,
    ) -> Result<(), JsError> {
        self.cpu_cost_params = Some(from_xdr_b64(cpu_params_b64)?);
        self.mem_cost_params = Some(from_xdr_b64(mem_params_b64)?);
        self.cpu_limit = cpu_limit;
        self.mem_limit = mem_limit;
        Ok(())
    }

    /// Install a network's state-archival TTLs (`ConfigSettingStateArchival`'s
    /// minTemporaryTTL, minPersistentTTL, maxEntryTTL). Without this the
    /// harness runs testnet's. Zero is refused: the host computes
    /// `ledger + ttl.saturating_sub(1)`, which would quietly treat it as 1.
    #[wasm_bindgen(js_name = setArchivalSettings)]
    pub fn set_archival_settings(
        &mut self,
        min_temp_entry_ttl: u32,
        min_persistent_entry_ttl: u32,
        max_entry_ttl: u32,
    ) -> Result<(), JsError> {
        if min_temp_entry_ttl == 0 || min_persistent_entry_ttl == 0 || max_entry_ttl == 0 {
            return Err(JsError::new("state-archival TTLs must be at least 1"));
        }
        self.min_temp_entry_ttl = min_temp_entry_ttl;
        self.min_persistent_entry_ttl = min_persistent_entry_ttl;
        self.max_entry_ttl = max_entry_ttl;
        Ok(())
    }

    /// True when real network cost parameters have been installed.
    #[wasm_bindgen(getter, js_name = hasNetworkCostParams)]
    pub fn has_network_cost_params(&self) -> bool {
        self.cpu_cost_params.is_some()
    }

    /// Rewind the PRNG counter, for tests that need byte-identical nonces.
    #[wasm_bindgen(js_name = resetPrng)]
    pub fn reset_prng(&mut self) {
        self.prng_counter.set(0);
    }

    /// The protocol this host actually implements. Surfaced loudly so a harness
    /// can refuse to run against a mismatched expectation.
    #[wasm_bindgen(getter, js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    #[wasm_bindgen(getter, js_name = ledgerSeq)]
    pub fn ledger_seq(&self) -> u32 {
        self.ledger_seq
    }

    #[wasm_bindgen(js_name = advanceLedgers)]
    pub fn advance_ledgers(&mut self, n: u32) {
        self.ledger_seq = self.ledger_seq.saturating_add(n);
        self.timestamp = self.timestamp.saturating_add(n as u64 * 5);
    }

    #[wasm_bindgen(js_name = entryCount)]
    pub fn entry_count(&self) -> usize {
        self.store.borrow().len()
    }

    #[wasm_bindgen(getter)]
    pub fn timestamp(&self) -> u64 {
        self.timestamp
    }

    #[wasm_bindgen(js_name = setTimestamp)]
    pub fn set_timestamp(&mut self, t: u64) {
        self.timestamp = t;
    }

    /// MUST match sha256(network passphrase). The host hashes this into the
    /// `HashIDPreimage::SorobanAuthorization` payload that a custom account's
    /// `__check_auth` verifies; if it disagrees with what the client signed,
    /// every custom-account authorization fails with a payload mismatch.
    #[wasm_bindgen(js_name = setNetworkId)]
    pub fn set_network_id(&mut self, id: &[u8]) -> Result<(), JsError> {
        if id.len() != 32 {
            return Err(JsError::new("network id must be 32 bytes"));
        }
        self.network_id.copy_from_slice(id);
        Ok(())
    }

    /// Write any ledger entry directly. This is the general form of LiteSVM's
    /// `set_account`: the classic layer lives in TypeScript and pokes account
    /// and trustline entries in through here, so the Rust surface stays small.
    /// Returns the derived `LedgerKey` as base64.
    #[wasm_bindgen(js_name = putEntry)]
    pub fn put_entry(&mut self, entry_b64: &str, live_until: Option<u32>) -> Result<String, JsError> {
        let entry: LedgerEntry = from_xdr_b64(entry_b64)?;
        let key = key_of(&entry)?;
        let key_b64 = to_xdr_b64(&key)?;
        self.store
            .borrow_mut()
            .insert(Rc::new(key), (Rc::new(entry), live_until));
        Ok(key_b64)
    }

    /// A hash over the ENTIRE ledger: every key, entry and TTL, in key order.
    /// Two environments with the same state produce the same hash, which is the
    /// only way a test can assert that a rollback was exact rather than merely
    /// correct for the keys it happened to check.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<String, JsError> {
        let store = self.store.borrow();
        let mut hasher = Sha256::new();
        for (key, (entry, live_until)) in store.iter() {
            hasher.update(key.to_xdr(Limits::none()).map_err(xdr_err)?);
            hasher.update(entry.to_xdr(Limits::none()).map_err(xdr_err)?);
            hasher.update(live_until.unwrap_or(0).to_le_bytes());
        }
        Ok(b64e(&hasher.finalize()))
    }

    /// Every `LedgerKey` currently in the ledger, base64, in key order.
    #[wasm_bindgen(js_name = allKeys)]
    pub fn all_keys(&self) -> Result<Vec<String>, JsError> {
        self.store
            .borrow()
            .keys()
            .map(|k| to_xdr_b64(k.as_ref()))
            .collect()
    }

    #[wasm_bindgen(js_name = removeEntry)]
    pub fn remove_entry(&mut self, key_b64: &str) -> Result<bool, JsError> {
        let key: LedgerKey = from_xdr_b64(key_b64)?;
        Ok(self.store.borrow_mut().remove(&Rc::new(key)).is_some())
    }

    // -- requirement 5: pre-funded accounts / seeded contracts ---------------

    /// Write a funded `AccountEntry` straight into the ledger. This is the
    /// LiteSVM `set_account` escape hatch: no transaction, no friendbot.
    /// Returns the `AccountId` as base64 XDR.
    #[wasm_bindgen(js_name = fundAccount)]
    pub fn fund_account(&mut self, seed: u8) -> Result<String, JsError> {
        let id = get_account_id([seed; 32]);
        let entry = account_entry(&id);
        let key = key_of(&entry)?;
        self.store
            .borrow_mut()
            .insert(Rc::new(key), (Rc::new(entry), None));
        to_xdr_b64(&id)
    }

    /// Seed contract code directly (skipping the upload transaction).
    /// Returns the wasm hash as base64. The code gets the TTL an upload at this
    /// ledger would give it: `ledger + min_persistent_entry_ttl - 1`, the
    /// host's `get_min_live_until_ledger(Persistent)` (lifecycle.rs:400).
    ///
    /// NOTE: the parameter must NOT be called `wasm`. wasm-bindgen copies Rust
    /// parameter names verbatim into the generated JS, where a parameter named
    /// `wasm` shadows the module-level binding holding the instance exports,
    /// producing "wasm.__wbindgen_add_to_stack_pointer is not a function".
    #[wasm_bindgen(js_name = seedWasm)]
    pub fn seed_wasm(&mut self, code: &[u8]) -> Result<String, JsError> {
        let entry = wasm_entry(code);
        let key = get_wasm_key(code);
        let ttl = self
            .ledger_info()
            .min_live_until_ledger_checked(ContractDataDurability::Persistent)
            .ok_or_else(|| JsError::new("persistent TTL overflows the ledger sequence"))?;
        self.store
            .borrow_mut()
            .insert(Rc::new(key), (Rc::new(entry), Some(ttl)));
        Ok(b64e(&get_wasm_hash(code)))
    }

    /// Read a raw ledger entry back out, for assertions. Key and value are
    /// base64 XDR (`LedgerKey` in, `LedgerEntry` out).
    #[wasm_bindgen(js_name = getEntry)]
    pub fn get_entry(&self, key_b64: &str) -> Result<Option<String>, JsError> {
        let key: LedgerKey = from_xdr_b64(key_b64)?;
        match self.store.borrow().get(&Rc::new(key)) {
            Some((e, _)) => Ok(Some(to_xdr_b64(e.as_ref())?)),
            None => Ok(None),
        }
    }

    #[wasm_bindgen(js_name = getEntryTtl)]
    pub fn get_entry_ttl(&self, key_b64: &str) -> Result<Option<u32>, JsError> {
        let key: LedgerKey = from_xdr_b64(key_b64)?;
        Ok(self.store.borrow().get(&Rc::new(key)).and_then(|(_, t)| *t))
    }

    /// The state-archival settings `ledger_info()` hands the host, as
    /// [min_temp_entry_ttl, min_persistent_entry_ttl, max_entry_ttl], so the
    /// classic layer's ExtendFootprintTTL / RestoreFootprint use the same ones.
    #[wasm_bindgen(js_name = archivalSettings)]
    pub fn archival_settings(&self) -> Vec<u32> {
        let li = self.ledger_info();
        vec![li.min_temp_entry_ttl, li.min_persistent_entry_ttl, li.max_entry_ttl]
    }

    /// stellar-rpc's preflight for an ExtendFootprintTTL transaction, over its
    /// read-only footprint. See `extend_ttl_resources`; `ledger_seq` as for
    /// `simulate`.
    #[wasm_bindgen(js_name = simulateExtendTtl)]
    pub fn simulate_extend_ttl(
        &self,
        keys_b64: Vec<String>,
        extend_to: u32,
        ledger_seq: Option<u32>,
    ) -> Result<JsValue, JsError> {
        let keys = keys_b64
            .iter()
            .map(|k| from_xdr_b64::<LedgerKey>(k))
            .collect::<Result<Vec<_>, _>>()?;
        let ledger_seq = ledger_seq.unwrap_or(self.ledger_seq);
        let op = OperationBody::ExtendFootprintTtl(ExtendFootprintTtlOp { ext: ExtensionPoint::V0, extend_to });
        self.footprint_simulation(self.extend_ttl_resources(&keys, extend_to, ledger_seq), op, ledger_seq)
    }

    /// stellar-rpc's preflight for a RestoreFootprint transaction, over its
    /// read-write footprint. See `restore_resources`; `ledger_seq` as for
    /// `simulate`.
    #[wasm_bindgen(js_name = simulateRestore)]
    pub fn simulate_restore(
        &self,
        keys_b64: Vec<String>,
        ledger_seq: Option<u32>,
    ) -> Result<JsValue, JsError> {
        let keys = keys_b64
            .iter()
            .map(|k| from_xdr_b64::<LedgerKey>(k))
            .collect::<Result<Vec<_>, _>>()?;
        let ledger_seq = ledger_seq.unwrap_or(self.ledger_seq);
        let op = OperationBody::RestoreFootprint(RestoreFootprintOp { ext: ExtensionPoint::V0 });
        self.footprint_simulation(self.restore_resources(&keys, ledger_seq), op, ledger_seq)
    }

    // -- requirement 4: isolation -------------------------------------------

    /// Snapshot the entire ledger. O(entries) memcpy of a BTreeMap -- this is
    /// the whole reason an in-process ledger beats a node: there is no protocol
    /// involved in going back in time.
    pub fn snapshot(&mut self) -> u32 {
        // ledger_seq and timestamp are ledger state too: they decide every TTL
        // and every timebound. Snapshotting only the entry map silently
        // corrupts the commonest archival test shape (snapshot, advance past a
        // TTL, assert, restore).
        self.snapshots.push(LedgerSnapshot {
            store: self.store.borrow().clone(),
            ledger_seq: self.ledger_seq,
            timestamp: self.timestamp,
            prng_counter: self.prng_counter.get(),
        });
        (self.snapshots.len() - 1) as u32
    }

    pub fn restore(&mut self, id: u32) -> Result<(), JsError> {
        let snap = self
            .snapshots
            .get(id as usize)
            .ok_or_else(|| JsError::new("no such snapshot"))?
            .clone();
        *self.store.borrow_mut() = snap.store;
        self.ledger_seq = snap.ledger_seq;
        self.timestamp = snap.timestamp;
        self.prng_counter.set(snap.prng_counter);
        Ok(())
    }

    // -- requirement 2: simulate --------------------------------------------

    /// Recording mode. Discovers the footprint by reading through the snapshot
    /// source, records auth, and measures resources. Does NOT mutate the ledger.
    /// `instruction_leeway` is stellar-rpc's `resourceConfig.instructionLeeway`;
    /// see `adjust_instructions`. `ledger_seq` is the ledger to simulate in,
    /// the open one (`ledger_seq`) by default. stellar-rpc preflights in the
    /// last closed ledger, one before the one a submission applies in
    /// (simulate_transaction.go, `LedgerSeq: latestLedger`, v29.0.1).
    pub fn simulate(
        &self,
        host_fn_b64: &str,
        source_b64: &str,
        instruction_leeway: Option<u32>,
        ledger_seq: Option<u32>,
    ) -> Result<JsValue, JsError> {
        self.simulate_inner(
            host_fn_b64,
            source_b64,
            None,
            instruction_leeway.unwrap_or(0),
            ledger_seq.unwrap_or(self.ledger_seq),
        )
    }

    /// Re-simulate with already-signed authorization entries, in ENFORCING auth
    /// mode. This is mandatory for custom accounts: plain recording mode never
    /// calls `__check_auth`, so the footprint it records omits every ledger
    /// entry that `__check_auth` reads, and the enforcing apply path then fails
    /// with "trying to access contract data key outside of the footprint".
    /// Real apps hit the same wall; the fix is the same round trip.
    #[wasm_bindgen(js_name = simulateWithAuth)]
    pub fn simulate_with_auth(
        &self,
        host_fn_b64: &str,
        source_b64: &str,
        auth_b64: Vec<String>,
        instruction_leeway: Option<u32>,
        ledger_seq: Option<u32>,
    ) -> Result<JsValue, JsError> {
        self.simulate_inner(
            host_fn_b64,
            source_b64,
            Some(auth_b64),
            instruction_leeway.unwrap_or(0),
            ledger_seq.unwrap_or(self.ledger_seq),
        )
    }
}

#[wasm_bindgen]
impl SorobanEnv {
    fn simulate_inner(
        &self,
        host_fn_b64: &str,
        source_b64: &str,
        auth_b64: Option<Vec<String>>,
        instruction_leeway: u32,
        ledger_seq: u32,
    ) -> Result<JsValue, JsError> {
        let host_fn: HostFunction = from_xdr_b64(host_fn_b64)?;
        let source: AccountId = from_xdr_b64(source_b64)?;

        let auth_mode = match auth_b64 {
            Some(entries) => {
                let parsed = entries
                    .iter()
                    .map(|s| from_xdr_b64::<SorobanAuthorizationEntry>(s))
                    .collect::<Result<Vec<_>, _>>()?;
                RecordingInvocationAuthMode::Enforcing(parsed)
            }
            None => RecordingInvocationAuthMode::recording(false, false),
        };

        let budget = self.make_budget(None)?;
        let mut diagnostics = Vec::new();
        let snapshot: Rc<dyn SnapshotSource> = Rc::new(SimulationSnapshot {
            inner: StoreSnapshot(Rc::clone(&self.store)),
            updated: RefCell::new(BTreeMap::new()),
        });

        let res = invoke_host_function_in_recording_mode(
            &budget,
            true,
            &host_fn,
            &source,
            auth_mode,
            LedgerInfo {
                sequence_number: ledger_seq,
                ..self.ledger_info()
            },
            snapshot,
            self.next_prng_seed(),
            &mut diagnostics,
        );

        // A top-level host error (exhausted budget, malformed input) must be an
        // observable failed simulation, not a thrown JsError — upstream's
        // soroban-simulation folds this same error in-band, and a real node
        // returns it as HTTP 200 with an `error` field.
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                let out = SimulateResult {
                    ok: false,
                    error: Some(format!("{e:?}")),
                    return_value_xdr: None,
                    resources_xdr: String::new(),
                    auth_xdr: Vec::new(),
                    restored_rw_entry_indices: Vec::new(),
                    instructions: 0,
                    adjusted_instructions: 0,
                    min_resource_fee: 0,
                    read_bytes: 0,
                    write_bytes: 0,
                    cpu_insns: budget.get_cpu_insns_consumed().unwrap_or(0),
                    mem_bytes: budget.get_mem_bytes_consumed().unwrap_or(0),
                    read_only_keys: Vec::new(),
                    read_write_keys: Vec::new(),
                    events_xdr: Vec::new(),
                    diagnostic_events_xdr: encode_diagnostics(&diagnostics),
                };
                return serde_wasm_bindgen::to_value(&out)
                    .map_err(|e| JsError::new(&format!("serialize: {e}")));
            }
        };

        let (ok, error, return_value_xdr) = match &res.invoke_result {
            Ok(v) => (true, None, Some(to_xdr_b64(v)?)),
            Err(e) => (false, Some(format!("{e:?}")), None),
        };

        let raw_instructions = res.resources.instructions;
        let mut submitted_resources = res.resources.clone();
        submitted_resources.instructions = adjust_instructions(raw_instructions, instruction_leeway);

        // soroban-simulation only prices a successful invocation.
        let min_resource_fee = if let (true, Some(settings)) = (ok, self.fee_settings.as_ref()) {
            let operation = OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
                host_function: host_fn.clone(),
                auth: res.auth.clone().try_into().map_err(xdr_err)?,
            });
            fees::preflight_resource_fee(
                settings,
                operation,
                &submitted_resources,
                &res.restored_rw_entry_indices,
                res.contract_events_and_return_value_size,
                &extract_rent_changes(&res.ledger_changes),
                // the ledger this simulation ran in, as stellar-rpc prices it
                ledger_seq,
            )
            .map_err(|e| JsError::new(&e))?
        } else {
            0
        };

        let out = SimulateResult {
            ok,
            error,
            return_value_xdr,
            resources_xdr: to_xdr_b64(&submitted_resources)?,
            auth_xdr: res
                .auth
                .iter()
                .map(to_xdr_b64)
                .collect::<Result<Vec<_>, _>>()?,
            restored_rw_entry_indices: res.restored_rw_entry_indices.clone(),
            instructions: raw_instructions,
            adjusted_instructions: submitted_resources.instructions,
            min_resource_fee,
            read_bytes: res.resources.disk_read_bytes,
            write_bytes: res.resources.write_bytes,
            cpu_insns: budget.get_cpu_insns_consumed().map_err(host_err)?,
            mem_bytes: budget.get_mem_bytes_consumed().map_err(host_err)?,
            read_only_keys: res
                .resources
                .footprint
                .read_only
                .iter()
                .map(to_xdr_b64)
                .collect::<Result<Vec<_>, _>>()?,
            read_write_keys: res
                .resources
                .footprint
                .read_write
                .iter()
                .map(to_xdr_b64)
                .collect::<Result<Vec<_>, _>>()?,
            events_xdr: res
                .contract_events
                .iter()
                .map(to_xdr_b64)
                .collect::<Result<Vec<_>, _>>()?,
            diagnostic_events_xdr: encode_diagnostics(&diagnostics),
        };
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }

    // -- requirement 1 + 3: send (enforcing) --------------------------------

    /// Enforcing mode. The footprint in `resources_b64` is a hard constraint:
    /// touching anything outside it fails the call. Applies the resulting
    /// `LedgerEntryChange`s back into the ledger.
    ///
    /// `max_refundable_fee` is what the transaction left for rent and events
    /// (declared resource fee minus the non-refundable part). Given, a call
    /// whose rent and events cost more fails with
    /// INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE and changes nothing,
    /// as in core; omitted, nothing is checked.
    pub fn send(
        &mut self,
        host_fn_b64: &str,
        source_b64: &str,
        resources_b64: &str,
        auth_b64: Vec<String>,
        restored_rw_entry_indices: Vec<u32>,
        max_refundable_fee: Option<i64>,
    ) -> Result<JsValue, JsError> {
        let resources: SorobanResources = from_xdr_b64(resources_b64)?;

        // stellar-core caps the enforcing run at the declared instruction
        // count and reports INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED when
        // it is exceeded. Without this the declared resources are decorative.
        let budget = self.make_budget(if self.enforce_declared_resources {
            Some((resources.instructions as u64).min(self.cpu_limit))
        } else {
            None
        })?;

        // One item per footprint key, in the order the host zips them against
        // the footprint; see PROTOCOL PINNING at the top of this file.
        let mut entries: Vec<(Option<Vec<u8>>, Option<TtlLedgerEntryMeta>)> = Vec::with_capacity(
            resources.footprint.read_only.len() + resources.footprint.read_write.len(),
        );
        // Contract code the module cache must hold for this call, and the code
        // this call restores, which it must not; see `prepare_module_cache`.
        let mut live_code: Vec<(Hash, Rc<LedgerEntry>)> = Vec::new();
        let mut restored_code: Vec<Hash> = Vec::new();
        // stellar-core InvokeHostFunctionOpFrame `addReads`, key by key: an
        // entry larger than the network allows fails the operation before the
        // host runs (validateContractLedgerEntry), and so does reading more
        // than the declared diskReadBytes (meterDiskReadResource). From
        // protocol 23 only classic entries and the entries the call restores
        // are disk reads; live Soroban state is in memory.
        let mut disk_read_bytes: u32 = 0;
        {
            let store = self.store.borrow();
            // Entries the simulation marked for auto-restore, by read_write index.
            let restored: std::collections::BTreeSet<&LedgerKey> = restored_rw_entry_indices
                .iter()
                .filter_map(|i| resources.footprint.read_write.get(*i as usize))
                .collect();
            let restored_live_until = self
                .ledger_seq
                .saturating_add(self.min_persistent_entry_ttl)
                .saturating_sub(1);

            let all_keys = resources
                .footprint
                .read_only
                .iter()
                .chain(resources.footprint.read_write.iter());
            for key in all_keys {
                let rc_key = Rc::new(key.clone());
                let Some((entry, live_until)) = store.get(&rc_key) else {
                    entries.push((None, None));
                    continue;
                };

                // An expired TEMPORARY entry does not exist as far as the
                // protocol is concerned: core never hands it to the host, and
                // the enforcing path rejects any TTL below the current ledger.
                if is_temporary(key) && live_until.map_or(false, |t| t < self.ledger_seq) {
                    entries.push((None, None));
                    continue;
                }

                if let LedgerKey::ContractCode(code_key) = key {
                    if restored.contains(key) {
                        restored_code.push(code_key.hash.clone());
                    } else if live_until.map_or(true, |t| t >= self.ledger_seq) {
                        live_code.push((code_key.hash.clone(), Rc::clone(entry)));
                    }
                }

                let encoded = entry.to_xdr(Limits::none()).map_err(xdr_err)?;
                // Core fails an archived entry the call does not restore
                // (ENTRY_ARCHIVED) before it would size it.
                let archived = needs_ttl(key) && !restored.contains(key) && live_until.map_or(false, |t| t < self.ledger_seq);
                if let (Some(fees), false) = (self.fee_settings.as_ref(), archived) {
                    if let Err(message) = fees.validate_contract_ledger_entry(key, encoded.len()) {
                        return self.failed_before_host(message);
                    }
                }
                if self.checks_declared_bytes() && (!needs_ttl(key) || restored.contains(key)) {
                    disk_read_bytes = disk_read_bytes.saturating_add(u32::try_from(encoded.len()).unwrap_or(u32::MAX));
                    if resources.disk_read_bytes < disk_read_bytes {
                        return self.failed_before_host(format!(
                            "operation byte-read resources exceeds amount specified: {disk_read_bytes} > {}",
                            resources.disk_read_bytes
                        ));
                    }
                }
                let ttl_meta = if needs_ttl(key) {
                    // Restoring is the EMBEDDER's job: core rewrites the TTL of
                    // an archived entry to ledgerSeq + minPersistentTTL - 1
                    // before handing it to the host, "as if they were alive".
                    let live_until_ledger = if restored.contains(key) {
                        restored_live_until
                    } else {
                        live_until.unwrap_or(self.ledger_seq)
                    };
                    // The host's own helper, so contract code is sized with the
                    // same module memory cost core charges rent on.
                    let entry_size_for_rent = entry_size_for_rent(
                        &budget,
                        entry,
                        u32::try_from(encoded.len()).unwrap_or(u32::MAX),
                    )
                    .map_err(host_err)?;
                    Some(TtlLedgerEntryMeta {
                        live_until_ledger,
                        entry_size_for_rent,
                    })
                } else {
                    None
                };
                entries.push((Some(encoded), ttl_meta));
            }
        }

        let module_cache = self.prepare_module_cache(&live_code, &restored_code)?;

        let auth_entries: Vec<Vec<u8>> = auth_b64
            .iter()
            .map(|s| b64d(s))
            .collect::<Result<Vec<_>, _>>()?;

        let mut diagnostics = Vec::new();

        let res = invoke_host_function(
            &budget,
            true,
            b64d(host_fn_b64)?,
            b64d(resources_b64)?,
            &restored_rw_entry_indices,
            b64d(source_b64)?,
            auth_entries.into_iter(),
            self.ledger_info(),
            entries.into_iter(),
            vec![0u8; 32],
            &mut diagnostics,
            None,
            Some(module_cache),
        );

        // A top-level host error (bad inputs, exhausted budget) used to escape
        // as a JsError, which no caller could observe as a failed transaction.
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                let cpu_insns = budget.get_cpu_insns_consumed().unwrap_or(0);
                let mem_bytes = budget.get_mem_bytes_consumed().unwrap_or(0);
                let out = SendResult {
                    ok: false,
                    error: Some(format!("{e:?}")),
                    return_value_xdr: None,
                    changed_keys: Vec::new(),
                    removed_keys: Vec::new(),
                    events_xdr: Vec::new(),
                    diagnostic_events_xdr: encode_diagnostics(&diagnostics),
                    cpu_insns,
                    mem_bytes,
                    ttl_changed_keys: Vec::new(),
                    result_code: Some(self.failed_call_code(&resources, cpu_insns, mem_bytes).to_string()),
                    rent_fee: 0,
                    contract_events_size_bytes: 0,
                    refundable_fee_consumed: 0,
                };
                return serde_wasm_bindgen::to_value(&out)
                    .map_err(|e| JsError::new(&format!("serialize: {e}")));
            }
        };

        let (mut ok, mut error, mut return_value_xdr) = match &res.encoded_invoke_result {
            Ok(v) => (true, None, Some(b64e(v))),
            Err(e) => (false, Some(format!("{e:?}")), None),
        };
        let cpu_insns = budget.get_cpu_insns_consumed().map_err(host_err)?;
        let mem_bytes = budget.get_mem_bytes_consumed().map_err(host_err)?;

        // stellar-core InvokeHostFunctionOpFrame::doApply, after the host
        // returns: collectEvents, then consumeRefundableResources. Either can
        // still fail the operation, and then none of its changes land.
        let mut result_code = None;
        let (mut rent_fee, mut contract_events_size_bytes, mut refundable_fee_consumed) = (0, 0, 0);
        let mut events_xdr: Vec<String> = res.encoded_contract_events.iter().map(|e| b64e(e)).collect();
        if let Ok(result_value) = &res.encoded_invoke_result {
            match self
                .check_written_entries(&res, &resources)
                .and_then(|()| self.consume_refundable(&res, result_value.len(), max_refundable_fee))
            {
                Ok((rent, size, consumed)) => {
                    rent_fee = rent;
                    contract_events_size_bytes = size;
                    refundable_fee_consumed = consumed;
                }
                Err((code, message)) => {
                    ok = false;
                    error = Some(message);
                    return_value_xdr = None;
                    events_xdr = Vec::new();
                    result_code = Some(code.to_string());
                }
            }
        } else {
            result_code = Some(self.failed_call_code(&resources, cpu_insns, mem_bytes).to_string());
        }

        let mut changed_keys = Vec::new();
        let mut removed_keys = Vec::new();
        let mut ttl_changed_keys = Vec::new();

        if ok {
            let mut store = self.store.borrow_mut();
            for ch in &res.ledger_changes {
                let key: LedgerKey =
                    LedgerKey::from_xdr(&ch.encoded_key, Limits::none()).map_err(xdr_err)?;
                let rc_key = Rc::new(key);
                let key_b64 = b64e(&ch.encoded_key);

                match (&ch.encoded_new_value, ch.read_only) {
                    (Some(nv), _) => {
                        let entry =
                            LedgerEntry::from_xdr(nv, Limits::none()).map_err(xdr_err)?;
                        let ttl = ch.ttl_change.as_ref().map(|t| t.new_live_until_ledger);
                        store.insert(rc_key, (Rc::new(entry), ttl));
                        changed_keys.push(key_b64);
                    }
                    // read-only entries can still get a TTL bump
                    (None, true) => {
                        if let Some(t) = &ch.ttl_change {
                            if let Some(slot) = store.get_mut(&rc_key) {
                                if slot.1 != Some(t.new_live_until_ledger) {
                                    ttl_changed_keys.push(key_b64.clone());
                                }
                                slot.1 = Some(t.new_live_until_ledger);
                            }
                        }
                    }
                    // read-write with no new value => removed
                    (None, false) => {
                        store.remove(&rc_key);
                        removed_keys.push(key_b64);
                    }
                }
            }
        }

        let out = SendResult {
            ok,
            error,
            return_value_xdr,
            changed_keys,
            removed_keys,
            events_xdr,
            diagnostic_events_xdr: encode_diagnostics(&diagnostics),
            cpu_insns,
            mem_bytes,
            ttl_changed_keys,
            result_code,
            rent_fee,
            contract_events_size_bytes,
            refundable_fee_consumed,
        };
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }
}

impl SorobanEnv {
    fn checks_declared_bytes(&self) -> bool {
        self.enforce_declared_resources && self.enforce_declared_bytes
    }

    /// An InvokeHostFunction that core fails while loading its footprint,
    /// before the host runs: INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED,
    /// nothing written, `message` its diagnostic.
    fn failed_before_host(&self, message: String) -> Result<JsValue, JsError> {
        let out = SendResult {
            ok: false,
            error: Some(message),
            return_value_xdr: None,
            changed_keys: Vec::new(),
            removed_keys: Vec::new(),
            events_xdr: Vec::new(),
            diagnostic_events_xdr: Vec::new(),
            cpu_insns: 0,
            mem_bytes: 0,
            ttl_changed_keys: Vec::new(),
            result_code: Some("invokeHostFunctionResourceLimitExceeded".to_string()),
            rent_fee: 0,
            contract_events_size_bytes: 0,
            refundable_fee_consumed: 0,
        };
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }

    /// stellar-core InvokeHostFunctionOpFrame `recordStorageChanges`, before
    /// anything is written: each entry the call leaves in its read-write
    /// footprint, in the host's order, must fit the network's entry size limits
    /// (validateContractLedgerEntry), and together they may not exceed the
    /// declared writeBytes. TTL entries are neither; their cost is rent.
    fn check_written_entries(
        &self,
        res: &soroban_env_host::e2e_invoke::InvokeHostFunctionResult,
        resources: &SorobanResources,
    ) -> Result<(), (&'static str, String)> {
        const LIMIT: &str = "invokeHostFunctionResourceLimitExceeded";
        let mut write_bytes: u32 = 0;
        for ch in &res.ledger_changes {
            let (false, Some(new_value)) = (ch.read_only, ch.encoded_new_value.as_ref()) else {
                continue;
            };
            if let Some(fees) = self.fee_settings.as_ref() {
                let key = LedgerKey::from_xdr(&ch.encoded_key, Limits::none()).map_err(|e| (LIMIT, format!("{e:?}")))?;
                fees.validate_contract_ledger_entry(&key, new_value.len()).map_err(|m| (LIMIT, m))?;
            }
            if self.checks_declared_bytes() {
                write_bytes = write_bytes.saturating_add(u32::try_from(new_value.len()).unwrap_or(u32::MAX));
                if resources.write_bytes < write_bytes {
                    return Err((
                        LIMIT,
                        format!(
                            "operation byte-write resources exceeds amount specified: {write_bytes} > {}",
                            resources.write_bytes
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// stellar-core InvokeHostFunctionOpFrame::invokeHostFunction, when the
    /// host fails: RESOURCE_LIMIT_EXCEEDED if it burned more instructions than
    /// declared or more memory than the network allows, TRAPPED otherwise.
    fn failed_call_code(&self, resources: &SorobanResources, cpu_insns: u64, mem_bytes: u64) -> &'static str {
        if (resources.instructions as u64) < cpu_insns || self.mem_limit < mem_bytes {
            "invokeHostFunctionResourceLimitExceeded"
        } else {
            "invokeHostFunctionTrapped"
        }
    }

    /// stellar-core InvokeHostFunctionOpFrame `collectEvents` and
    /// `consumeRefundableResources` (-> RefundableFeeTracker::
    /// consumeRefundableSorobanResources) for a call the host completed.
    /// Events count with the return value against txMaxContractEventsSizeBytes;
    /// rent is core's rust bridge, `compute_rent_fee(extract_rent_changes(..))`.
    /// Returns (rent fee, events size, refundable fee consumed), or the
    /// failure code and core's diagnostic text.
    fn consume_refundable(
        &self,
        res: &soroban_env_host::e2e_invoke::InvokeHostFunctionResult,
        return_value_size: usize,
        max_refundable_fee: Option<i64>,
    ) -> Result<(i64, u32, i64), (&'static str, String)> {
        const LIMIT: &str = "invokeHostFunctionResourceLimitExceeded";
        const SHORT: &str = "invokeHostFunctionInsufficientRefundableFee";
        // Without fee settings there is nothing to price or enforce.
        let Some(fees) = self.fee_settings.as_ref() else {
            return Ok((0, 0, 0));
        };
        let max_events = fees.tx_max_contract_events_size_bytes();
        let mut events_size: u32 = 0;
        for e in &res.encoded_contract_events {
            events_size = events_size.saturating_add(u32::try_from(e.len()).unwrap_or(u32::MAX));
            if max_events < events_size {
                return Err((LIMIT, format!("total events size exceeds network config maximum: {events_size} > {max_events}")));
            }
        }
        events_size = events_size.saturating_add(u32::try_from(return_value_size).unwrap_or(u32::MAX));
        if max_events < events_size {
            return Err((
                LIMIT,
                format!("return value pushes events size above network config maximum: {events_size} > {max_events}"),
            ));
        }

        let rent_changes: Vec<LedgerEntryRentChange> = extract_rent_changes(&res.ledger_changes);
        let rent = compute_rent_fee(&rent_changes, &fees.rent_fee_configuration(), self.ledger_seq);
        let events_fee = fees.events_fee(events_size);
        if let Some(max) = max_refundable_fee {
            if max < rent {
                return Err((
                    SHORT,
                    format!("refundable resource fee was not sufficient to cover the ledger storage rent: {rent} > {max}"),
                ));
            }
            if max < rent.saturating_add(events_fee) {
                return Err((
                    SHORT,
                    format!(
                        "refundable resource fee was not sufficient to cover the events fee after paying for ledger storage rent: {events_fee} > {}",
                        max - rent
                    ),
                ));
            }
        }
        Ok((rent, events_size, rent.saturating_add(events_fee)))
    }

    /// The module cache for one enforcing call: every live contract in the
    /// footprint parsed and ready, nothing the call restores.
    ///
    /// stellar-core hands the host a cache pre-built from the ledger, so an
    /// invocation pays `VmCachedInstantiation` (41,142 + a per-byte term)
    /// instead of re-parsing the Wasm at `VmInstantiation` (451,626). Recording
    /// mode already charges the cached price, to the shadow budget, assuming the
    /// enforcing pass will find a cache; passing none made the two halves
    /// disagree by 58-121% per invocation.
    ///
    /// One cache lives on the environment and is topped up per call. Parsing is
    /// the expensive part and a contract is parsed once, however many sends
    /// call it; adding a module that is already there is a no-op.
    ///
    /// Code the transaction RESTORES is taken out. Core cannot have cached an
    /// archived entry, so the host must compile it during execution and bill
    /// the full parse; leaving a stale module in would hide that cost. The next
    /// call puts it back.
    ///
    /// Code that does not compile is simply left out. The host then falls back
    /// to compiling it during execution and fails the call with the real error,
    /// which is what an unusable `seedWasm` blob should do.
    fn prepare_module_cache(
        &mut self,
        live_code: &[(Hash, Rc<LedgerEntry>)],
        restored_code: &[Hash],
    ) -> Result<ModuleCache, JsError> {
        let ctx = CompileCtx::new().map_err(host_err)?;
        let cache = match self.module_cache.take() {
            Some(cache) => cache,
            None => ModuleCache::new(&ctx).map_err(host_err)?,
        };
        for (hash, entry) in live_code {
            if cache.contains_module(hash).map_err(host_err)? {
                continue;
            }
            if let LedgerEntryData::ContractCode(code) = &entry.data {
                let _ = cache.parse_and_cache_module_simple(
                    &ctx,
                    self.protocol_version,
                    code.code.as_slice(),
                );
            }
        }
        for hash in restored_code {
            cache.remove_module(hash).map_err(host_err)?;
        }
        // A clone is a shallow handle on the same shared module map.
        self.module_cache = Some(cache.clone());
        Ok(cache)
    }

    /// Build a budget from the installed network cost parameters when we have
    /// them, falling back to the host's default table when we do not.
    fn make_budget(&self, cpu_limit: Option<u64>) -> Result<Budget, JsError> {
        let cpu = cpu_limit.unwrap_or(self.cpu_limit);
        match (&self.cpu_cost_params, &self.mem_cost_params) {
            (Some(cpu_params), Some(mem_params)) => Budget::try_from_configs(
                cpu,
                self.mem_limit,
                cpu_params.clone(),
                mem_params.clone(),
            )
            .map_err(host_err),
            _ => {
                let b = Budget::default();
                if let Some(limit) = cpu_limit {
                    b.reset_cpu_limit(limit).map_err(host_err)?;
                }
                Ok(b)
            }
        }
    }

    fn next_prng_seed(&self) -> [u8; 32] {
        let n = self.prng_counter.get();
        self.prng_counter.set(n.wrapping_add(1));
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&n.to_le_bytes());
        seed
    }

    fn ledger_info(&self) -> LedgerInfo {
        LedgerInfo {
            protocol_version: self.protocol_version,
            sequence_number: self.ledger_seq,
            timestamp: self.timestamp,
            network_id: self.network_id,
            base_reserve: 5_000_000,
            min_temp_entry_ttl: self.min_temp_entry_ttl,
            min_persistent_entry_ttl: self.min_persistent_entry_ttl,
            max_entry_ttl: self.max_entry_ttl,
        }
    }
}

impl SorobanEnv {
    /// soroban-simulation 29.0.2 `simulate_extend_ttl_op_resources`
    /// (resources.rs): extend every live key whose TTL ends before
    /// `ledger + extend_to`, skip missing and already-long-enough ones, refuse
    /// an expired one. The footprint is the extended keys, sorted, and every
    /// resource is 0; the rest of the cost is rent.
    ///
    /// One deliberate difference: stellar-rpc reads through an auto-restoring
    /// snapshot, so for an EXPIRED persistent key it answers with a restore
    /// preamble instead of this error. Both mean "restore it first".
    ///
    /// Also returns each extended entry's rent change, which is what its fee is.
    fn extend_ttl_resources(
        &self,
        keys: &[LedgerKey],
        extend_to: u32,
        current: u32,
    ) -> Result<(SorobanResources, Vec<LedgerEntryRentChange>), String> {
        let new_live_until = current.saturating_add(extend_to);
        let store = self.store.borrow();
        let mut extended = Vec::new();
        let mut rent_changes = Vec::new();
        for key in keys {
            if !needs_ttl(key) {
                return Err(format!(
                    "Can't extend TTL for ledger entry with key `{key:?}`. Only entries with TTL (contract data or code entries) can have it extended"
                ));
            }
            let Some((_, live_until)) = store.get(&Rc::new(key.clone())) else {
                continue;
            };
            let live_until = live_until
                .ok_or_else(|| format!("Internal error: missing TTL for ledger key that must have TTL: `{key:?}`"))?;
            // An expired TEMPORARY entry does not exist as far as the protocol
            // is concerned (nor does the auto-restoring snapshot return it).
            if is_temporary(key) && live_until < current {
                continue;
            }
            if new_live_until <= live_until {
                continue;
            }
            if live_until < current {
                return Err(format!(
                    "Can't extend for an expired entry with key: {key:?}. The entry must be restored before it can be extended."
                ));
            }
            extended.push(key.clone());
            let entry = store.get(&Rc::new(key.clone())).map(|(e, _)| Rc::clone(e)).ok_or("entry vanished")?;
            let size = self.entry_size_for_rent_of(&entry).map_err(|_| "entry size for rent".to_string())?;
            rent_changes.push(fees::rent_change_without_modification(key, size, Some(live_until), new_live_until));
        }
        extended.sort();
        let resources = SorobanResources {
            footprint: LedgerFootprint {
                read_only: extended.try_into().map_err(|_| "too many keys".to_string())?,
                read_write: Default::default(),
            },
            instructions: 0,
            disk_read_bytes: 0,
            write_bytes: 0,
        };
        Ok((resources, rent_changes))
    }

    /// soroban-simulation 29.0.2 `simulate_restore_op_resources`: only
    /// persistent keys, every one of them present; live ones are skipped. The
    /// footprint is the restored keys, sorted, and both disk-read and write
    /// bytes are their total XDR size. Also returns each entry's rent change.
    fn restore_resources(
        &self,
        keys: &[LedgerKey],
        current: u32,
    ) -> Result<(SorobanResources, Vec<LedgerEntryRentChange>), String> {
        // Preflight runs in `current` (the last closed ledger, as stellar-rpc
        // does), so the restored TTL counts from there.
        let restored_live_until = LedgerInfo { sequence_number: current, ..self.ledger_info() }
            .min_live_until_ledger_checked(ContractDataDurability::Persistent)
            .ok_or("minimum persistent live until ledger overflows")?;
        let store = self.store.borrow();
        let mut restored = Vec::new();
        let mut rent_changes = Vec::new();
        let mut bytes = 0u32;
        for key in keys {
            let persistent = matches!(key, LedgerKey::ContractCode(_))
                || matches!(key, LedgerKey::ContractData(d) if d.durability == ContractDataDurability::Persistent);
            if !persistent {
                return Err(format!(
                    "Can't restore a ledger entry with key: {key:?}. Only persistent ledger entries with TTL can be restored."
                ));
            }
            let Some((entry, live_until)) = store.get(&Rc::new(key.clone())) else {
                return Err(format!("Missing entry to restore for key {key:?}"));
            };
            let live_until = live_until
                .ok_or_else(|| format!("Internal error: missing TTL for ledger key that must have TTL: `{key:?}`"))?;
            if live_until >= current {
                continue;
            }
            restored.push(key.clone());
            let size = entry.to_xdr(Limits::none()).map_err(|e| e.to_string())?.len();
            bytes = bytes.saturating_add(u32::try_from(size).unwrap_or(u32::MAX));
            let rent_size = self.entry_size_for_rent_of(entry).map_err(|_| "entry size for rent".to_string())?;
            rent_changes.push(fees::rent_change_without_modification(key, rent_size, None, restored_live_until));
        }
        restored.sort();
        let resources = SorobanResources {
            footprint: LedgerFootprint {
                read_only: Default::default(),
                read_write: restored.try_into().map_err(|_| "too many keys".to_string())?,
            },
            instructions: 0,
            disk_read_bytes: bytes,
            write_bytes: bytes,
        };
        Ok((resources, rent_changes))
    }

    /// The resources plus the `minResourceFee` stellar-rpc quotes for them
    /// (soroban-simulation `simulate_extend_ttl_op` / `simulate_restore_op`:
    /// no events, no restored entries).
    fn footprint_simulation(
        &self,
        res: Result<(SorobanResources, Vec<LedgerEntryRentChange>), String>,
        operation: OperationBody,
        ledger_seq: u32,
    ) -> Result<JsValue, JsError> {
        let out = match res {
            Ok((r, rent_changes)) => {
                let fee = match self.fee_settings.as_ref() {
                    Some(settings) => Some(
                        fees::preflight_resource_fee(settings, operation, &r, &[], 0, &rent_changes, ledger_seq)
                            .map_err(|e| JsError::new(&e))?,
                    ),
                    None => None,
                };
                FootprintSimulation { ok: true, error: None, resources_xdr: Some(to_xdr_b64(&r)?), min_resource_fee: fee }
            }
            Err(e) => FootprintSimulation { ok: false, error: Some(e), resources_xdr: None, min_resource_fee: None },
        };
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FootprintSimulation {
    ok: bool,
    error: Option<String>,
    /// `SorobanResources` XDR for the transaction's `SorobanTransactionData`.
    resources_xdr: Option<String>,
    /// stellar-rpc's `minResourceFee` for it.
    min_resource_fee: Option<i64>,
}

/// Exposed so a harness can assert the pinned protocol at startup.
#[wasm_bindgen(js_name = hostProtocolVersion)]
pub fn host_protocol_version() -> u32 {
    soroban_env_host::e2e_testutils::e2e_test_protocol_version()
}

/// Auth entries recorded by `simulate` are unsigned. Passing them back to
/// `send` verbatim only works when the invocation needs no signature (source
/// account auth). Real signing lands in the TS layer.
#[wasm_bindgen(js_name = decodeAuthEntry)]
pub fn decode_auth_entry(b64: &str) -> Result<String, JsError> {
    let e: SorobanAuthorizationEntry = from_xdr_b64(b64)?;
    Ok(format!("{e:?}"))
}
