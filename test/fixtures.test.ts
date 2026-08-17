import { describe, it, expect, beforeEach } from 'vitest';
import { Asset } from '@stellar/stellar-sdk';
import { Ledger } from '../src/index.js';
import {
  preFundedWallet,
  deployToken,
  nativeToken,
  setupWorld,
  XLM,
} from '../src/fixtures.js';

describe('fixtures: pre-funded wallets and deployed tokens', () => {
  let L: Ledger;

  beforeEach(() => {
    L = new Ledger();
  });

  it('preFundedWallet starts with XLM and no network', () => {
    const w = preFundedWallet(L);
    expect(w.publicKey.startsWith('G')).toBe(true);
    expect(w.balance()).toBe(10_000n * XLM);
    expect(w.sequence()).toBe(0n);
  });

  it('the XLM amount is configurable', () => {
    const w = preFundedWallet(L, { xlm: 42n * XLM });
    expect(w.balance()).toBe(420_000_000n);
  });

  it('deploys a SAC and mints to a wallet', () => {
    const w = preFundedWallet(L);
    const token = deployToken(L, { code: 'USDC' });

    expect(token.contractId.startsWith('C')).toBe(true);
    expect(token.decimals()).toBe(7);

    // Faithful Stellar: without a trustline the account cannot hold the asset,
    // and even reading its balance errors with Error(Contract, #13).
    expect(() => token.balanceOf(w)).toThrow(/trustline entry is missing/);
    expect(token.balanceOrZero(w)).toBe(0n);

    token.trust(w);
    expect(token.balanceOf(w)).toBe(0n);

    token.mint(w, 1_500n);
    expect(token.balanceOf(w)).toBe(1_500n);
  });

  it('transfers tokens between wallets', () => {
    const alice = preFundedWallet(L);
    const bob = preFundedWallet(L);
    const token = deployToken(L);

    token.mint(alice, 1_000n);
    token.transfer(alice, bob, 400n);

    expect(token.balanceOf(alice)).toBe(600n);
    expect(token.balanceOf(bob)).toBe(400n);
  });

  it('the contract id matches what the SDK derives for the asset', () => {
    const token = deployToken(L, { code: 'ABCD' });
    const expected = new Asset('ABCD', token.issuer.publicKey).contractId(L.networkPassphrase);
    expect(token.contractId).toBe(expected);
  });

  it('the native XLM SAC reads AccountEntry balances', () => {
    const w = preFundedWallet(L, { xlm: 77n * XLM });
    const native = nativeToken(L, w);
    expect(native.decimals()).toBe(7);
    expect(native.balanceOf(w)).toBe(770_000_000n);
  });

  it('setupWorld gives a funded wallet with a token balance in one call', () => {
    const { ledger, wallet, token } = setupWorld();
    expect(wallet.balance()).toBe(10_000n * XLM);
    expect(token.balanceOf(wallet)).toBe(1_000_000n * 10_000_000n);
    expect(ledger.entryCount()).toBeGreaterThan(0);
  });

  it('setupWorld is cheap enough for beforeEach', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) setupWorld();
    const perWorld = (performance.now() - t0) / 20;
    console.log(`  setupWorld: ${perWorld.toFixed(2)} ms`);
    expect(perWorld).toBeLessThan(100);
  });

  it('worlds are fully isolated from each other', () => {
    const a = setupWorld();
    const b = setupWorld();
    a.token.mint(a.wallet, 5n);
    // b's wallet has no trustline in a's ledger — the ledgers share nothing.
    expect(a.token.balanceOrZero(b.wallet)).toBe(0n);
    expect(b.token.balanceOf(b.wallet)).toBe(1_000_000n * 10_000_000n);
  });

  it('snapshot/restore rolls back minted balances', () => {
    const { ledger, wallet, token } = setupWorld();
    const before = token.balanceOf(wallet);
    const snap = ledger.snapshot();

    token.mint(wallet, 999n);
    expect(token.balanceOf(wallet)).toBe(before + 999n);

    ledger.restore(snap);
    expect(token.balanceOf(wallet)).toBe(before);
  });
});
