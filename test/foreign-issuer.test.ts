/**
 * Tokens whose issuer you do not control.
 *
 * The common case: your app touches real USDC, and a test needs a wallet that
 * holds some. You have the issuer's public address and no secret key, and on a
 * real network that is the end of the conversation.
 *
 * In-process it is not, because minting through a SAC is authorized by the
 * ISSUER AS TRANSACTION SOURCE — source-account credentials, which carry no
 * signature. Owning the account entry is enough; owning the key is not required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { xdr, Asset, StrKey, Keypair } from '@stellar/stellar-sdk';
import { LiteStellar, sc, XLM } from '../src/litestellar.js';
import { accountIdFromPublicKey } from '../src/classic.js';
import { establishTrustline, deployToken } from '../src/fixtures.js';

/** Circle's real USDC issuer on Stellar mainnet. We hold no key for it. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('a token whose issuer we do not control', () => {
  let svm: LiteStellar;

  beforeEach(() => {
    svm = new LiteStellar();
  });

  it('we genuinely do not have the secret key', () => {
    expect(StrKey.isValidEd25519PublicKey(USDC_ISSUER)).toBe(true);
    // There is no Keypair here and no way to make one — only the address.
    expect(() => Keypair.fromPublicKey(USDC_ISSUER).sign(Buffer.alloc(32))).toThrow();
  });

  it('route 1: materialise the issuer account, then mint as normal', () => {
    // An AccountEntry is just data. Writing one for an address we do not own is
    // exactly the LiteSVM set_account move.
    const issuer = svm.adoptAccount(USDC_ISSUER);
    expect(svm.getBalance(USDC_ISSUER)).toBeGreaterThan(0n);

    const usdc = svm.deployTokenFor(new Asset('USDC', USDC_ISSUER));
    const alice = svm.airdrop();

    usdc.mint(alice, 250_000_0000000n); // 250k USDC, 7 decimals
    expect(usdc.balanceOf(alice)).toBe(250_000_0000000n);
    expect(usdc.contractId).toBe(
      new Asset('USDC', USDC_ISSUER).contractId(svm.networkPassphrase),
    );
    expect(issuer.publicKey).toBe(USDC_ISSUER);
  });

  it('the contract id matches the real network id for that asset', () => {
    // Same passphrase in, same C... out — so a test can assert against the
    // contract id an app has hardcoded for mainnet USDC.
    const mainnet = new LiteStellar({
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    mainnet.adoptAccount(USDC_ISSUER);
    const usdc = mainnet.deployTokenFor(new Asset('USDC', USDC_ISSUER));
    expect(usdc.contractId).toBe(
      new Asset('USDC', USDC_ISSUER).contractId(mainnet.networkPassphrase),
    );
  });

  it('route 2: write the balance straight into the trustline, no SAC at all', () => {
    const alice = svm.airdrop();
    const asset = new Asset('USDC', USDC_ISSUER);

    // No issuer account, no contract deployment, no execution: just state.
    establishTrustline(svm.ledger, alice, asset, { balance: 1_000_0000000n });

    // ...and the SAC, deployed later, agrees with it.
    svm.adoptAccount(USDC_ISSUER);
    const usdc = svm.deployTokenFor(asset);
    expect(usdc.balanceOf(alice)).toBe(1_000_0000000n);
  });

  it('route 2 is dramatically cheaper than minting', () => {
    const asset = new Asset('USDC', USDC_ISSUER);

    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      const env = new LiteStellar();
      establishTrustline(env.ledger, env.airdrop(), asset, { balance: 1_000n });
    }
    const direct = (performance.now() - t0) / 50;

    const t1 = performance.now();
    for (let i = 0; i < 50; i++) {
      const env = new LiteStellar();
      env.adoptAccount(USDC_ISSUER);
      env.deployTokenFor(asset).mint(env.airdrop(), 1_000n);
    }
    const minted = (performance.now() - t1) / 50;

    console.log(`  trustline write ${direct.toFixed(2)} ms   vs   deploy+mint ${minted.toFixed(2)} ms`);
    expect(direct).toBeLessThan(minted);
  });

  it('the issuer can be given AUTH_REQUIRED-style unauthorized trustlines', () => {
    const alice = svm.airdrop();
    const asset = new Asset('USDC', USDC_ISSUER);
    svm.adoptAccount(USDC_ISSUER);
    const usdc = svm.deployTokenFor(asset);

    // A trustline that exists but is not authorized.
    establishTrustline(svm.ledger, alice, asset, { authorized: false });
    expect(() => usdc.mint(alice, 100n)).toThrow();
  });

  it('adoptAccount does not invent a keypair it cannot have', () => {
    const issuer = svm.adoptAccount(USDC_ISSUER);
    expect(issuer.publicKey).toBe(USDC_ISSUER);
    expect(issuer.keypair.canSign()).toBe(false);
    // It can still be a transaction source, because source-account auth needs
    // no signature — which is exactly why minting works.
    expect(issuer.accountIdB64).toBe(accountIdFromPublicKey(USDC_ISSUER).toXDR('base64'));
  });

  it('a locally-issued token still works the normal way', () => {
    const alice = svm.airdrop();
    const local = deployToken(svm.ledger, { code: 'TEST' });
    local.mint(alice, 5n);
    expect(local.balanceOf(alice)).toBe(5n);
  });
});
