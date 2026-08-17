/**
 * TTL, state archival and auto-restore.
 *
 * Every expected number here is derived from the pinned host's own rules, not
 * from what this harness happens to return:
 *
 *   soroban-env-host-27.0.1/src/ledger_info.rs:16-30
 *     min_live_until_ledger_checked(d) = seq + min_{temp,persistent}_entry_ttl - 1
 *     max_live_until_ledger_checked()  = seq + max_entry_ttl - 1
 *
 *   soroban-env-host-27.0.1/src/storage.rs:530-573  (extend_ttl)
 *     new_live_until = min(seq + extend_to, max_live_until)
 *     applied only when (old_live_until - seq) <= threshold, and only when it
 *     grows the value.
 *
 *   soroban-env-host-27.0.1/src/storage.rs:721-767  (handle_maybe_expired_entry)
 *     recording mode: an expired TEMPORARY entry reads as absent; an expired
 *     PERSISTENT entry is auto-restored, promoted to the READ-WRITE footprint
 *     and given seq + min_persistent_entry_ttl - 1.
 *
 * The harness's LedgerInfo (crates/host-wasm/src/lib.rs:582-593) is
 * byte-identical to upstream's `default_ledger_info()`
 * (soroban-env-host-27.0.1/src/e2e_testutils.rs:105-116):
 * min_temp_entry_ttl 16, min_persistent_entry_ttl 100_000, max_entry_ttl
 * 10_000_000.
 *
 * ---------------------------------------------------------------------------
 * KNOWN HARNESS GAPS pinned by the failing tests below. Both live in
 * `SorobanEnv::send` (crates/host-wasm/src/lib.rs:466-491), which feeds the
 * enforcing path the raw stored `live_until` for every footprint key:
 *
 *   let ttl = TtlEntry { key_hash, live_until_ledger_seq: live_until.unwrap_or(self.ledger_seq) };
 *
 * `invoke_host_function` rejects ANY ttl entry with
 * `live_until_ledger_seq < ledger_num` in enforcing mode
 * (e2e_invoke.rs:1072-1080), so every send that touches an expired entry
 * throws `Error(Storage, InternalError)` before the contract even runs.
 *
 *   1. Auto-restore is unreachable through send(). stellar-core rewrites the
 *      TTL of each auto-restored entry to `ledgerSeq + minPersistentTTL - 1`
 *      and hands it to the host "as if [it] were live"
 *      (InvokeHostFunctionOpFrame.cpp:556-559, 1220-1245). The harness must do
 *      the same for the keys named by `restored_rw_entry_indices`.
 *   2. Expired TEMPORARY entries are never dropped. core evicts them, so they
 *      simply are not in the host inputs; the harness passes them with an
 *      expired TTL and trips the same check. They also stay visible through
 *      getEntry()/entryCount() forever.
 *
 * Confirmed by construction: pre-writing the restored live_until with
 * putEntry(), or removeEntry() on the dead temporary key, makes every one of
 * these tests pass with exactly the values asserted here.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);

// -- the pinned network's state-archival settings ---------------------------
const MIN_TEMP_ENTRY_TTL = 16;
const MIN_PERSISTENT_ENTRY_TTL = 100_000;
const MAX_ENTRY_TTL = 10_000_000;
/** `new Ledger()` starts here (src/index.ts:65). */
const START_SEQ = 1_000_000;

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });

/** seq + min_persistent_entry_ttl - 1 */
const minPersistentLiveUntil = (seq: number) => seq + MIN_PERSISTENT_ENTRY_TTL - 1;
/** seq + min_temp_entry_ttl - 1 */
const minTempLiveUntil = (seq: number) => seq + MIN_TEMP_ENTRY_TTL - 1;
/** seq + max_entry_ttl - 1 */
const maxLiveUntil = (seq: number) => seq + MAX_ENTRY_TTL - 1;

// -- ledger keys ------------------------------------------------------------

function contractDataKey(
  contract: xdr.ScAddress,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract, key, durability }),
  ).toXDR('base64');
}

const persistentKey = (c: xdr.ScAddress, k: string) =>
  contractDataKey(c, sym(k), xdr.ContractDataDurability.persistent());
const temporaryKey = (c: xdr.ScAddress, k: string) =>
  contractDataKey(c, sym(k), xdr.ContractDataDurability.temporary());
const instanceKey = (c: xdr.ScAddress) =>
  contractDataKey(
    c,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ContractDataDurability.persistent(),
  );
const codeKey = (wasmHashB64: string) =>
  xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashB64, 'base64') }),
  ).toXDR('base64');

// -- helpers ----------------------------------------------------------------

interface Deployed {
  addr: xdr.ScAddress;
  wasmHash: string;
}

function deploy(L: Ledger, source: string): Deployed {
  const wasmHash = L.seedWasm(CONTRACT_DATA);
  const { sent } = L.simulateAndSend(createContractHostFn(source, wasmHash), source);
  expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
  return { addr: xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address(), wasmHash };
}

/** simulate -> send, asserting both legs. Returns the simulation for inspection. */
function call(L: Ledger, addr: xdr.ScAddress, fn: string, args: xdr.ScVal[], source: string) {
  const hostFn = invokeHostFn(addr, fn, args);
  const sim = L.simulate(hostFn, source);
  expect(sim.ok, `simulate ${fn} failed: ${sim.error}`).toBe(true);
  const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
  expect(sent.ok, `send ${fn} failed: ${sent.error}`).toBe(true);
  return { sim, sent };
}

/** Read-only invocation through recording mode. */
function read(L: Ledger, addr: xdr.ScAddress, fn: string, args: xdr.ScVal[], source: string) {
  return L.simulate(invokeHostFn(addr, fn, args), source);
}

const nativeReturn = (sim: { returnValueXdr?: string }) =>
  scValToNative(xdr.ScVal.fromXDR(sim.returnValueXdr!, 'base64'));

describe('TTL, state archival and auto-restore', () => {
  let L: Ledger;
  let source: string;

  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
  });

  // -------------------------------------------------------------------------
  // persistent entries: initial TTL
  // -------------------------------------------------------------------------

  it('a written persistent entry gets live_until = seq + min_persistent_entry_ttl - 1', () => {
    expect(L.ledgerSeq).toBe(START_SEQ);
    const { addr } = deploy(L, source);

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);

    // ledger_info.rs:16-23 — min_live_until_ledger_checked(Persistent).
    expect(L.getEntryTtl(persistentKey(addr, 'k'))).toBe(minPersistentLiveUntil(START_SEQ));
    expect(minPersistentLiveUntil(START_SEQ)).toBe(1_099_999);
  });

  it('the contract instance written by CreateContract gets the same initial TTL', () => {
    const { addr } = deploy(L, source);
    expect(L.getEntryTtl(instanceKey(addr))).toBe(minPersistentLiveUntil(START_SEQ));
  });

  it('a persistent entry written at a later ledger gets a TTL relative to THAT ledger', () => {
    const { addr } = deploy(L, source);
    L.advanceLedgers(500);
    expect(L.ledgerSeq).toBe(START_SEQ + 500);

    call(L, addr, 'put_persistent', [sym('later'), u64(1n)], source);
    expect(L.getEntryTtl(persistentKey(addr, 'later'))).toBe(
      minPersistentLiveUntil(START_SEQ + 500),
    );
  });

  // -------------------------------------------------------------------------
  // extend_persistent
  // -------------------------------------------------------------------------

  it('extend_persistent(key, threshold, extend_to) sets live_until = seq + extend_to', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    expect(L.getEntryTtl(key)).toBe(minPersistentLiveUntil(START_SEQ));

    // current_ttl = 1_099_999 - 1_000_000 = 99_999, which is <= threshold, so
    // the extension applies. storage.rs:530-573.
    call(L, addr, 'extend_persistent', [sym('k'), u32(100_000), u32(500_000)], source);

    expect(L.getEntryTtl(key)).toBe(START_SEQ + 500_000);
    expect(L.getEntryTtl(key)).toBe(1_500_000);

    // The value is untouched by a TTL extension.
    expect(nativeReturn(read(L, addr, 'get_persistent', [sym('k')], source))).toBe(42n);
  });

  it('extend_persistent is a no-op when the current TTL is above the threshold', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    call(L, addr, 'extend_persistent', [sym('k'), u32(100_000), u32(500_000)], source);
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 500_000);

    // current_ttl is now 500_000, far above threshold 10 -> no extension.
    call(L, addr, 'extend_persistent', [sym('k'), u32(10), u32(900_000)], source);
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 500_000);
  });

  it('extend_persistent rejects threshold > extend_to', () => {
    // storage.rs:544-553 — this guard is what makes a TTL "shrink" unreachable:
    // extend_to >= threshold >= current_ttl, so seq + extend_to can never fall
    // below the existing live_until.
    const { addr } = deploy(L, source);
    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);

    const sim = L.simulate(
      invokeHostFn(addr, 'extend_persistent', [sym('k'), u32(600_000), u32(200_000)]),
      source,
    );
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/Storage/);
    expect(sim.error).toMatch(/InvalidInput/);
  });

  it('extending to exactly the current live_until leaves it unchanged', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    call(L, addr, 'extend_persistent', [sym('k'), u32(100_000), u32(500_000)], source);
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 500_000);

    // current_ttl = 500_000 <= threshold, so the threshold gate opens, but
    // new == old and apply_ttl_extension (storage.rs:502-514) only writes when
    // new > old.
    call(L, addr, 'extend_persistent', [sym('k'), u32(500_000), u32(500_000)], source);
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 500_000);
  });

  // -------------------------------------------------------------------------
  // max_entry_ttl ceiling
  // -------------------------------------------------------------------------

  it('max_entry_ttl clamps a persistent extension to seq + max_entry_ttl - 1', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    // extend_to is twice the network maximum; persistent entries clamp.
    call(L, addr, 'extend_persistent', [sym('k'), u32(200_000), u32(2 * MAX_ENTRY_TTL)], source);

    expect(L.getEntryTtl(key)).toBe(maxLiveUntil(START_SEQ));
    expect(L.getEntryTtl(key)).toBe(10_999_999);
  });

  it('an entry already at the ceiling cannot be pushed past it', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    call(L, addr, 'extend_persistent', [sym('k'), u32(200_000), u32(2 * MAX_ENTRY_TTL)], source);
    expect(L.getEntryTtl(key)).toBe(maxLiveUntil(START_SEQ));

    call(
      L,
      addr,
      'extend_persistent',
      [sym('k'), u32(2 * MAX_ENTRY_TTL), u32(2 * MAX_ENTRY_TTL)],
      source,
    );
    expect(L.getEntryTtl(key)).toBe(maxLiveUntil(START_SEQ));
  });

  it('a TEMPORARY extension past max_entry_ttl is an error, not a clamp', () => {
    // storage.rs:477-489: "for Temporary entries TTL has to be exact", so
    // extend_to > max_entry_ttl - 1 fails with Error(Storage, InvalidAction).
    const { addr } = deploy(L, source);
    call(L, addr, 'put_temporary', [sym('t'), u64(7n)], source);

    const sim = L.simulate(
      invokeHostFn(addr, 'extend_temporary', [
        sym('t'),
        u32(2 * MAX_ENTRY_TTL),
        u32(2 * MAX_ENTRY_TTL),
      ]),
      source,
    );
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/Storage/);
    expect(sim.error).toMatch(/InvalidAction/);
  });

  // -------------------------------------------------------------------------
  // temporary entries
  // -------------------------------------------------------------------------

  it('a temporary entry gets live_until = seq + min_temp_entry_ttl - 1 and dies past it', () => {
    const { addr } = deploy(L, source);
    const key = temporaryKey(addr, 't');

    call(L, addr, 'put_temporary', [sym('t'), u64(7n)], source);
    expect(L.getEntryTtl(key)).toBe(minTempLiveUntil(START_SEQ));
    expect(L.getEntryTtl(key)).toBe(1_000_015);

    expect(nativeReturn(read(L, addr, 'has_temporary', [sym('t')], source))).toBe(true);

    // live_until >= seq is still LIVE (storage.rs:660).
    L.advanceLedgers(MIN_TEMP_ENTRY_TTL - 1);
    expect(L.ledgerSeq).toBe(1_000_015);
    expect(nativeReturn(read(L, addr, 'has_temporary', [sym('t')], source))).toBe(true);
    expect(nativeReturn(read(L, addr, 'get_temporary', [sym('t')], source))).toBe(7n);

    // One more ledger and live_until < seq: the host must not see it any more.
    L.advanceLedgers(1);
    expect(L.ledgerSeq).toBe(1_000_016);
    expect(nativeReturn(read(L, addr, 'has_temporary', [sym('t')], source))).toBe(false);

    const gone = read(L, addr, 'get_temporary', [sym('t')], source);
    expect(gone.ok, 'reading an expired temporary entry must fail').toBe(false);
  });

  it('an expired temporary entry is NOT auto-restored — it is gone for good', () => {
    const { addr } = deploy(L, source);

    call(L, addr, 'put_temporary', [sym('t'), u64(7n)], source);
    L.advanceLedgers(MIN_TEMP_ENTRY_TTL);

    const sim = L.simulate(invokeHostFn(addr, 'has_temporary', [sym('t')]), source);
    expect(sim.ok, sim.error).toBe(true);
    expect(nativeReturn(sim)).toBe(false);

    // Upstream test_auto_restore_with_expired_temp_entry_in_recording_mode:
    // the expired temporary key stays READ-ONLY and is never listed as
    // restored. Only the archived persistent entries (instance + code) are.
    const tempKey = temporaryKey(addr, 't');
    expect(sim.readOnlyKeys).toContain(tempKey);
    expect(sim.readWriteKeys).not.toContain(tempKey);
    for (const idx of sim.restoredRwEntryIndices) {
      expect(sim.readWriteKeys[idx]).not.toBe(tempKey);
    }
  });

  it('an expired temporary entry is evicted from the ledger store', () => {
    // stellar-core deletes expired temporary entries outright; they never move
    // to the hot archive (CAP-0046-12 / CAP-0066). A harness that keeps them in
    // its map reports a dead entry as present through getEntry/entryCount.
    const { addr } = deploy(L, source);
    const key = temporaryKey(addr, 't');

    call(L, addr, 'put_temporary', [sym('t'), u64(7n)], source);
    expect(L.getEntry(key)).toBeDefined();
    const withTemp = L.entryCount();

    L.advanceLedgers(MIN_TEMP_ENTRY_TTL);
    // Give the ledger a transaction to notice, the way a real ledger close would.
    call(L, addr, 'put_persistent', [sym('unrelated'), u64(1n)], source);

    expect(L.getEntry(key), 'expired temporary entry must be evicted').toBeUndefined();
    // withTemp entries, minus the evicted temporary one, plus 'unrelated'.
    expect(L.entryCount()).toBe(withTemp);
  });

  it('a temporary entry can be re-created after expiry, with a fresh TTL', () => {
    const { addr } = deploy(L, source);
    const key = temporaryKey(addr, 't');

    call(L, addr, 'put_temporary', [sym('t'), u64(7n)], source);
    L.advanceLedgers(MIN_TEMP_ENTRY_TTL);
    const seq = L.ledgerSeq;

    // Upstream test_auto_restore_with_recreated_temp_entry_in_recording_mode.
    call(L, addr, 'put_temporary', [sym('t'), u64(123n)], source);

    expect(L.getEntryTtl(key)).toBe(minTempLiveUntil(seq));
    expect(nativeReturn(read(L, addr, 'get_temporary', [sym('t')], source))).toBe(123n);
  });

  // -------------------------------------------------------------------------
  // read-only entry receiving ONLY a TTL bump
  // -------------------------------------------------------------------------

  it('applies a TTL-only change to a READ-ONLY entry (LedgerEntryChange.read_only + ttl_change)', () => {
    const { addr, wasmHash } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    expect(L.getEntryTtl(key)).toBe(minPersistentLiveUntil(START_SEQ));

    // Upstream (e2e_tests.rs:2113-2168): extending a LIVE entry keeps every key
    // in the READ-ONLY footprint and emits read_only:true / new_value:None with
    // a ttl_change that raises live_until. Nothing is written.
    const hostFn = invokeHostFn(addr, 'extend_persistent', [
      sym('k'),
      u32(100_000),
      u32(300_000),
    ]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.readWriteKeys, 'a pure TTL extension writes nothing').toEqual([]);
    expect(sim.readOnlyKeys).toContain(key);
    expect(sim.readOnlyKeys).toContain(instanceKey(addr));
    expect(sim.readOnlyKeys).toContain(codeKey(wasmHash));

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);

    // The read-only TTL bump must reach the store.
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 300_000);
    expect(L.getEntryTtl(key)).toBe(1_300_000);

    // ...and the entry value must be exactly what it was.
    expect(nativeReturn(read(L, addr, 'get_persistent', [sym('k')], source))).toBe(42n);
  });

  // -------------------------------------------------------------------------
  // archival + auto-restore
  // -------------------------------------------------------------------------

  it('a persistent entry past its TTL is ARCHIVED, not deleted', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    const liveUntil = minPersistentLiveUntil(START_SEQ);

    L.advanceLedgers(150_000);
    expect(L.ledgerSeq).toBeGreaterThan(liveUntil);

    // Still present, still carrying its (now expired) live_until: archived
    // state is recoverable state, unlike an expired temporary entry.
    expect(L.getEntry(key)).toBeDefined();
    expect(L.getEntryTtl(key)).toBe(liveUntil);
  });

  it('simulate() auto-restores archived entries and reports restoredRwEntryIndices', () => {
    const { addr, wasmHash } = deploy(L, source);
    const dataK = persistentKey(addr, 'k');
    const instK = instanceKey(addr);
    const codeK = codeKey(wasmHash);

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);

    // Past the TTL of the data entry (1_099_999), the instance (1_099_999) and
    // the seeded code entry (1_100_000). All three are archived.
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;
    expect(seq).toBe(1_150_000);

    const sim = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('k')]), source);
    expect(sim.ok, `auto-restore read failed: ${sim.error}`).toBe(true);
    expect(nativeReturn(sim)).toBe(42n);

    // storage.rs:747-766 promotes every auto-restored persistent entry to
    // READ-WRITE, exactly as upstream
    // test_auto_restore_with_extension_in_recording_mode asserts.
    expect(sim.readOnlyKeys).toEqual([]);
    expect(new Set(sim.readWriteKeys)).toEqual(new Set([dataK, instK, codeK]));

    expect(sim.restoredRwEntryIndices.length).toBe(3);
    const restoredKeys = new Set(
      [...sim.restoredRwEntryIndices].map((i) => sim.readWriteKeys[i]),
    );
    expect(restoredKeys).toEqual(new Set([dataK, instK, codeK]));
  });

  it('send() applies an auto-restore, resetting live_until to the persistent minimum', () => {
    const { addr, wasmHash } = deploy(L, source);
    const dataK = persistentKey(addr, 'k');
    const instK = instanceKey(addr);
    const codeK = codeKey(wasmHash);

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;

    const hostFn = invokeHostFn(addr, 'get_persistent', [sym('k')]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBe(3);

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `send with restored indices failed: ${sent.error}`).toBe(true);

    // e2e_invoke.rs:472-482 — a restored key's new_live_until_ledger is raised
    // to min_live_until_ledger = seq + min_persistent_entry_ttl - 1.
    const restored = minPersistentLiveUntil(seq);
    expect(restored).toBe(1_249_999);
    expect(L.getEntryTtl(dataK)).toBe(restored);
    expect(L.getEntryTtl(instK)).toBe(restored);
    expect(L.getEntryTtl(codeK)).toBe(restored);

    // The restored entry is live again for the next transaction.
    const after = read(L, addr, 'get_persistent', [sym('k')], source);
    expect(after.ok, after.error).toBe(true);
    expect(nativeReturn(after)).toBe(42n);
    expect(after.restoredRwEntryIndices).toEqual([]);
  });

  it('auto-restore + overwrite: writing over an archived entry restores and updates it', () => {
    // Upstream test_auto_restore_with_overwrite_in_recording_mode.
    const { addr } = deploy(L, source);
    const dataK = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(321n)], source);
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;

    const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(999n)]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBeGreaterThan(0);

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `overwrite of an archived entry failed: ${sent.error}`).toBe(true);

    expect(L.getEntryTtl(dataK)).toBe(minPersistentLiveUntil(seq));
    expect(nativeReturn(read(L, addr, 'get_persistent', [sym('k')], source))).toBe(999n);
  });

  it('auto-restore + extension: extend_persistent on an archived entry wins over the minimum', () => {
    // Upstream test_auto_restore_with_extension_in_recording_mode: the restored
    // entry's new_live_until is max(extension, min_live_until), so a large
    // extend_to overrides the restore minimum.
    const { addr } = deploy(L, source);
    const dataK = persistentKey(addr, 'k');

    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;

    const extendTo = 5 * MIN_PERSISTENT_ENTRY_TTL;
    const hostFn = invokeHostFn(addr, 'extend_persistent', [
      sym('k'),
      u32(extendTo),
      u32(extendTo),
    ]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.readOnlyKeys).toEqual([]);
    expect(sim.restoredRwEntryIndices.length).toBe(3);

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `extend of an archived entry failed: ${sent.error}`).toBe(true);

    expect(L.getEntryTtl(dataK)).toBe(seq + extendTo);
    expect(L.getEntryTtl(instanceKey(addr))).toBe(minPersistentLiveUntil(seq));
  });

  it('auto-restore of a brand-new write onto an archived contract', () => {
    // Upstream test_auto_restore_with_new_entry_in_recording_mode: the contract
    // instance and code are archived, the data key does not exist yet.
    const { addr, wasmHash } = deploy(L, source);
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;

    const hostFn = invokeHostFn(addr, 'put_persistent', [sym('fresh'), u64(5n)]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);

    // Only the two archived entries are restored; the new key is not.
    expect(sim.restoredRwEntryIndices.length).toBe(2);
    const restoredKeys = new Set(
      [...sim.restoredRwEntryIndices].map((i) => sim.readWriteKeys[i]),
    );
    expect(restoredKeys).toEqual(new Set([instanceKey(addr), codeKey(wasmHash)]));

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `write onto an archived contract failed: ${sent.error}`).toBe(true);

    expect(L.getEntryTtl(persistentKey(addr, 'fresh'))).toBe(minPersistentLiveUntil(seq));
    expect(L.getEntryTtl(instanceKey(addr))).toBe(minPersistentLiveUntil(seq));
    expect(L.getEntryTtl(codeKey(wasmHash))).toBe(minPersistentLiveUntil(seq));
  });

  it('CreateContract onto archived code auto-restores the code entry', () => {
    // Upstream test_create_contract_success_with_autorestore.
    const wasmHash = L.seedWasm(CONTRACT_DATA);
    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;
    expect(L.getEntryTtl(codeKey(wasmHash))!).toBeLessThan(seq);

    const hostFn = createContractHostFn(source, wasmHash, Buffer.alloc(32, 7));
    const sim = L.simulate(hostFn, source);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBe(1);
    expect(sim.readWriteKeys[sim.restoredRwEntryIndices[0]]).toBe(codeKey(wasmHash));

    const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `deploy onto archived code failed: ${sent.error}`).toBe(true);

    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
    expect(L.getEntryTtl(codeKey(wasmHash))).toBe(minPersistentLiveUntil(seq));
    expect(L.getEntryTtl(instanceKey(addr))).toBe(minPersistentLiveUntil(seq));
  });

  it('snapshot/restore rolls back a TTL extension, not just entry values', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');
    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    expect(L.getEntryTtl(key)).toBe(minPersistentLiveUntil(START_SEQ));

    const snap = L.snapshot();
    call(L, addr, 'extend_persistent', [sym('k'), u32(100_000), u32(300_000)], source);
    expect(L.getEntryTtl(key)).toBe(START_SEQ + 300_000);

    L.restore(snap);
    expect(L.getEntryTtl(key)).toBe(minPersistentLiveUntil(START_SEQ));
  });

  it('advanceLedgers alone never mutates a stored TTL', () => {
    const { addr } = deploy(L, source);
    const key = persistentKey(addr, 'k');
    call(L, addr, 'put_persistent', [sym('k'), u64(42n)], source);
    const liveUntil = minPersistentLiveUntil(START_SEQ);

    L.advanceLedgers(50_000);
    expect(L.getEntryTtl(key)).toBe(liveUntil);
    L.advanceLedgers(50_000);
    expect(L.getEntryTtl(key)).toBe(liveUntil);
  });
});
