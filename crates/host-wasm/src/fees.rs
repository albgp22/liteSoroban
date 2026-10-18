//! Soroban resource fees and rent, the way stellar-core charges them and
//! stellar-rpc's preflight quotes them.
//!
//! Every number comes out of soroban-env-host's own `fees` module (29.0.2):
//! stellar-core v29.0.0 calls the same functions through its rust bridge
//! (src/rust/src/soroban_proto_any.rs) and soroban-simulation 29.0.2 calls them
//! in preflight (resources.rs). This file only assembles their inputs the way
//! each caller does, and says where.

use soroban_env_host::e2e_invoke::entry_size_for_rent;
use soroban_env_host::fees::{
    compute_rent_fee, compute_rent_write_fee_per_1kb, compute_transaction_resource_fee,
    FeeConfiguration, LedgerEntryRentChange, RentFeeConfiguration, RentWriteFeeConfiguration,
    TransactionResources,
};
use soroban_env_host::xdr::{
    BytesM, ContractDataDurability, DecoratedSignature, Duration, Hash, LedgerBounds, LedgerEntry,
    LedgerFootprint, LedgerKey, Limits, Memo, MuxedAccount, MuxedAccountMed25519, Operation,
    OperationBody, Preconditions, PreconditionsV2, SequenceNumber, Signature, SignatureHint,
    SignerKey, SignerKeyEd25519SignedPayload, SorobanResources, SorobanResourcesExtV0,
    SorobanTransactionData, SorobanTransactionDataExt, TimeBounds, TimePoint, Transaction,
    TransactionExt, TransactionV1Envelope, Uint256, WriteXdr,
};
use wasm_bindgen::prelude::*;

use crate::{from_xdr_b64, host_err, SorobanEnv};

/// A network's fee-related `ConfigSetting` entries, field for field as
/// `SorobanNetworkConfig` (stellar-core src/ledger/NetworkConfig.cpp) and
/// soroban-simulation's `NetworkConfig::load_from_snapshot` read them. The
/// classic layer installs one at construction; see src/fee-settings.ts.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkFeeSettings {
    // CONFIG_SETTING_CONTRACT_COMPUTE_V0
    fee_rate_per_instructions_increment: i64,
    // CONFIG_SETTING_CONTRACT_LEDGER_COST_V0
    fee_disk_read_ledger_entry: i64,
    fee_write_ledger_entry: i64,
    fee_disk_read_1kb: i64,
    soroban_state_target_size_bytes: i64,
    rent_fee_1kb_soroban_state_size_low: i64,
    rent_fee_1kb_soroban_state_size_high: i64,
    soroban_state_rent_fee_growth_factor: u32,
    // CONFIG_SETTING_CONTRACT_LEDGER_COST_EXT_V0
    fee_write_1kb: i64,
    // CONFIG_SETTING_CONTRACT_HISTORICAL_DATA_V0
    fee_historical_1kb: i64,
    // CONFIG_SETTING_CONTRACT_EVENTS_V0
    tx_max_contract_events_size_bytes: u32,
    fee_contract_events_1kb: i64,
    // CONFIG_SETTING_CONTRACT_BANDWIDTH_V0
    fee_tx_size_1kb: i64,
    // CONFIG_SETTING_CONTRACT_MAX_SIZE_BYTES
    max_contract_size_bytes: u32,
    // CONFIG_SETTING_CONTRACT_DATA_ENTRY_SIZE_BYTES
    max_contract_data_entry_size_bytes: u32,
    // CONFIG_SETTING_STATE_ARCHIVAL
    persistent_rent_rate_denominator: i64,
    temp_rent_rate_denominator: i64,
    // CONFIG_SETTING_LIVE_SOROBAN_STATE_SIZE_WINDOW, averaged (integer division)
    average_soroban_state_size: i64,
}

impl NetworkFeeSettings {
    /// `SorobanNetworkConfig::rustBridgeFeeConfiguration`, protocol 23+ (the
    /// write fee is the flat `feeWrite1KB`).
    pub(crate) fn fee_configuration(&self) -> FeeConfiguration {
        FeeConfiguration {
            fee_per_instruction_increment: self.fee_rate_per_instructions_increment,
            fee_per_disk_read_entry: self.fee_disk_read_ledger_entry,
            fee_per_write_entry: self.fee_write_ledger_entry,
            fee_per_disk_read_1kb: self.fee_disk_read_1kb,
            fee_per_write_1kb: self.fee_write_1kb,
            fee_per_historical_1kb: self.fee_historical_1kb,
            fee_per_contract_event_1kb: self.fee_contract_events_1kb,
            fee_per_transaction_size_1kb: self.fee_tx_size_1kb,
        }
    }

    /// `SorobanNetworkConfig::computeRentWriteFee`: the rent rate follows the
    /// average live Soroban state size.
    pub(crate) fn fee_per_rent_1kb(&self) -> i64 {
        compute_rent_write_fee_per_1kb(
            self.average_soroban_state_size,
            &RentWriteFeeConfiguration {
                state_target_size_bytes: self.soroban_state_target_size_bytes,
                rent_fee_1kb_state_size_low: self.rent_fee_1kb_soroban_state_size_low,
                rent_fee_1kb_state_size_high: self.rent_fee_1kb_soroban_state_size_high,
                state_size_rent_fee_growth_factor: self.soroban_state_rent_fee_growth_factor,
            },
        )
    }

    /// `SorobanNetworkConfig::rustBridgeRentFeeConfiguration`.
    pub(crate) fn rent_fee_configuration(&self) -> RentFeeConfiguration {
        RentFeeConfiguration {
            fee_per_write_1kb: self.fee_write_1kb,
            fee_per_rent_1kb: self.fee_per_rent_1kb(),
            fee_per_write_entry: self.fee_write_ledger_entry,
            persistent_rent_rate_denominator: self.persistent_rent_rate_denominator,
            temporary_rent_rate_denominator: self.temp_rent_rate_denominator,
        }
    }

    pub(crate) fn tx_max_contract_events_size_bytes(&self) -> u32 {
        self.tx_max_contract_events_size_bytes
    }

    /// stellar-core TransactionUtils.cpp `validateContractLedgerEntry`: a
    /// ContractCode entry may be at most maxContractSizeBytes and a
    /// ContractData entry at most maxContractDataEntrySizeBytes, both as XDR.
    /// Every other entry passes. The error is core's diagnostic text.
    pub(crate) fn validate_contract_ledger_entry(&self, key: &LedgerKey, entry_size: usize) -> Result<(), String> {
        match key {
            LedgerKey::ContractCode(_) if (self.max_contract_size_bytes as usize) < entry_size => Err(format!(
                "Wasm size exceeds network config maximum contract size: {entry_size} > {}",
                self.max_contract_size_bytes
            )),
            LedgerKey::ContractData(_) if (self.max_contract_data_entry_size_bytes as usize) < entry_size => Err(format!(
                "ContractData size exceeds network config maximum size: {entry_size} > {}",
                self.max_contract_data_entry_size_bytes
            )),
            _ => Ok(()),
        }
    }

    /// The refundable half of the resource fee for `events_size` bytes of
    /// contract events and return value. From protocol 23 that is all
    /// `compute_transaction_resource_fee` puts in it; rent is charged apart.
    pub(crate) fn events_fee(&self, events_size: u32) -> i64 {
        compute_transaction_resource_fee(
            &TransactionResources {
                instructions: 0,
                disk_read_entries: 0,
                write_entries: 0,
                disk_read_bytes: 0,
                write_bytes: 0,
                contract_events_size_bytes: events_size,
                transaction_size_bytes: 0,
            },
            &self.fee_configuration(),
        )
        .1
    }
}

fn is_soroban_key(k: &LedgerKey) -> bool {
    matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_))
}

/// stellar-core TransactionFrame.cpp `getNumDiskReadEntries` (protocol 23+):
/// every entry of a RestoreFootprint, otherwise the classic keys plus the
/// archived Soroban entries the transaction marks for restoring. Live Soroban
/// state is in memory and costs no disk read.
fn num_disk_read_entries(data: &SorobanTransactionData, is_restore: bool) -> u32 {
    let fp = &data.resources.footprint;
    if is_restore {
        return fp.read_write.len() as u32;
    }
    let classic = fp.read_only.iter().chain(fp.read_write.iter()).filter(|k| !is_soroban_key(k)).count();
    let archived = match &data.ext {
        SorobanTransactionDataExt::V1(ext) => ext.archived_soroban_entries.len(),
        SorobanTransactionDataExt::V0 => 0,
    };
    (classic + archived) as u32
}

/// soroban-simulation 29.0.2 `SimulationAdjustmentFactor::adjust_u32` / `adjust_i64`.
fn adjust_u32(value: u32, multiplicative: f64, additive: u32) -> u32 {
    if value == 0 {
        return 0;
    }
    value
        .saturating_add(additive)
        .max(((value as f64) * multiplicative).clamp(0.0, u32::MAX as f64).floor() as u32)
}

fn adjust_i64(value: i64, multiplicative: f64, additive: u32) -> i64 {
    if value == 0 {
        return 0;
    }
    value
        .saturating_add(additive as i64)
        .max(((value as f64) * multiplicative).clamp(0.0, i64::MAX as f64).floor() as i64)
}

/// soroban-simulation 29.0.2 `estimate_max_transaction_size_for_operation`
/// (resources.rs): the operation in the largest envelope it could ship in,
/// 20 signatures, a muxed source, PRECOND_V2 with two signed-payload signers.
fn estimate_max_transaction_size(
    operation: OperationBody,
    footprint: &LedgerFootprint,
    restored_rw_entry_ids: &[u32],
) -> Result<u32, String> {
    let e = |x: soroban_env_host::xdr::Error| x.to_string();
    let source = MuxedAccount::MuxedEd25519(MuxedAccountMed25519 { id: 0, ed25519: Uint256([0; 32]) });
    let bytes64: BytesM<64> = vec![0; 64].try_into().map_err(e)?;
    let signatures: Vec<DecoratedSignature> = vec![
        DecoratedSignature { hint: SignatureHint([0; 4]), signature: Signature(bytes64.clone()) };
        20
    ];
    let signer_key = SignerKey::Ed25519SignedPayload(SignerKeyEd25519SignedPayload {
        ed25519: Uint256([0; 32]),
        payload: bytes64,
    });
    let envelope = TransactionV1Envelope {
        tx: Transaction {
            source_account: source.clone(),
            fee: 0,
            seq_num: SequenceNumber(0),
            cond: Preconditions::V2(PreconditionsV2 {
                time_bounds: Some(TimeBounds { min_time: TimePoint(0), max_time: TimePoint(0) }),
                ledger_bounds: Some(LedgerBounds { min_ledger: 0, max_ledger: 0 }),
                min_seq_num: Some(SequenceNumber(0)),
                min_seq_age: Duration(0),
                min_seq_ledger_gap: 0,
                extra_signers: vec![signer_key.clone(), signer_key].try_into().map_err(e)?,
            }),
            memo: Memo::Hash(Hash([0; 32])),
            operations: vec![Operation { source_account: Some(source), body: operation }]
                .try_into()
                .map_err(e)?,
            ext: TransactionExt::V1(SorobanTransactionData {
                resources: SorobanResources {
                    footprint: footprint.clone(),
                    instructions: 0,
                    disk_read_bytes: 0,
                    write_bytes: 0,
                },
                resource_fee: 0,
                ext: SorobanTransactionDataExt::V1(SorobanResourcesExtV0 {
                    archived_soroban_entries: restored_rw_entry_ids.to_vec().try_into().map_err(e)?,
                }),
            }),
        },
        signatures: signatures.try_into().map_err(e)?,
    };
    let size = envelope.to_xdr(Limits::none()).map_err(e)?.len();
    u32::try_from(size).map_err(|x| x.to_string())
}

/// What stellar-rpc's preflight quotes as `minResourceFee`: soroban-simulation
/// 29.0.2 `compute_adjusted_transaction_resources` + `compute_resource_fee`
/// under `SimulationAdjustmentConfig::default_adjustment()`. The instruction
/// count in `resources` is expected already padded (see `adjust_instructions`
/// in lib.rs); read and write bytes are not adjusted, the envelope size is
/// x1.1 / +500 and the refundable part (events + rent) x1.15.
pub(crate) fn preflight_resource_fee(
    settings: &NetworkFeeSettings,
    operation: OperationBody,
    resources: &SorobanResources,
    restored_rw_entry_ids: &[u32],
    contract_events_and_return_value_size: u32,
    rent_changes: &[LedgerEntryRentChange],
    ledger_seq: u32,
) -> Result<i64, String> {
    let fp = &resources.footprint;
    let disk_read_entries = fp.read_only.iter().chain(fp.read_write.iter()).filter(|k| !is_soroban_key(k)).count()
        as u32
        + restored_rw_entry_ids.len() as u32;
    let tx_size = estimate_max_transaction_size(operation, fp, restored_rw_entry_ids)?;
    let tx_resources = TransactionResources {
        instructions: resources.instructions,
        disk_read_entries,
        write_entries: fp.read_write.len() as u32,
        disk_read_bytes: resources.disk_read_bytes,
        write_bytes: resources.write_bytes,
        contract_events_size_bytes: contract_events_and_return_value_size,
        transaction_size_bytes: adjust_u32(tx_size, 1.1, 500),
    };
    let (non_refundable, refundable) =
        compute_transaction_resource_fee(&tx_resources, &settings.fee_configuration());
    let rent = compute_rent_fee(rent_changes, &settings.rent_fee_configuration(), ledger_seq);
    Ok(non_refundable.saturating_add(adjust_i64(refundable.saturating_add(rent), 1.15, 0)))
}

/// The rent change of an entry whose TTL moves and whose bytes do not
/// (ExtendFootprintTTL), or that comes back from the archive (RestoreFootprint,
/// `old_live_until` None): stellar-core TransactionUtils.cpp
/// `createEntryRentChangeWithoutModification`, and soroban-simulation's
/// `simulate_extend_ttl_op_resources` / `simulate_restore_op_resources`.
pub(crate) fn rent_change_without_modification(
    key: &LedgerKey,
    entry_size_for_rent: u32,
    old_live_until: Option<u32>,
    new_live_until: u32,
) -> LedgerEntryRentChange {
    LedgerEntryRentChange {
        is_persistent: !matches!(key, LedgerKey::ContractData(d) if d.durability == ContractDataDurability::Temporary),
        is_code_entry: matches!(key, LedgerKey::ContractCode(_)),
        old_size_bytes: if old_live_until.is_some() { entry_size_for_rent } else { 0 },
        new_size_bytes: entry_size_for_rent,
        old_live_until_ledger: old_live_until.unwrap_or(0),
        new_live_until_ledger: new_live_until,
    }
}

impl SorobanEnv {
    pub(crate) fn fees(&self) -> Result<&NetworkFeeSettings, String> {
        self.fee_settings
            .as_ref()
            .ok_or_else(|| "no network fee settings installed (setFeeSettings)".to_string())
    }

    /// `ledgerEntrySizeForRent` (stellar-core src/ledger/LedgerTypeUtils.cpp):
    /// the XDR size, plus the parsed module's memory for contract code, priced
    /// with the installed cost parameters.
    pub(crate) fn entry_size_for_rent_of(&self, entry: &LedgerEntry) -> Result<u32, JsError> {
        let budget = self.make_budget(None)?;
        let xdr_size = entry.to_xdr(Limits::none()).map_err(crate::xdr_err)?.len();
        entry_size_for_rent(&budget, entry, u32::try_from(xdr_size).unwrap_or(u32::MAX)).map_err(host_err)
    }
}

#[wasm_bindgen]
impl SorobanEnv {
    /// Install a network's fee settings: an object with the fields of
    /// `NetworkFeeSettings`, camelCase, as numbers.
    #[wasm_bindgen(js_name = setFeeSettings)]
    pub fn set_fee_settings(&mut self, settings: JsValue) -> Result<(), JsError> {
        let parsed: NetworkFeeSettings = serde_wasm_bindgen::from_value(settings)
            .map_err(|e| JsError::new(&format!("fee settings: {e}")))?;
        self.fee_settings = Some(parsed);
        Ok(())
    }

    /// The rent rate those settings imply at their average state size.
    #[wasm_bindgen(getter, js_name = feePerRent1kb)]
    pub fn fee_per_rent_1kb(&self) -> Result<i64, JsError> {
        Ok(self.fees().map_err(|e| JsError::new(&e))?.fee_per_rent_1kb())
    }

    /// stellar-core `TransactionFrame::computeSorobanResourceFee` for a
    /// transaction's `SorobanTransactionData`: [non_refundable, refundable].
    /// `tx_size` is the XDR size of the (inner) transaction envelope.
    #[wasm_bindgen(js_name = computeResourceFee)]
    pub fn compute_resource_fee(
        &self,
        soroban_data_b64: &str,
        tx_size: u32,
        events_size: u32,
        is_restore: bool,
    ) -> Result<Vec<i64>, JsError> {
        let data: SorobanTransactionData = from_xdr_b64(soroban_data_b64)?;
        let fees = self.fees().map_err(|e| JsError::new(&e))?;
        let r = &data.resources;
        let (non_refundable, refundable) = compute_transaction_resource_fee(
            &TransactionResources {
                instructions: r.instructions,
                disk_read_entries: num_disk_read_entries(&data, is_restore),
                write_entries: r.footprint.read_write.len() as u32,
                disk_read_bytes: r.disk_read_bytes,
                write_bytes: r.write_bytes,
                contract_events_size_bytes: events_size,
                transaction_size_bytes: tx_size,
            },
            &fees.fee_configuration(),
        );
        Ok(vec![non_refundable, refundable])
    }

    /// `ledgerEntrySizeForRent` of the entry stored under `key_b64`, or None.
    #[wasm_bindgen(js_name = entrySizeForRent)]
    pub fn entry_size_for_rent(&self, key_b64: &str) -> Result<Option<u32>, JsError> {
        let key: LedgerKey = from_xdr_b64(key_b64)?;
        let entry = self.store.borrow().get(&std::rc::Rc::new(key)).map(|(e, _)| std::rc::Rc::clone(e));
        match entry {
            Some(e) => Ok(Some(self.entry_size_for_rent_of(&e)?)),
            None => Ok(None),
        }
    }

    /// `compute_rent_fee` at the current ledger over ExtendFootprintTTL /
    /// RestoreFootprint rent changes, each given as its key, its rent size,
    /// and its TTL before (`0` for an entry coming back from the archive) and
    /// after.
    #[wasm_bindgen(js_name = computeRentFee)]
    pub fn compute_rent_fee_for(
        &self,
        keys_b64: Vec<String>,
        sizes: Vec<u32>,
        old_live_until: Vec<u32>,
        new_live_until: Vec<u32>,
    ) -> Result<i64, JsError> {
        let fees = self.fees().map_err(|e| JsError::new(&e))?;
        let mut changes = Vec::with_capacity(keys_b64.len());
        for (i, k) in keys_b64.iter().enumerate() {
            let key: LedgerKey = from_xdr_b64(k)?;
            let old = old_live_until.get(i).copied().filter(|t| *t != 0);
            changes.push(rent_change_without_modification(
                &key,
                sizes.get(i).copied().unwrap_or(0),
                old,
                new_live_until.get(i).copied().unwrap_or(0),
            ));
        }
        Ok(compute_rent_fee(&changes, &fees.rent_fee_configuration(), self.ledger_seq))
    }
}
