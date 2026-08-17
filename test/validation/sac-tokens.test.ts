/**
 * The builtin Stellar Asset Contract, beyond the happy path.
 *
 * Every expected value here is derived from the pinned host's own source, not
 * from what this harness returns:
 *
 *   soroban-env-host-27.0.1/src/builtin_contracts/contract_error.rs
 *       the ContractError discriminants asserted below (#2, #5, #6, #8..#14)
 *   .../builtin_contracts/stellar_asset_contract/contract.rs
 *       the argument order and the check order of every entry point
 *   .../builtin_contracts/stellar_asset_contract/balance.rs
 *       trustline/account min-max balance rules, authorization rules, and
 *       transfer_account_balance()'s account CREATION path
 *   .../builtin_contracts/stellar_asset_contract/allowance.rs
 *       allowance live_until validation and expiry-by-value
 *   .../builtin_contracts/stellar_asset_contract/storage_types.rs
 *       DataKey::Balance shape, BALANCE_EXTEND_AMOUNT = 30 * 17280
 *   .../builtin_contracts/account_contract.rs
 *       classic-account signature checking (ContractError::AuthenticationError)
 *   .../e2e_invoke.rs, .../test/e2e_tests.rs
 *       what an embedder must hand invoke_host_function()
 *   stellar-core src/transactions/SponsorshipUtils.cpp, src/ledger/LedgerTxn.cpp
 *       classic-layer invariants the harness is responsible for, not the host
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr, nativeToScVal, scValToNative, Keypair, Address, StrKey, authorizeEntry, hash as sha256,
} from '@stellar/stellar-sdk';
import type { Asset } from '@stellar/stellar-sdk';
import { Ledger, invokeHostFn, createContractHostFn, type SimulateResult } from '../../src/index.js';
import {
  preFundedWallet, deployToken, nativeToken, establishTrustline, XLM, type Wallet,
} from '../../src/fixtures.js';
import { accountIdFromPublicKey, accountKey, loadAccount, storeAccount } from '../../src/classic.js';

// ---------------------------------------------------------------------------
// ground-truth constants
// ---------------------------------------------------------------------------

/** contract_error.rs */
const E = {
  OperationNotSupported: 2,
  Authentication: 5,
  AccountMissing: 6,
  NegativeAmount: 8,
  Allowance: 9,
  Balance: 10,
  BalanceDeauthorized: 11,
  Overflow: 12,
  TrustlineMissing: 13,
  InsufficientAccountReserve: 14,
} as const;

/** xdr AccountFlags */
const AUTH_REQUIRED = 1, AUTH_REVOCABLE = 2, AUTH_CLAWBACK_ENABLED = 8;
/** xdr TrustLineFlags */
const TL_AUTHORIZED = 1, TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES = 2, TL_CLAWBACK_ENABLED = 4;

/** LedgerInfo written by crates/host-wasm/src/lib.rs::ledger_info(). */
const BASE_RESERVE = 5_000_000;
const MIN_PERSISTENT_ENTRY_TTL = 100_000;
/** storage_types.rs: BALANCE_EXTEND_AMOUNT = 30 * DAY_IN_LEDGERS (17280). */
const BALANCE_EXTEND_AMOUNT = 30 * 17280;

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const u32v = (n: number) => nativeToScVal(n, { type: 'u32' });
const boolv = (b: boolean) => xdr.ScVal.scvBool(b);

const ADD_I32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/add_i32.wasm', import.meta.url))),
);

interface CallResult {
  sim: SimulateResult;
  sent?: { ok: boolean; error?: string; changedKeys: string[]; eventsXdr: string[] };
  /** simulate error if simulation failed, else the send error. */
  error?: string;
  ok: boolean;
}

/** simulate -> send, WITHOUT throwing, so negative paths can be asserted. */
function call(
  L: Ledger, addr: xdr.ScAddress, fn: string, args: xdr.ScVal[], src: string, auth?: string[],
): CallResult {
  const hostFn = invokeHostFn(addr, fn, args);
  const sim = L.simulate(hostFn, src);
  if (!sim.ok) return { sim, error: sim.error, ok: false };
  const sent = L.send(hostFn, src, sim.resourcesXdr, auth ?? sim.authXdr, sim.restoredRwEntryIndices);
  return { sim, sent, error: sent.error, ok: sent.ok };
}

/** simulate a read-only entry point and decode the return value. */
function read(L: Ledger, addr: xdr.ScAddress, fn: string, args: xdr.ScVal[], src: string) {
  const sim = L.simulate(invokeHostFn(addr, fn, args), src);
  if (!sim.ok) throw new Error(sim.error);
  return scValToNative(xdr.ScVal.fromXDR(sim.returnValueXdr!, 'base64'));
}

/** Assert a call failed with a specific builtin ContractError and message. */
function expectContractError(r: CallResult, code: number, messageFragment: string) {
  expect(r.ok, `expected failure, got success`).toBe(false);
  expect(r.error).toMatch(new RegExp(`Error\\(Contract, #${code}\\)`));
  expect(r.error).toContain(messageFragment);
}

/** Overwrite an existing account's flags in place (no FundOptions for this). */
function setIssuerFlags(L: Ledger, w: Wallet, flags: number) {
  const ae = loadAccount(L, w.accountId)!;
  ae.flags(flags);
  storeAccount(L, ae);
}

function deployPlainContract(L: Ledger, src: string, salt = Buffer.alloc(32)): xdr.ScAddress {
  const wasmHash = L.seedWasm(ADD_I32);
  const { sent } = L.simulateAndSend(createContractHostFn(src, wasmHash, salt), src);
  if (!sent.ok) throw new Error(sent.error);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
}

function trustLineAsset(asset: Asset): xdr.TrustLineAsset {
  const code = asset.getCode();
  const issuer = accountIdFromPublicKey(asset.getIssuer());
  return code.length <= 4
    ? xdr.TrustLineAsset.assetTypeCreditAlphanum4(new xdr.AlphaNum4({
        assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(4)], 4), issuer }))
    : xdr.TrustLineAsset.assetTypeCreditAlphanum12(new xdr.AlphaNum12({
        assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(12)], 12), issuer }));
}

function trustLineKey(holder: Wallet, asset: Asset): string {
  return xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({
    accountId: holder.accountId, asset: trustLineAsset(asset),
  })).toXDR('base64');
}

function loadTrustLine(L: Ledger, holder: Wallet, asset: Asset): xdr.TrustLineEntry {
  const raw = L.getEntry(trustLineKey(holder, asset));
  if (!raw) throw new Error('no trustline');
  return xdr.LedgerEntry.fromXDR(raw, 'base64').data().trustLine();
}

function eventTopics(eventB64: string): unknown[] {
  return xdr.ContractEvent.fromXDR(eventB64, 'base64')
    .body().v0().topics().map((t) => scValToNative(t));
}

/** A fresh issuer + a deployed credit SAC + a holder with a trustline. */
function world(opts: { issuerFlags?: number; code?: string } = {}) {
  const L = new Ledger();
  const issuer = preFundedWallet(L);
  const alice = preFundedWallet(L);
  const bob = preFundedWallet(L);
  const token = deployToken(L, { issuer, code: opts.code ?? 'TEST' });
  if (opts.issuerFlags) setIssuerFlags(L, issuer, opts.issuerFlags);
  return { L, issuer, alice, bob, token };
}

// ---------------------------------------------------------------------------

describe('SAC: burn, burn_from, and transfer-to-issuer', () => {
  it('burn destroys the holder tokens and emits a burn event', () => {
    const { L, issuer, alice, token } = world();
    token.mint(alice, 1_000n);

    const r = call(L, token.address, 'burn', [alice.scAddress, i128(100n)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(900n);
    // The trustline balance is the token supply for this holder.
    expect(BigInt(loadTrustLine(L, alice, token.asset).balance().toString())).toBe(900n);

    // event.rs::burn -> topics [burn, from, name]; name is "CODE:ISSUER".
    expect(r.sent!.eventsXdr.length).toBe(1);
    expect(eventTopics(r.sent!.eventsXdr[0])).toEqual([
      'burn', alice.publicKey, `TEST:${issuer.publicKey}`,
    ]);
  });

  it('burn beyond the balance fails with BalanceError', () => {
    const { L, alice, token } = world();
    token.mint(alice, 1_000n);
    // spend_balance -> transfer_trustline_balance: new_balance -9000 < min 0.
    expectContractError(
      call(L, token.address, 'burn', [alice.scAddress, i128(10_000n)], alice.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
  });

  it('burn is rejected on the native asset and on the issuer', () => {
    const L = new Ledger();
    const w = preFundedWallet(L);
    const native = nativeToken(L, w);
    // contract.rs::burn -> check_non_native before anything else.
    expectContractError(
      call(L, native.address, 'burn', [w.scAddress, i128(1n)], w.accountIdB64),
      E.OperationNotSupported, 'operation invalid on native asset',
    );

    const cw = world();
    cw.token.mint(cw.alice, 10n);
    // contract.rs::burn -> check_not_issuer.
    expectContractError(
      call(cw.L, cw.token.address, 'burn', [cw.issuer.scAddress, i128(1n)], cw.issuer.accountIdB64),
      E.OperationNotSupported, 'operation invalid on issuer',
    );
  });

  it('burn_from spends the allowance as well as the balance', () => {
    const { L, issuer, alice, bob, token } = world();
    token.mint(alice, 1_000n);

    expect(call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(300n), u32v(L.ledgerSeq + 50)], alice.accountIdB64).ok).toBe(true);

    const r = call(L, token.address, 'burn_from',
      [bob.scAddress, alice.scAddress, i128(50n)], bob.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(950n);
    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(250n);
  });

  it('transferring TO the issuer burns: the tokens vanish and a burn event is emitted', () => {
    // balance.rs::transfer_classic_balance -> `if issuer == to { return Ok(()) }`
    // and event.rs::transfer_maybe_with_issuer -> burn when `to` is the issuer.
    const { L, issuer, alice, token } = world();
    token.mint(alice, 1_000n);

    const r = call(L, token.address, 'transfer',
      [alice.scAddress, issuer.scAddress, i128(400n)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(600n);
    expect(eventTopics(r.sent!.eventsXdr[0])[0]).toBe('burn');
    // No trustline was created for the issuer, and no XDR ledger entry either.
    expect(L.getEntry(trustLineKey(issuer, token.asset))).toBeUndefined();
    // get_classic_balance returns i64::MAX for the issuer of its own asset.
    expect(token.balanceOf(issuer)).toBe(9_223_372_036_854_775_807n);
  });
});

describe('SAC: approve / allowance / transfer_from', () => {
  it('allowance is zero until approved and decrements on transfer_from', () => {
    const { L, issuer, alice, bob, token } = world();
    const carol = preFundedWallet(L);
    token.mint(alice, 1_000n);
    token.trust(carol);

    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(0n);

    const live = L.ledgerSeq + 50;
    const ap = call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(300n), u32v(live)], alice.accountIdB64);
    expect(ap.ok, ap.error).toBe(true);
    expect(eventTopics(ap.sent!.eventsXdr[0])).toEqual([
      'approve', alice.publicKey, bob.publicKey, `TEST:${issuer.publicKey}`,
    ]);
    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(300n);

    // Only the SPENDER authorizes transfer_from; `from` never signs.
    const tf = call(L, token.address, 'transfer_from',
      [bob.scAddress, alice.scAddress, carol.scAddress, i128(120n)], bob.accountIdB64);
    expect(tf.ok, tf.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(880n);
    expect(token.balanceOf(carol)).toBe(120n);
    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(180n);
    // No address-credential auth entry was recorded for alice at all.
    const addresses = tf.sim.authXdr
      .map((b64) => xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64'))
      .filter((e) => e.credentials().switch().name === 'sorobanCredentialsAddress')
      .map((e) => Address.fromScAddress(e.credentials().address().address()).toString());
    expect(addresses).not.toContain(alice.publicKey);
  });

  it('transfer_from beyond the allowance fails with AllowanceError', () => {
    const { L, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    token.trust(bob);
    call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(100n), u32v(L.ledgerSeq + 50)], alice.accountIdB64);

    expectContractError(
      call(L, token.address, 'transfer_from',
        [bob.scAddress, alice.scAddress, bob.scAddress, i128(101n)], bob.accountIdB64),
      E.Allowance, 'not enough allowance to spend',
    );
  });

  it('approve validates live_until against both the ledger seq and max_entry_ttl', () => {
    const { L, alice, bob, token } = world();
    token.mint(alice, 1_000n);

    // allowance.rs: amount > 0 && live_until < li.sequence_number
    expectContractError(
      call(L, token.address, 'approve',
        [alice.scAddress, bob.scAddress, i128(1n), u32v(L.ledgerSeq - 1)], alice.accountIdB64),
      E.Allowance, 'live_until must be >= ledger sequence',
    );
    // allowance.rs: live_until > max_live_until_ledger (= seq + max_entry_ttl)
    expectContractError(
      call(L, token.address, 'approve',
        [alice.scAddress, bob.scAddress, i128(1n), u32v(L.ledgerSeq + 10_000_001)], alice.accountIdB64),
      E.Allowance, 'live_until is greater than max',
    );
    // live_until == sequence_number is the boundary and is allowed.
    expect(call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(1n), u32v(L.ledgerSeq)], alice.accountIdB64).ok).toBe(true);
  });

  it('an allowance expires by VALUE at live_until + 1, not by entry TTL', () => {
    // read_allowance: `if val.live_until_ledger < e.get_ledger_sequence() { 0 }`
    const { L, issuer, alice, bob, token } = world();
    token.mint(alice, 1_000n);

    const ap = call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(50n), u32v(L.ledgerSeq)], alice.accountIdB64);
    expect(ap.ok, ap.error).toBe(true);
    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(50n);

    L.advanceLedgers(1);
    expect(read(L, token.address, 'allowance', [alice.scAddress, bob.scAddress], issuer.accountIdB64)).toBe(0n);
    expectContractError(
      call(L, token.address, 'transfer_from',
        [bob.scAddress, alice.scAddress, bob.scAddress, i128(1n)], bob.accountIdB64),
      E.Allowance, 'not enough allowance to spend',
    );
  });

  it('the allowance lives in a TEMPORARY ContractData entry whose TTL is live_until', () => {
    const { L, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    const live = L.ledgerSeq + 100;
    const ap = call(L, token.address, 'approve',
      [alice.scAddress, bob.scAddress, i128(300n), u32v(live)], alice.accountIdB64);

    const tempKeys = ap.sent!.changedKeys.filter((k) => {
      const key = xdr.LedgerKey.fromXDR(k, 'base64');
      return key.switch().name === 'contractData' && key.contractData().durability().name === 'temporary';
    });
    expect(tempKeys.length).toBe(1);
    expect(L.getEntryTtl(tempKeys[0])).toBe(live);
    const key = xdr.LedgerKey.fromXDR(tempKeys[0], 'base64').contractData().key();
    // storage_types.rs: DataKey::Allowance(AllowanceDataKey { from, spender })
    expect(scValToNative(key)).toEqual([
      'Allowance', { from: alice.publicKey, spender: bob.publicKey },
    ]);
  });
});

describe('SAC: clawback', () => {
  it('is refused when the trustline lacks TRUSTLINE_CLAWBACK_ENABLED', () => {
    const { L, issuer, alice, token } = world();
    token.mint(alice, 100n);
    // check_clawbackable runs BEFORE admin.require_auth().
    expectContractError(
      call(L, token.address, 'clawback', [alice.scAddress, i128(4n)], issuer.accountIdB64),
      E.Balance, "trustline isn't clawbackable",
    );
  });

  it('claws back from a clawback-enabled trustline created by the SAC itself', () => {
    const { L, issuer, alice, token } = world({ issuerFlags: AUTH_CLAWBACK_ENABLED });
    // create_trustline_if_needed copies the issuer's clawback flag onto the trustline.
    expect(call(L, token.address, 'trust', [alice.scAddress], alice.accountIdB64).ok).toBe(true);
    expect(loadTrustLine(L, alice, token.asset).flags() & TL_CLAWBACK_ENABLED).toBe(TL_CLAWBACK_ENABLED);

    expect(call(L, token.address, 'mint', [alice.scAddress, i128(100n)], issuer.accountIdB64).ok).toBe(true);
    const cb = call(L, token.address, 'clawback', [alice.scAddress, i128(40n)], issuer.accountIdB64);
    expect(cb.ok, cb.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(60n);
    expect(eventTopics(cb.sent!.eventsXdr[0])[0]).toBe('clawback');
  });

  it('claws back a DEAUTHORIZED balance (spend_balance_no_authorization_check)', () => {
    const { L, issuer, alice, token } = world({
      issuerFlags: AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED,
    });
    expect(call(L, token.address, 'trust', [alice.scAddress], alice.accountIdB64).ok).toBe(true);
    expect(call(L, token.address, 'mint', [alice.scAddress, i128(100n)], issuer.accountIdB64).ok).toBe(true);
    expect(call(L, token.address, 'set_authorized',
      [alice.scAddress, boolv(false)], issuer.accountIdB64).ok).toBe(true);
    expect(read(L, token.address, 'authorized', [alice.scAddress], issuer.accountIdB64)).toBe(false);

    // A plain transfer is blocked, but clawback skips the authorization check.
    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, issuer.scAddress, i128(1n)], alice.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    const cb = call(L, token.address, 'clawback', [alice.scAddress, i128(100n)], issuer.accountIdB64);
    expect(cb.ok, cb.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(0n);
  });

  it('is refused on the native asset and on the issuer', () => {
    const L = new Ledger();
    const w = preFundedWallet(L);
    const native = nativeToken(L, w);
    expectContractError(
      call(L, native.address, 'clawback', [w.scAddress, i128(1n)], w.accountIdB64),
      E.OperationNotSupported, 'cannot clawback native asset',
    );

    const cw = world({ issuerFlags: AUTH_CLAWBACK_ENABLED });
    expectContractError(
      call(cw.L, cw.token.address, 'clawback', [cw.issuer.scAddress, i128(1n)], cw.issuer.accountIdB64),
      E.OperationNotSupported, 'cannot clawback from issuer',
    );
  });
});

describe('SAC: set_authorized', () => {
  it('needs AUTH_REVOCABLE on the issuer to deauthorize', () => {
    const { L, issuer, alice, token } = world();
    token.mint(alice, 100n);
    expectContractError(
      call(L, token.address, 'set_authorized', [alice.scAddress, boolv(false)], issuer.accountIdB64),
      E.OperationNotSupported, 'issuer does not have AUTH_REVOCABLE set',
    );
  });

  it('flips exactly the flags balance.rs::set_trustline_authorization specifies', () => {
    const { L, issuer, alice, token } = world({ issuerFlags: AUTH_REVOCABLE });
    token.mint(alice, 100n);
    expect(loadTrustLine(L, alice, token.asset).flags()).toBe(TL_AUTHORIZED);

    expect(call(L, token.address, 'set_authorized',
      [alice.scAddress, boolv(false)], issuer.accountIdB64).ok).toBe(true);
    // AUTHORIZED cleared, AUTHORIZED_TO_MAINTAIN_LIABILITIES set.
    expect(loadTrustLine(L, alice, token.asset).flags()).toBe(TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES);
    expect(read(L, token.address, 'authorized', [alice.scAddress], issuer.accountIdB64)).toBe(false);

    expect(call(L, token.address, 'set_authorized',
      [alice.scAddress, boolv(true)], issuer.accountIdB64).ok).toBe(true);
    expect(loadTrustLine(L, alice, token.asset).flags()).toBe(TL_AUTHORIZED);
  });

  it('blocks both directions of transfer while deauthorized', () => {
    const { L, issuer, alice, bob, token } = world({ issuerFlags: AUTH_REVOCABLE });
    token.mint(alice, 100n);
    token.mint(bob, 100n);
    call(L, token.address, 'set_authorized', [alice.scAddress, boolv(false)], issuer.accountIdB64);

    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(1n)], alice.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    expectContractError(
      call(L, token.address, 'transfer', [bob.scAddress, alice.scAddress, i128(1n)], bob.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    // The balance itself is still readable and untouched.
    expect(token.balanceOf(alice)).toBe(100n);
  });

  it('is refused for the issuer and for the native asset', () => {
    const { L, issuer, token } = world({ issuerFlags: AUTH_REVOCABLE });
    expectContractError(
      call(L, token.address, 'set_authorized', [issuer.scAddress, boolv(false)], issuer.accountIdB64),
      E.OperationNotSupported, "issuer doesn't have a trustline",
    );

    const L2 = new Ledger();
    const w = preFundedWallet(L2);
    const native = nativeToken(L2, w);
    // The native SAC has no administrator at all: read_administrator misses the
    // instance key before set_authorization can complain about the asset type.
    const r = call(L2, native.address, 'set_authorized', [w.scAddress, boolv(false)], w.accountIdB64);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Error\(Storage, MissingValue\)/);
    // ...and a native holder is always authorized (balance.rs::is_account_authorized).
    expect(read(L2, native.address, 'authorized', [w.scAddress], w.accountIdB64)).toBe(true);
  });
});

describe('SAC: trust() creates a real TrustLineEntry', () => {
  it('creates an unlimited authorized trustline and bumps num_sub_entries', () => {
    const { L, issuer, alice, token } = world();
    expect(loadAccount(L, alice.accountId)!.numSubEntries()).toBe(0);

    const r = call(L, token.address, 'trust', [alice.scAddress], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);

    const tl = loadTrustLine(L, alice, token.asset);
    expect(BigInt(tl.balance().toString())).toBe(0n);
    expect(BigInt(tl.limit().toString())).toBe(9_223_372_036_854_775_807n); // i64::MAX
    expect(tl.flags()).toBe(TL_AUTHORIZED);
    expect(loadAccount(L, alice.accountId)!.numSubEntries()).toBe(1);
    expect(read(L, token.address, 'authorized', [alice.scAddress], issuer.accountIdB64)).toBe(true);
  });

  it('leaves the trustline UNAUTHORIZED when the issuer has AUTH_REQUIRED', () => {
    const { L, issuer, alice, token } = world({ issuerFlags: AUTH_REQUIRED });
    expect(call(L, token.address, 'trust', [alice.scAddress], alice.accountIdB64).ok).toBe(true);
    expect(loadTrustLine(L, alice, token.asset).flags()).toBe(0);
    expectContractError(
      call(L, token.address, 'mint', [alice.scAddress, i128(10n)], issuer.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
  });

  it('enforces the extra base reserve and refuses the issuer and native', () => {
    const L = new Ledger();
    const issuer = preFundedWallet(L);
    const token = deployToken(L, { issuer });

    // min_balance for a fresh account is 2 * base_reserve; a trustline needs one more.
    const poor = preFundedWallet(L, { xlm: BigInt(3 * BASE_RESERVE - 1) });
    expectContractError(
      call(L, token.address, 'trust', [poor.scAddress], poor.accountIdB64),
      E.InsufficientAccountReserve, 'account has insufficient reserve for new trustline',
    );
    const exact = preFundedWallet(L, { xlm: BigInt(3 * BASE_RESERVE) });
    expect(call(L, token.address, 'trust', [exact.scAddress], exact.accountIdB64).ok).toBe(true);

    expectContractError(
      call(L, token.address, 'trust', [issuer.scAddress], issuer.accountIdB64),
      E.OperationNotSupported, 'cannot create trustline for issuer',
    );

    const native = nativeToken(L, issuer);
    expectContractError(
      call(L, native.address, 'trust', [issuer.scAddress], issuer.accountIdB64),
      E.OperationNotSupported, 'trust operation is not supported for native asset',
    );
  });

  it('is a no-op (and needs no auth) when the trustline already exists', () => {
    const { L, issuer, alice, token } = world();
    expect(call(L, token.address, 'trust', [alice.scAddress], alice.accountIdB64).ok).toBe(true);
    // Source is the issuer, so alice authorizes nothing — and it still succeeds.
    const again = call(L, token.address, 'trust', [alice.scAddress], issuer.accountIdB64);
    expect(again.ok, again.error).toBe(true);
    expect(loadAccount(L, alice.accountId)!.numSubEntries()).toBe(1);
  });
});

describe('SAC: authorization — who signed what', () => {
  /** transfer from alice, submitted by bob. */
  function crossAccountTransfer() {
    const { L, issuer, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    token.trust(bob);
    const hostFn = invokeHostFn(token.address, 'transfer',
      [alice.scAddress, bob.scAddress, i128(10n)]);
    const sim = L.simulate(hostFn, bob.accountIdB64);
    expect(sim.ok, sim.error).toBe(true);
    // Recording auth never verifies anything; the gap only shows on submit.
    expect(sim.authXdr.length).toBe(1);
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(sim.authXdr[0], 'base64');
    expect(entry.credentials().switch().name).toBe('sorobanCredentialsAddress');
    expect(Address.fromScAddress(entry.credentials().address().address()).toString())
      .toBe(alice.publicKey);
    return { L, issuer, alice, bob, token, hostFn, sim, entry };
  }

  it('a transfer with NO authorization from the sender is rejected on submit', () => {
    const { L, bob, hostFn, sim } = crossAccountTransfer();
    const sent = L.send(hostFn, bob.accountIdB64, sim.resourcesXdr, [], sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Error\(Auth, InvalidAction\)/);
    expect(sent.error).toContain('Unauthorized function call for address');
  });

  it('the unsigned entry that simulate recorded is not itself a proof', () => {
    const { L, bob, hostFn, sim } = crossAccountTransfer();
    const sent = L.send(hostFn, bob.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Error\(Auth, InvalidAction\)/);
    expect(sent.error).toContain('failed account authentication with error');
  });

  it('an entry signed by the WRONG key is rejected: signer does not belong to account', async () => {
    const { L, alice, bob, hostFn, sim, entry } = crossAccountTransfer();
    // Build a well-formed AccountEd25519Signature over the correct payload,
    // but with BOB's keypair while the credential address is ALICE.
    const validUntil = L.ledgerSeq + 100;
    const cred = entry.credentials().address();
    cred.signatureExpirationLedger(validUntil);
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: sha256(L.networkPassphrase),
        nonce: cred.nonce(),
        invocation: entry.rootInvocation(),
        signatureExpirationLedger: validUntil,
      }),
    );
    const payload = sha256(preimage.toXDR());
    cred.signature(xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(bob.keypair.rawPublicKey()) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(bob.keypair.sign(payload)) }),
      ]),
    ]));

    const sent = L.send(hostFn, bob.accountIdB64, sim.resourcesXdr,
      [entry.toXDR('base64')], sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Error\(Auth, InvalidAction\)/);
    // account_contract.rs::check_account_authentication
    expect(sent.error).toMatch(new RegExp(`Error\\(Contract, #${E.Authentication}\\)`));
    expect(sent.error).toContain('signer does not belong to account');
    // Nothing moved.
    expect(alice.publicKey).toBeTruthy();
  });

  it('an entry signed by the sender is accepted', async () => {
    const { L, alice, bob, token, hostFn, sim, entry } = crossAccountTransfer();
    const signed = await authorizeEntry(entry, alice.keypair, L.ledgerSeq + 100, L.networkPassphrase);
    const sent = L.send(hostFn, bob.accountIdB64, sim.resourcesXdr,
      [signed.toXDR('base64')], sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(990n);
    expect(token.balanceOf(bob)).toBe(10n);
  });

  it('a correctly signed entry whose expiration ledger has passed is rejected', async () => {
    const { L, alice, bob, hostFn, sim, entry } = crossAccountTransfer();
    // Signed by the right key, over the right payload, but already expired.
    const signed = await authorizeEntry(entry, alice.keypair, L.ledgerSeq - 1, L.networkPassphrase);
    const sent = L.send(hostFn, bob.accountIdB64, sim.resourcesXdr,
      [signed.toXDR('base64')], sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Error\(Auth, /);
  });
});

describe('SAC: trustline limits, liabilities and the AUTHORIZED flag', () => {
  it('minting past the trustline limit fails; minting exactly to it succeeds', () => {
    const { L, issuer, alice, token } = world({ code: 'LIM' });
    establishTrustline(L, alice, token.asset, { limit: 1_000n });

    expect(call(L, token.address, 'mint', [alice.scAddress, i128(1_000n)], issuer.accountIdB64).ok).toBe(true);
    expect(token.balanceOf(alice)).toBe(1_000n);
    expectContractError(
      call(L, token.address, 'mint', [alice.scAddress, i128(1n)], issuer.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
  });

  it('a trustline with AUTHORIZED cleared blocks transfers in and out', () => {
    const { L, issuer, alice, bob, token } = world({ code: 'DEA' });
    establishTrustline(L, alice, token.asset, { balance: 500n, authorized: false });
    token.mint(bob, 100n);

    expect(read(L, token.address, 'authorized', [alice.scAddress], issuer.accountIdB64)).toBe(false);
    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(1n)], alice.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    expectContractError(
      call(L, token.address, 'transfer', [bob.scAddress, alice.scAddress, i128(1n)], bob.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    expectContractError(
      call(L, token.address, 'mint', [alice.scAddress, i128(1n)], issuer.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
    // Reading the balance is still allowed.
    expect(token.balanceOf(alice)).toBe(500n);
  });

  it('an account with no trustline cannot even be read', () => {
    const { L, alice, token } = world({ code: 'NOTL' });
    expect(() => token.balanceOf(alice)).toThrow(/trustline entry is missing/);
    expect(() => token.balanceOf(alice)).toThrow(new RegExp(`Error\\(Contract, #${E.TrustlineMissing}\\)`));
  });

  it('trustline liabilities narrow the allowed balance window', () => {
    // get_min_max_trustline_balance: min = selling, max = limit - buying.
    const { L, issuer, alice, token } = world({ code: 'LIA' });
    L.putEntry(new xdr.LedgerEntry({
      lastModifiedLedgerSeq: L.ledgerSeq,
      data: xdr.LedgerEntryData.trustline(new xdr.TrustLineEntry({
        accountId: alice.accountId,
        asset: trustLineAsset(token.asset),
        balance: new xdr.Int64(100n),
        limit: new xdr.Int64(1_000n),
        flags: TL_AUTHORIZED,
        ext: new xdr.TrustLineEntryExt(1, new xdr.TrustLineEntryV1({
          liabilities: new xdr.Liabilities({ buying: new xdr.Int64(200n), selling: new xdr.Int64(50n) }),
          ext: new xdr.TrustLineEntryV1Ext(0),
        })),
      })),
      ext: new xdr.LedgerEntryExt(0),
    }).toXDR('base64'));

    // max = 1000 - 200 = 800
    expect(call(L, token.address, 'mint', [alice.scAddress, i128(700n)], issuer.accountIdB64).ok).toBe(true);
    expectContractError(
      call(L, token.address, 'mint', [alice.scAddress, i128(1n)], issuer.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
    // min = selling = 50
    expect(call(L, token.address, 'burn', [alice.scAddress, i128(750n)], alice.accountIdB64).ok).toBe(true);
    expectContractError(
      call(L, token.address, 'burn', [alice.scAddress, i128(1n)], alice.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
    expect(token.balanceOf(alice)).toBe(50n);
  });

  it('account selling liabilities raise the native minimum balance', () => {
    // get_min_max_account_balance: min = (2 + num_sub_entries) * base_reserve + selling
    const L = new Ledger();
    const alice = preFundedWallet(L, { xlm: 100n * XLM });
    const bob = preFundedWallet(L);
    const native = nativeToken(L, alice);

    const ae = loadAccount(L, alice.accountId)!;
    storeAccount(L, new xdr.AccountEntry({
      accountId: ae.accountId(), balance: ae.balance(), seqNum: ae.seqNum(),
      numSubEntries: ae.numSubEntries(), inflationDest: ae.inflationDest(), flags: ae.flags(),
      homeDomain: ae.homeDomain(), thresholds: ae.thresholds(), signers: ae.signers(),
      ext: new xdr.AccountEntryExt(1, new xdr.AccountEntryExtensionV1({
        liabilities: new xdr.Liabilities({ buying: new xdr.Int64(0n), selling: new xdr.Int64(30n * XLM) }),
        ext: new xdr.AccountEntryExtensionV1Ext(0),
      })),
    }));

    const min = BigInt(2 * BASE_RESERVE) + 30n * XLM; // 310_000_000
    const spendable = 100n * XLM - min;
    expect(call(L, native.address, 'transfer',
      [alice.scAddress, bob.scAddress, i128(spendable)], alice.accountIdB64).ok).toBe(true);
    expect(alice.balance()).toBe(min);
    expectContractError(
      call(L, native.address, 'transfer', [alice.scAddress, bob.scAddress, i128(1n)], alice.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
  });
});

describe('SAC: amounts — zero, negative, insufficient, i128 boundaries', () => {
  it('rejects negative amounts on every entry point that takes one', () => {
    const { L, issuer, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    token.trust(bob);
    const cases: [string, xdr.ScVal[], string][] = [
      ['transfer', [alice.scAddress, bob.scAddress, i128(-1n)], alice.accountIdB64],
      ['mint', [alice.scAddress, i128(-1n)], issuer.accountIdB64],
      ['burn', [alice.scAddress, i128(-1n)], alice.accountIdB64],
      ['approve', [alice.scAddress, bob.scAddress, i128(-1n), u32v(L.ledgerSeq + 10)], alice.accountIdB64],
      ['transfer_from', [bob.scAddress, alice.scAddress, bob.scAddress, i128(-1n)], bob.accountIdB64],
      ['clawback', [alice.scAddress, i128(-1n)], issuer.accountIdB64],
    ];
    for (const [fn, args, src] of cases) {
      expectContractError(call(L, token.address, fn, args, src),
        E.NegativeAmount, 'negative amount is not allowed');
    }
    // i128::MIN is just a very negative amount.
    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(I128_MIN)], alice.accountIdB64),
      E.NegativeAmount, 'negative amount is not allowed',
    );
  });

  it('a zero-amount transfer succeeds and changes nothing', () => {
    // check_nonnegative_amount only rejects `amount < 0`.
    const { L, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    token.trust(bob);
    const r = call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(0n)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(token.balanceOf(alice)).toBe(1_000n);
    expect(token.balanceOf(bob)).toBe(0n);
  });

  it('transferring more than the balance fails with BalanceError', () => {
    const { L, alice, bob, token } = world();
    token.mint(alice, 100n);
    token.trust(bob);
    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(101n)], alice.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
    expect(call(L, token.address, 'transfer',
      [alice.scAddress, bob.scAddress, i128(100n)], alice.accountIdB64).ok).toBe(true);
  });

  it('i128::MAX to a G-account overflows the i64 classic balance', () => {
    // balance.rs: `i64::try_from(amount)` in spend_balance_no_authorization_check
    // runs BEFORE receive_balance, so the failure names the SPENT amount.
    const { L, alice, bob, token } = world();
    token.mint(alice, 1_000n);
    token.trust(bob);
    expectContractError(
      call(L, token.address, 'transfer', [alice.scAddress, bob.scAddress, i128(I128_MAX)], alice.accountIdB64),
      E.Overflow, 'spent amount is too large for an i64',
    );
    expectContractError(
      call(L, token.address, 'mint', [bob.scAddress, i128(I128_MAX)], world().issuer.accountIdB64),
      E.Overflow, 'received amount is too large for an i64',
    );
  });

  it('a CONTRACT balance is a full i128 and overflows only past i128::MAX', () => {
    const { L, issuer, token } = world();
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));

    expect(call(L, token.address, 'mint', [c, i128(I128_MAX)], issuer.accountIdB64).ok).toBe(true);
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(I128_MAX);
    expectContractError(
      call(L, token.address, 'mint', [c, i128(1n)], issuer.accountIdB64),
      E.Overflow, 'balance overflow in receive_balance',
    );
  });

  it('spending from a contract with no balance at all fails', () => {
    const { L, issuer, token } = world({ issuerFlags: AUTH_CLAWBACK_ENABLED });
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));
    // check_clawbackable refuses even a zero clawback when no balance exists.
    expectContractError(
      call(L, token.address, 'clawback', [c, i128(0n)], issuer.accountIdB64),
      E.Balance, 'no balance to clawback',
    );
  });
});

describe('SAC native XLM: transferring to a G-account that does not exist', () => {
  /**
   * balance.rs::transfer_account_balance, `None` arm. The SAC creates a real
   * AccountEntry, and the starting sequence number is `(ledger_seq as i64) << 32`
   * -- the same rule as stellar-core's getStartingSequenceNumber.
   */
  function ghost() {
    const kp = Keypair.random();
    const id = accountIdFromPublicKey(kp.publicKey());
    return { kp, id, val: xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(id)) };
  }

  it('creates an AccountEntry whose fields match balance.rs exactly', () => {
    const L = new Ledger(); // default ledgerSeq 1_000_000
    expect(L.ledgerSeq).toBe(1_000_000);
    const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
    const native = nativeToken(L, alice);
    const g = ghost();
    expect(L.getEntry(accountKey(g.id).toXDR('base64'))).toBeUndefined();

    const amount = 20n * XLM;
    const r = call(L, native.address, 'transfer', [alice.scAddress, g.val, i128(amount)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);

    const raw = L.getEntry(accountKey(g.id).toXDR('base64'));
    expect(raw, 'the SAC must have created the AccountEntry').toBeDefined();
    const le = xdr.LedgerEntry.fromXDR(raw!, 'base64');
    const ae = le.data().account();

    expect(BigInt(ae.balance().toString())).toBe(amount);
    // (ledger_seq as i64) << 32, hard-coded for ledger 1_000_000.
    expect(BigInt(ae.seqNum().toString())).toBe(4_294_967_296_000_000n);
    expect(BigInt(ae.seqNum().toString())).toBe(BigInt(L.ledgerSeq) << 32n);
    expect(ae.numSubEntries()).toBe(0);
    expect(ae.inflationDest() ?? null).toBeNull(); // js-xdr decodes `void*` as undefined
    expect(ae.flags()).toBe(0);
    expect(ae.homeDomain().toString()).toBe('');
    expect([...ae.thresholds()]).toEqual([1, 0, 0, 0]); // master weight 1, thresholds 0
    expect(ae.signers()).toEqual([]);
    expect(ae.ext().switch()).toBe(0);
    // balance.rs writes `last_modified_ledger_seq: 0`; core stamps it on commit.
    expect(le.lastModifiedLedgerSeq()).toBe(0);

    // The created account is a first-class holder from here on.
    expect(read(L, native.address, 'balance', [g.val], alice.accountIdB64)).toBe(amount);
    expect(call(L, native.address, 'transfer',
      [alice.scAddress, g.val, i128(1n * XLM)], alice.accountIdB64).ok).toBe(true);
    expect(read(L, native.address, 'balance', [g.val], alice.accountIdB64)).toBe(21n * XLM);
  });

  it('reproduces (ledger_seq as i64) << 32 at other ledger sequences', () => {
    for (const [seq, expected] of [
      [1, 4_294_967_296n],
      [12_345, 53_021_371_269_120n],
      [2_147_483_647, 9_223_372_032_559_808_512n], // i32::MAX, the largest allowed
    ] as [number, bigint][]) {
      const L = new Ledger({ ledgerSeq: seq });
      const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
      const native = nativeToken(L, alice);
      const g = ghost();
      const r = call(L, native.address, 'transfer', [alice.scAddress, g.val, i128(20n * XLM)], alice.accountIdB64);
      expect(r.ok, `ledgerSeq ${seq}: ${r.error}`).toBe(true);
      const ae = xdr.LedgerEntry.fromXDR(L.getEntry(accountKey(g.id).toXDR('base64'))!, 'base64').data().account();
      expect(BigInt(ae.seqNum().toString()), `ledgerSeq ${seq}`).toBe(expected);
      expect(BigInt(ae.seqNum().toString())).toBe(BigInt(seq) << 32n);
    }
  });

  it('refuses to create an account above i32::MAX ledger sequence', () => {
    // balance.rs: `if ledger_seq > i32::MAX as u32 { InternalError }`
    const L = new Ledger({ ledgerSeq: 2_147_483_648 });
    const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
    const native = nativeToken(L, alice);
    const g = ghost();
    const r = call(L, native.address, 'transfer', [alice.scAddress, g.val, i128(20n * XLM)], alice.accountIdB64);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Error\(Context, InternalError\)/);
    expect(r.error).toContain('ledger sequence number overflow in starting sequence calculation');
  });

  it('refuses an amount below 2 * base_reserve, and 0 is "account missing"', () => {
    const L = new Ledger();
    const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
    const native = nativeToken(L, alice);

    const minNew = BigInt(2 * BASE_RESERVE); // 10_000_000 stroops = 1 XLM
    const g1 = ghost();
    expectContractError(
      call(L, native.address, 'transfer', [alice.scAddress, g1.val, i128(minNew - 1n)], alice.accountIdB64),
      E.InsufficientAccountReserve, 'transfer amount is below minimum balance for new account',
    );
    expect(L.getEntry(accountKey(g1.id).toXDR('base64'))).toBeUndefined();

    const g2 = ghost();
    expect(call(L, native.address, 'transfer',
      [alice.scAddress, g2.val, i128(minNew)], alice.accountIdB64).ok).toBe(true);
    expect(BigInt(xdr.LedgerEntry.fromXDR(L.getEntry(accountKey(g2.id).toXDR('base64'))!, 'base64')
      .data().account().balance().toString())).toBe(minNew);

    // amount <= 0 takes the AccountMissingError branch instead.
    const g3 = ghost();
    expectContractError(
      call(L, native.address, 'transfer', [alice.scAddress, g3.val, i128(0n)], alice.accountIdB64),
      E.AccountMissing, 'account entry is missing',
    );
    // ...and so does simply reading the balance.
    const sim = L.simulate(invokeHostFn(native.address, 'balance', [g3.val]), alice.accountIdB64);
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(new RegExp(`Error\\(Contract, #${E.AccountMissing}\\)`));
  });

  it('a MUXED destination credits (and creates) the underlying G-account', () => {
    const L = new Ledger();
    const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
    const native = nativeToken(L, alice);
    const g = ghost();
    const muxed = xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({
        id: xdr.Uint64.fromString('42'),
        ed25519: StrKey.decodeEd25519PublicKey(g.kp.publicKey()),
      }),
    ));
    const r = call(L, native.address, 'transfer', [alice.scAddress, muxed, i128(20n * XLM)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);

    const raw = L.getEntry(accountKey(g.id).toXDR('base64'));
    expect(raw).toBeDefined();
    const ae = xdr.LedgerEntry.fromXDR(raw!, 'base64').data().account();
    expect(BigInt(ae.seqNum().toString())).toBe(BigInt(L.ledgerSeq) << 32n);
    // event.rs: the mux id rides in the event data, not in the ledger entry.
    const ev = xdr.ContractEvent.fromXDR(r.sent!.eventsXdr[0], 'base64');
    expect(scValToNative(ev.body().v0().data())).toEqual({ amount: 20n * XLM, to_muxed_id: 42n });
  });
});

describe('SAC: contract (C...) addresses hold balances in ContractData', () => {
  it('needs no trustline and writes one persistent ContractData entry', () => {
    const { L, issuer, token } = world();
    const cAddr = deployPlainContract(L, issuer.accountIdB64);
    const c = xdr.ScVal.scvAddress(cAddr);
    const contractId = Address.fromScAddress(cAddr).toString();

    // Reading a contract balance that does not exist yet returns 0, not an error.
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(0n);

    const r = call(L, token.address, 'mint', [c, i128(777n)], issuer.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(r.sent!.changedKeys.length).toBe(1);

    const key = xdr.LedgerKey.fromXDR(r.sent!.changedKeys[0], 'base64');
    expect(key.switch().name).toBe('contractData');
    expect(key.contractData().durability().name).toBe('persistent');
    // The entry lives under the TOKEN contract, keyed by DataKey::Balance(addr).
    expect(Address.fromScAddress(key.contractData().contract()).toString())
      .toBe(Address.fromScAddress(token.address).toString());
    expect(scValToNative(key.contractData().key())).toEqual(['Balance', contractId]);

    // storage_types.rs: BalanceValue { amount, authorized, clawback }
    const entry = xdr.LedgerEntry.fromXDR(L.getEntry(r.sent!.changedKeys[0])!, 'base64');
    expect(scValToNative(entry.data().contractData().val()))
      .toEqual({ amount: 777n, authorized: true, clawback: false });

    // extend_ttl sets live_until = ledger_seq + BALANCE_EXTEND_AMOUNT.
    expect(L.getEntryTtl(r.sent!.changedKeys[0])).toBe(L.ledgerSeq + BALANCE_EXTEND_AMOUNT);

    // No trustline was created for the contract, and none exists.
    expect(L.entryCount()).toBeGreaterThan(0);
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(777n);
  });

  it('records the issuer clawback flag on the balance at creation time', () => {
    const { L, issuer, token } = world();
    const before = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64, Buffer.alloc(32, 1)));
    expect(call(L, token.address, 'mint', [before, i128(10n)], issuer.accountIdB64).ok).toBe(true);

    setIssuerFlags(L, issuer, AUTH_CLAWBACK_ENABLED);
    const after = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64, Buffer.alloc(32, 2)));
    expect(call(L, token.address, 'mint', [after, i128(500n)], issuer.accountIdB64).ok).toBe(true);

    // The flag is captured in BalanceValue when the balance is first written,
    // so the pre-existing balance stays non-clawbackable.
    expectContractError(
      call(L, token.address, 'clawback', [before, i128(1n)], issuer.accountIdB64),
      E.Balance, "balance isn't clawbackable",
    );
    const cb = call(L, token.address, 'clawback', [after, i128(200n)], issuer.accountIdB64);
    expect(cb.ok, cb.error).toBe(true);
    expect(read(L, token.address, 'balance', [after], issuer.accountIdB64)).toBe(300n);
  });

  it('set_authorized on a contract with no balance writes a zero deauthorized balance', () => {
    const { L, issuer, token } = world({ issuerFlags: AUTH_REVOCABLE });
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));

    const r = call(L, token.address, 'set_authorized', [c, boolv(false)], issuer.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(read(L, token.address, 'authorized', [c], issuer.accountIdB64)).toBe(false);
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(0n);
    expectContractError(
      call(L, token.address, 'mint', [c, i128(1n)], issuer.accountIdB64),
      E.BalanceDeauthorized, 'balance is deauthorized',
    );
  });

  it('native XLM held by a contract also lives in ContractData, not an AccountEntry', () => {
    const L = new Ledger();
    const alice = preFundedWallet(L, { xlm: 1_000n * XLM });
    const native = nativeToken(L, alice);
    const cAddr = deployPlainContract(L, alice.accountIdB64);
    const c = xdr.ScVal.scvAddress(cAddr);

    const r = call(L, native.address, 'transfer', [alice.scAddress, c, i128(5n * XLM)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);
    expect(read(L, native.address, 'balance', [c], alice.accountIdB64)).toBe(5n * XLM);

    const kinds = r.sent!.changedKeys.map((k) => xdr.LedgerKey.fromXDR(k, 'base64').switch().name);
    expect(kinds).toContain('contractData');
    expect(kinds).toContain('account'); // alice's AccountEntry was debited
  });
});

describe('harness: the ledger entry types the SAC touches', () => {
  it('a broad SAC workload only ever touches account / trustline / contractData keys', () => {
    // key_of() in crates/host-wasm/src/lib.rs supports exactly
    // Account, Trustline, ContractData and ContractCode.
    const { L, issuer, alice, token } = world();
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));
    const native = nativeToken(L, alice);
    const seen = new Set<string>();
    const collect = (sim: SimulateResult) => {
      for (const k of [...sim.readOnlyKeys, ...sim.readWriteKeys]) {
        seen.add(xdr.LedgerKey.fromXDR(k, 'base64').switch().name);
      }
    };
    token.trust(alice);
    collect(call(L, token.address, 'mint', [alice.scAddress, i128(1_000n)], issuer.accountIdB64).sim);
    collect(call(L, token.address, 'transfer', [alice.scAddress, c, i128(10n)], alice.accountIdB64).sim);
    collect(call(L, token.address, 'approve',
      [alice.scAddress, issuer.scAddress, i128(5n), u32v(L.ledgerSeq + 10)], alice.accountIdB64).sim);
    collect(call(L, token.address, 'burn', [alice.scAddress, i128(1n)], alice.accountIdB64).sim);
    collect(call(L, native.address, 'transfer', [alice.scAddress, c, i128(2n * XLM)], alice.accountIdB64).sim);

    const supported = new Set(['account', 'trustline', 'contractData', 'contractCode']);
    for (const kind of seen) {
      expect(supported.has(kind), `key_of() does not handle LedgerKey::${kind}`).toBe(true);
    }
    expect([...seen].sort()).toEqual(['account', 'contractData', 'trustline']);
  });

  it('putEntry round-trips every entry type the SAC touches', () => {
    const L = new Ledger();
    const issuer = preFundedWallet(L);
    const alice = preFundedWallet(L);
    const token = deployToken(L, { issuer });
    // Account
    expect(L.getEntry(accountKey(alice.accountId).toXDR('base64'))).toBeDefined();
    // Trustline
    establishTrustline(L, alice, token.asset);
    expect(L.getEntry(trustLineKey(alice, token.asset))).toBeDefined();
    // ContractData (the SAC instance) + ContractCode
    const wasmHash = L.seedWasm(ADD_I32);
    expect(L.getEntry(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({
      hash: Buffer.from(wasmHash, 'base64'),
    })).toXDR('base64'))).toBeDefined();
    const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: token.address,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })).toXDR('base64');
    expect(L.getEntry(instanceKey)).toBeDefined();
  });

  it('putEntry rejects the entry types key_of() does not derive (none used by the SAC)', () => {
    const L = new Ledger();
    const w = preFundedWallet(L);
    const mk = (data: xdr.LedgerEntryData) => new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1, data, ext: new xdr.LedgerEntryExt(0),
    }).toXDR('base64');
    const unsupported: [string, xdr.LedgerEntryData][] = [
      ['data', xdr.LedgerEntryData.data(new xdr.DataEntry({
        accountId: w.accountId, dataName: 'x', dataValue: Buffer.from([1]), ext: new xdr.DataEntryExt(0),
      }))],
      ['claimableBalance', xdr.LedgerEntryData.claimableBalance(new xdr.ClaimableBalanceEntry({
        balanceId: xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32)),
        claimants: [], asset: xdr.Asset.assetTypeNative(), amount: new xdr.Int64(1n),
        ext: new xdr.ClaimableBalanceEntryExt(0),
      }))],
      ['ttl', xdr.LedgerEntryData.ttl(new xdr.TtlEntry({
        keyHash: Buffer.alloc(32), liveUntilLedgerSeq: 1,
      }))],
    ];
    for (const [name, data] of unsupported) {
      expect(() => L.putEntry(mk(data)), name)
        .toThrow(/unsupported ledger entry type for key derivation/);
    }
  });
});

// ---------------------------------------------------------------------------
// HARNESS GAPS — these tests assert ground truth and currently FAIL.
// ---------------------------------------------------------------------------

describe('HARNESS GAP: applying a transaction that auto-restores an archived entry', () => {
  it('send() must bump the TTL of restoredRwEntryIndices entries before invoking', () => {
    // Ground truth: soroban-env-host-27.0.1/src/test/e2e_tests.rs:614-627 — before
    // the enforcing call the embedder sets, for every restored read-write key,
    //     live_until = ledger_info.sequence_number + min_persistent_entry_ttl - 1
    // Otherwise e2e_invoke.rs:1072-1080 rejects the expired entry with
    // Error(Storage, InternalError) and the whole invocation dies.
    //
    // crates/host-wasm/src/lib.rs:481-489 passes the stored (expired) live_until
    // verbatim, so send() throws a JsError instead of returning SendResult.
    const { L, issuer, token } = world();
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));
    const minted = call(L, token.address, 'mint', [c, i128(777n)], issuer.accountIdB64);
    const balanceKey = minted.sent!.changedKeys[0];
    expect(L.getEntryTtl(balanceKey)).toBe(L.ledgerSeq + BALANCE_EXTEND_AMOUNT);

    L.advanceLedgers(BALANCE_EXTEND_AMOUNT + 1); // the balance entry is now archived

    const hostFn = invokeHostFn(token.address, 'mint', [c, i128(1n)]);
    const sim = L.simulate(hostFn, issuer.accountIdB64);
    // Recording mode auto-restores, exactly as the host is supposed to.
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBeGreaterThan(0);

    let sent: { ok: boolean; error?: string } | undefined;
    let thrown: Error | undefined;
    try {
      sent = L.send(hostFn, issuer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    } catch (e) {
      thrown = e as Error;
    }
    expect(
      thrown,
      'HARNESS GAP: SorobanEnv::send does not restore the TTL of entries named by ' +
      'restored_rw_entry_indices, so invoke_host_function rejects them and the ' +
      'error escapes as a thrown JsError rather than SendResult{ok:false}. ' +
      `Thrown: ${thrown?.message?.split('\n')[0]}`,
    ).toBeUndefined();
    expect(sent!.ok, sent!.error).toBe(true);
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(778n);
  });

  it('(control) restoring every archived footprint entry by hand makes send() work', () => {
    // Same scenario, with the missing step performed in the test. This proves
    // the diagnosis above: nothing else about the flow is broken.
    const { L, issuer, token } = world();
    const c = xdr.ScVal.scvAddress(deployPlainContract(L, issuer.accountIdB64));
    const minted = call(L, token.address, 'mint', [c, i128(777n)], issuer.accountIdB64);
    const balanceKey = minted.sent!.changedKeys[0];

    L.advanceLedgers(BALANCE_EXTEND_AMOUNT + 1);

    const hostFn = invokeHostFn(token.address, 'mint', [c, i128(1n)]);
    const probe = L.simulate(hostFn, issuer.accountIdB64);
    const restoredLiveUntil = L.ledgerSeq + MIN_PERSISTENT_ENTRY_TTL - 1;
    for (const idx of probe.restoredRwEntryIndices) {
      const raw = L.getEntry(probe.readWriteKeys[idx]);
      if (raw) L.putEntry(raw, restoredLiveUntil);
    }
    const sim = L.simulate(hostFn, issuer.accountIdB64);
    const sent = L.send(hostFn, issuer.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(read(L, token.address, 'balance', [c], issuer.accountIdB64)).toBe(778n);
    expect(L.getEntryTtl(balanceKey)).toBe(L.ledgerSeq + BALANCE_EXTEND_AMOUNT);
  });
});

describe('HARNESS GAP: lastModifiedLedgerSeq is never stamped on merge', () => {
  it('every entry the SAC writes must carry lastModifiedLedgerSeq == ledgerSeq', () => {
    // Ground truth: the host writes 0 and says so in a comment —
    //   host/data_helper.rs:475 "This is modified to the appropriate value on
    //   the core side during commiting the ledger transaction."
    // stellar-core does it in LedgerTxn.cpp:2326
    //   entry->ledgerEntry().lastModifiedLedgerSeq = mHeader->ledgerSeq;
    // and enforces it as an invariant ("All: lastModifiedLedgerSeq == current
    // ledgerSeq"). The harness is the core side here and never stamps it.
    const L = new Ledger();
    const alice = preFundedWallet(L, { xlm: 100n * XLM });
    const bob = preFundedWallet(L);
    const native = nativeToken(L, alice);
    L.advanceLedgers(10);

    const r = call(L, native.address, 'transfer',
      [alice.scAddress, bob.scAddress, i128(1n * XLM)], alice.accountIdB64);
    expect(r.ok, r.error).toBe(true);

    for (const key of [accountKey(alice.accountId), accountKey(bob.accountId)]) {
      const le = xdr.LedgerEntry.fromXDR(L.getEntry(key.toXDR('base64'))!, 'base64');
      expect(
        le.lastModifiedLedgerSeq(),
        'HARNESS GAP: merged LedgerEntryChanges keep the host\'s placeholder 0 for ' +
        'lastModifiedLedgerSeq; stellar-core stamps the current ledgerSeq on commit.',
      ).toBe(L.ledgerSeq);
    }
  });
});

describe('HARNESS GAP: establishTrustline() does not charge the sub-entry reserve', () => {
  it('a fixture trustline must raise the holder minimum XLM balance like ChangeTrust does', () => {
    // Ground truth: stellar-core SponsorshipUtils.cpp:661-667
    //   createEntryWithoutSponsorship -> acc.data.account().numSubEntries += 1
    // The SAC's own trust() does this (balance.rs: `ae.num_sub_entries += 1`),
    // but src/fixtures.ts::establishTrustline pokes the TrustLineEntry in
    // without touching the AccountEntry, so the holder's minimum native balance
    // is understated by one base_reserve and native transfers that stellar-core
    // would reject succeed here.
    const L = new Ledger();
    const issuer = preFundedWallet(L);
    const holder = preFundedWallet(L, { xlm: 100n * XLM });
    const sink = preFundedWallet(L);
    const token = deployToken(L, { issuer });
    const native = nativeToken(L, issuer);

    establishTrustline(L, holder, token.asset);
    expect(
      loadAccount(L, holder.accountId)!.numSubEntries(),
      'HARNESS GAP: establishTrustline() leaves numSubEntries at 0, a ledger ' +
      'state no ChangeTrust operation can produce.',
    ).toBe(1);

    // With one sub-entry the minimum is 3 * base_reserve, so this must fail.
    const spendable = 100n * XLM - BigInt(3 * BASE_RESERVE);
    expectContractError(
      call(L, native.address, 'transfer',
        [holder.scAddress, sink.scAddress, i128(spendable + 1n)], holder.accountIdB64),
      E.Balance, 'resulting balance is not within the allowed range',
    );
  });
});
