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

use base64::Engine;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

use soroban_env_host::budget::Budget;
use soroban_env_host::e2e_invoke::{
    invoke_host_function, invoke_host_function_in_recording_mode, RecordingInvocationAuthMode,
};
use soroban_env_host::e2e_testutils::{
    account_entry, get_account_id, get_wasm_hash, get_wasm_key, wasm_entry, DEFAULT_NETWORK_ID,
};
use soroban_env_host::storage::{EntryWithLiveUntil, SnapshotSource};
use soroban_env_host::xdr::{
    AccountId, Hash, HostFunction, LedgerEntry, LedgerEntryData, LedgerKey, LedgerKeyAccount,
    LedgerKeyContractCode, LedgerKeyContractData, LedgerKeyTrustLine, Limits, ReadXdr,
    ContractCostParams, ContractDataDurability, SorobanAuthorizationEntry, SorobanResources,
    TtlEntry, WriteXdr,
};
use soroban_env_host::{HostError, LedgerInfo};

use sha2::{Digest, Sha256};

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

/// Only ContractData/ContractCode carry a TTL. The host rejects those two
/// with an empty ttl buffer, and rejects the others with a non-empty one.
/// stellar-rpc never returns the raw recorded instruction count: recording mode
/// measures slightly less work than the enforcing pass actually does, so it
/// pads with `max(raw + 50_000, raw * 1.04)` before handing resources back.
/// Submitting the raw number produces `Error(Budget, ExceededLimit)` on apply.
fn adjust_instructions(raw: u32) -> u32 {
    let raw64 = raw as u64;
    let padded = std::cmp::max(raw64.saturating_add(50_000), (raw64 * 104) / 100);
    padded.min(u32::MAX as u64) as u32
}

/// Matches the `min_persistent_entry_ttl` in `ledger_info()`.
const MIN_PERSISTENT_ENTRY_TTL: u32 = 100_000;

fn is_temporary(k: &LedgerKey) -> bool {
    matches!(k, LedgerKey::ContractData(d) if d.durability == ContractDataDurability::Temporary)
}

fn needs_ttl(k: &LedgerKey) -> bool {
    matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_))
}

fn encode_diagnostics(events: &[soroban_env_host::xdr::DiagnosticEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| e.to_xdr(Limits::none()).ok().map(|b| b64e(&b)))
        .collect()
}

fn key_hash(k: &LedgerKey) -> Result<Hash, JsError> {
    let bytes = k.to_xdr(Limits::none()).map_err(xdr_err)?;
    Ok(Hash(Sha256::digest(&bytes).into()))
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
    /// Cost calibration. `Budget::default()` is stellar-core's
    /// `initialCpuCostParamsEntryForV20` — the table a network has BEFORE its
    /// first settings upgrade. Every live network meters with the upgraded
    /// table in `ConfigSettingContractCostParamsCpuInstructions`, so leaving
    /// this unset over-meters by 15-250% versus any real node. Load the real
    /// params with `setCostParams` to get numbers that transfer.
    cpu_cost_params: Option<ContractCostParams>,
    mem_cost_params: Option<ContractCostParams>,
    cpu_limit: u64,
    mem_limit: u64,
    /// Cap the enforcing pass at the DECLARED instruction count, the way
    /// stellar-core does.
    ///
    /// Off by default, and that is a deliberate, documented compromise: this
    /// crate passes `module_cache: None`, so the enforcing pass pays the full
    /// `VmInstantiation` Wasm-parse cost (const_term 451,626) while recording
    /// mode charges that same parse to the SHADOW budget on the assumption that
    /// enforcement will find a cache. The two halves therefore disagree by more
    /// than stellar-rpc's padding covers, and enforcing the declared limit
    /// makes every deploy fail with Error(Budget, ExceededLimit).
    /// Turn it on to test resource-limit failures; fix the module cache to make
    /// it safe as a default.
    enforce_declared_resources: bool,
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
            enforce_declared_resources: false,
        }
    }

    /// See `enforce_declared_resources`. Off by default; read the note there
    /// before turning it on.
    #[wasm_bindgen(js_name = enforceDeclaredResources)]
    pub fn set_enforce_declared_resources(&mut self, on: bool) {
        self.enforce_declared_resources = on;
    }

    /// Install the network's real cost calibration, as base64
    /// `ContractCostParams` XDR (from the `ConfigSetting` ledger entries).
    /// Without this the harness meters with the protocol-20 defaults.
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
    /// Returns the wasm hash as base64.
    ///
    /// NOTE: the parameter must NOT be called `wasm`. wasm-bindgen copies Rust
    /// parameter names verbatim into the generated JS, where a parameter named
    /// `wasm` shadows the module-level binding holding the instance exports,
    /// producing "wasm.__wbindgen_add_to_stack_pointer is not a function".
    #[wasm_bindgen(js_name = seedWasm)]
    pub fn seed_wasm(&mut self, code: &[u8]) -> Result<String, JsError> {
        let entry = wasm_entry(code);
        let key = get_wasm_key(code);
        let ttl = self.ledger_seq.saturating_add(100_000);
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
    pub fn simulate(&self, host_fn_b64: &str, source_b64: &str) -> Result<JsValue, JsError> {
        self.simulate_inner(host_fn_b64, source_b64, None)
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
    ) -> Result<JsValue, JsError> {
        self.simulate_inner(host_fn_b64, source_b64, Some(auth_b64))
    }
}

#[wasm_bindgen]
impl SorobanEnv {
    fn simulate_inner(
        &self,
        host_fn_b64: &str,
        source_b64: &str,
        auth_b64: Option<Vec<String>>,
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
        let snapshot: Rc<dyn SnapshotSource> = Rc::new(StoreSnapshot(Rc::clone(&self.store)));

        let res = invoke_host_function_in_recording_mode(
            &budget,
            true,
            &host_fn,
            &source,
            auth_mode,
            self.ledger_info(),
            snapshot,
            self.next_prng_seed(),
            &mut diagnostics,
        )
        .map_err(host_err)?;

        let (ok, error, return_value_xdr) = match &res.invoke_result {
            Ok(v) => (true, None, Some(to_xdr_b64(v)?)),
            Err(e) => (false, Some(format!("{e:?}")), None),
        };

        let raw_instructions = res.resources.instructions;
        let mut submitted_resources = res.resources.clone();
        submitted_resources.instructions = adjust_instructions(raw_instructions);

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
    pub fn send(
        &mut self,
        host_fn_b64: &str,
        source_b64: &str,
        resources_b64: &str,
        auth_b64: Vec<String>,
        restored_rw_entry_indices: Vec<u32>,
    ) -> Result<JsValue, JsError> {
        let resources: SorobanResources = from_xdr_b64(resources_b64)?;

        // The host wants every *existing* entry named by the footprint, plus a
        // parallel, equal-length iterator of TtlEntry XDR (empty for entries
        // that have no TTL). Absent footprint keys are filled in as None by the
        // host itself, so we simply skip them.
        let mut entries: Vec<Vec<u8>> = Vec::new();
        let mut ttls: Vec<Vec<u8>> = Vec::new();
        {
            let store = self.store.borrow();
            // Entries the simulation marked for auto-restore, by read_write index.
            let restored: std::collections::BTreeSet<&LedgerKey> = restored_rw_entry_indices
                .iter()
                .filter_map(|i| resources.footprint.read_write.get(*i as usize))
                .collect();
            let restored_live_until = self
                .ledger_seq
                .saturating_add(MIN_PERSISTENT_ENTRY_TTL)
                .saturating_sub(1);

            let all_keys = resources
                .footprint
                .read_only
                .iter()
                .chain(resources.footprint.read_write.iter());
            for key in all_keys {
                let rc_key = Rc::new(key.clone());
                let Some((entry, live_until)) = store.get(&rc_key) else {
                    continue;
                };

                // An expired TEMPORARY entry does not exist as far as the
                // protocol is concerned: core never hands it to the host, and
                // the enforcing path rejects any TTL below the current ledger.
                if is_temporary(key) && live_until.map_or(false, |t| t < self.ledger_seq) {
                    continue;
                }

                entries.push(entry.to_xdr(Limits::none()).map_err(xdr_err)?);
                if needs_ttl(key) {
                    // Restoring is the EMBEDDER's job: core rewrites the TTL of
                    // an archived entry to ledgerSeq + minPersistentTTL - 1
                    // before handing it to the host, "as if they were alive".
                    let live = if restored.contains(key) {
                        restored_live_until
                    } else {
                        live_until.unwrap_or(self.ledger_seq)
                    };
                    let ttl = TtlEntry {
                        key_hash: key_hash(key)?,
                        live_until_ledger_seq: live,
                    };
                    ttls.push(ttl.to_xdr(Limits::none()).map_err(xdr_err)?);
                } else {
                    ttls.push(Vec::new());
                }
            }
        }

        let auth_entries: Vec<Vec<u8>> = auth_b64
            .iter()
            .map(|s| b64d(s))
            .collect::<Result<Vec<_>, _>>()?;

        // stellar-core caps the enforcing run at the declared instruction
        // count and reports INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED when
        // it is exceeded. Without this the declared resources are decorative.
        let budget = self.make_budget(if self.enforce_declared_resources {
            Some(resources.instructions as u64)
        } else {
            None
        })?;
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
            ttls.into_iter(),
            vec![0u8; 32],
            &mut diagnostics,
            None,
            None,
        );

        // A top-level host error (bad inputs, exhausted budget) used to escape
        // as a JsError, which no caller could observe as a failed transaction.
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                let out = SendResult {
                    ok: false,
                    error: Some(format!("{e:?}")),
                    return_value_xdr: None,
                    changed_keys: Vec::new(),
                    removed_keys: Vec::new(),
                    events_xdr: Vec::new(),
                    diagnostic_events_xdr: encode_diagnostics(&diagnostics),
                    cpu_insns: budget.get_cpu_insns_consumed().unwrap_or(0),
                    mem_bytes: budget.get_mem_bytes_consumed().unwrap_or(0),
                    ttl_changed_keys: Vec::new(),
                };
                return serde_wasm_bindgen::to_value(&out)
                    .map_err(|e| JsError::new(&format!("serialize: {e}")));
            }
        };

        let (ok, error, return_value_xdr) = match &res.encoded_invoke_result {
            Ok(v) => (true, None, Some(b64e(v))),
            Err(e) => (false, Some(format!("{e:?}")), None),
        };

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
            events_xdr: res.encoded_contract_events.iter().map(|e| b64e(e)).collect(),
            diagnostic_events_xdr: encode_diagnostics(&diagnostics),
            cpu_insns: budget.get_cpu_insns_consumed().map_err(host_err)?,
            mem_bytes: budget.get_mem_bytes_consumed().map_err(host_err)?,
            ttl_changed_keys,
        };
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }
}

impl SorobanEnv {
    /// Build a budget from the installed network cost parameters when we have
    /// them, falling back to the host's protocol-20 defaults when we do not.
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
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 100_000,
            max_entry_ttl: 10_000_000,
        }
    }
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
