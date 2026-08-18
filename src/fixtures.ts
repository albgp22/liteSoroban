/**
 * Ready-made test fixtures: funded wallets and deployed tokens.
 *
 * The point of an in-process ledger is that a fixture is a memory write, not a
 * network round trip. Everything here is microseconds, so `beforeEach` can build
 * a whole world per test instead of sharing one across a suite.
 */
import { xdr, Asset, Keypair, StrKey, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { Ledger, invokeHostFn } from './index.js';
import { accountIdFromPublicKey, loadAccount, storeAccount, type FundOptions } from './classic.js';

/** 1 XLM in stroops. */
export const XLM = 10_000_000n;

export interface Wallet {
  keypair: Keypair;
  /** G... strkey */
  publicKey: string;
  accountId: xdr.AccountId;
  /** base64 AccountId XDR — what the raw Ledger API takes as `source`. */
  accountIdB64: string;
  address: xdr.ScAddress;
  /** ScVal-wrapped address, for passing as a contract argument. */
  scAddress: xdr.ScVal;
  /** Current native XLM balance in stroops, read from the AccountEntry. */
  balance(): bigint;
  /** Current sequence number. */
  sequence(): bigint;
}

export interface WalletOptions extends Omit<FundOptions, 'balance'> {
  /** Native XLM balance in stroops. Defaults to 10,000 XLM. */
  xlm?: bigint;
}

/**
 * A wallet that already holds XLM. No friendbot, no network, no waiting.
 *
 * Note the default thresholds are `[1, 0, 0, 0]`, which is what stellar-core
 * gives a freshly created account — medium threshold 0, so its transactions do
 * not actually require a signature. Pass `thresholds: [1, 1, 1, 1]` when the
 * test is about signature checking.
 */
export function preFundedWallet(ledger: Ledger, opts: WalletOptions = {}): Wallet {
  const keypair = opts.signers === undefined && opts.thresholds === undefined
    ? Keypair.random()
    : Keypair.random();
  const publicKey = keypair.publicKey();

  ledger.fund(publicKey, {
    balance: opts.xlm ?? 10_000n * XLM,
    seqNum: opts.seqNum,
    thresholds: opts.thresholds,
    signers: opts.signers,
  });

  return wrapWallet(ledger, keypair);
}

/**
 * Create an account for an address whose secret key you do NOT have.
 *
 * The point: a test that needs real USDC only has Circle's issuer address. On a
 * network that is the end of it. Here an AccountEntry is just data, so you write
 * one — and because SAC minting is authorized by the issuer as TRANSACTION
 * SOURCE (source-account credentials, which carry no signature), owning the
 * entry is enough to mint. Owning the key is not.
 *
 * The returned wallet's keypair cannot sign; anything needing a real envelope
 * signature from this account will still fail, correctly.
 */
export function adoptAccount(
  ledger: Ledger,
  publicKey: string,
  opts: WalletOptions = {},
): Wallet {
  ledger.fund(publicKey, {
    balance: opts.xlm ?? 10_000n * XLM,
    seqNum: opts.seqNum,
    thresholds: opts.thresholds,
    signers: opts.signers,
  });
  return wrapWallet(ledger, Keypair.fromPublicKey(publicKey));
}

/** Wrap an existing keypair that is already funded in this ledger. */
export function wrapWallet(ledger: Ledger, keypair: Keypair): Wallet {
  const publicKey = keypair.publicKey();
  const accountId = accountIdFromPublicKey(publicKey);
  const address = xdr.ScAddress.scAddressTypeAccount(accountId);
  return {
    keypair,
    publicKey,
    accountId,
    accountIdB64: accountId.toXDR('base64'),
    address,
    scAddress: xdr.ScVal.scvAddress(address),
    balance: () => {
      const a = loadAccount(ledger, accountId);
      if (!a) throw new Error(`account ${publicKey} not found in ledger`);
      return BigInt(a.balance().toString());
    },
    sequence: () => {
      const a = loadAccount(ledger, accountId);
      if (!a) throw new Error(`account ${publicKey} not found in ledger`);
      return BigInt(a.seqNum().toString());
    },
  };
}

// ---------------------------------------------------------------------------
// Stellar Asset Contracts
// ---------------------------------------------------------------------------

export interface Token {
  asset: Asset;
  /** C... strkey */
  contractId: string;
  address: xdr.ScAddress;
  /** Give a wallet a trustline so it can hold this asset. Idempotent. */
  trust(holder: Wallet): void;
  /** Mint to a wallet or raw address. Authorized by the issuer. */
  mint(to: Wallet | xdr.ScAddress, amount: bigint): void;
  /**
   * Token balance. THROWS `Error(Contract, #13)` for a G-account with no
   * trustline — that is faithful Stellar behaviour, not a harness quirk. Call
   * `trust()` first, or use `balanceOrZero()`.
   */
  balanceOf(who: Wallet | xdr.ScAddress): bigint;
  /** Like `balanceOf`, but 0 when the holder has no trustline. */
  balanceOrZero(who: Wallet | xdr.ScAddress): bigint;
  /** Move tokens. Authorized by `from` as the transaction source. */
  transfer(from: Wallet, to: Wallet | xdr.ScAddress, amount: bigint): void;
  decimals(): number;
}

const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
/**
 * NOTE: do NOT test `'accountId' in who`. js-xdr unions expose an accessor for
 * EVERY arm on the prototype, so that is true for a contract ScAddress too.
 * `address` only exists on Wallet.
 */
const isWallet = (who: Wallet | xdr.ScAddress): who is Wallet =>
  'address' in who && 'accountIdB64' in who;
const addrOf = (who: Wallet | xdr.ScAddress): xdr.ScAddress =>
  isWallet(who) ? who.address : (who as xdr.ScAddress);

function sacCreateHostFn(asset: Asset): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeCreateContract(
    new xdr.CreateContractArgs({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(asset.toXDRObject()),
      // The Stellar Asset Contract is a BUILTIN host contract: nothing to upload.
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    }),
  );
}

/** Apply a host function and throw with the host's own diagnostics on failure. */
function apply(ledger: Ledger, hostFn: xdr.HostFunction, sourceB64: string) {
  const sim = ledger.simulate(hostFn, sourceB64);
  if (!sim.ok) throw new Error(`simulate failed: ${sim.error}`);
  const sent = ledger.send(
    hostFn, sourceB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
  );
  if (!sent.ok) throw new Error(`send failed: ${sent.error}`);
  return sent;
}

/**
 * Give an account a trustline for a credit asset, by writing the
 * `TrustLineEntry` straight into the ledger.
 *
 * Holding a non-native asset requires a trustline in Stellar — minting to an
 * account without one fails with `Error(Contract, #13)` / "trustline entry is
 * missing for account". Establishing one normally takes a classic ChangeTrust
 * operation, which a Soroban transaction may not contain, so a fixture pokes the
 * entry in directly. This is the `set_account` escape hatch again.
 *
 * The AUTHORIZED flag is set, which is what an issuer without AUTH_REQUIRED
 * produces. Clear it to test authorization failures.
 */
export function establishTrustline(
  ledger: Ledger,
  holder: Wallet,
  asset: Asset,
  opts: { limit?: bigint; balance?: bigint; authorized?: boolean } = {},
): void {
  if (asset.isNative()) return; // native XLM needs no trustline

  const code = asset.getCode();
  const issuerId = accountIdFromPublicKey(asset.getIssuer());
  const trustLineAsset =
    code.length <= 4
      ? xdr.TrustLineAsset.assetTypeCreditAlphanum4(
          new xdr.AlphaNum4({
            assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(4)], 4),
            issuer: issuerId,
          }),
        )
      : xdr.TrustLineAsset.assetTypeCreditAlphanum12(
          new xdr.AlphaNum12({
            assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(12)], 12),
            issuer: issuerId,
          }),
        );

  const entry = new xdr.TrustLineEntry({
    accountId: holder.accountId,
    asset: trustLineAsset,
    balance: new xdr.Int64(opts.balance ?? 0n),
    limit: new xdr.Int64(opts.limit ?? 9_223_372_036_854_775_807n),
    flags: (opts.authorized ?? true) ? xdr.TrustLineFlags.authorizedFlag().value : 0,
    ext: new xdr.TrustLineEntryExt(0),
  });

  // Only a CREATE charges a sub-entry and initialises the balance. core's
  // ChangeTrustOpFrame increments numSubEntries when it creates the trustline
  // and leaves it alone on modify; doing it unconditionally both double-counts
  // (permanently locking 5 XLM per extra call out of availableBalance) and
  // silently zeroes an existing balance.
  const existingRaw = ledger.getEntry(trustlineKey(holder, asset).toXDR('base64'));
  if (existingRaw) {
    const existing = xdr.LedgerEntry.fromXDR(existingRaw, 'base64').data().trustLine();
    // Preserve the balance unless the caller explicitly set one.
    if (opts.balance === undefined) entry.balance(existing.balance());
  }

  ledger.putEntry(
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: ledger.ledgerSeq,
      data: xdr.LedgerEntryData.trustline(entry),
      ext: new xdr.LedgerEntryExt(0),
    }).toXDR('base64'),
  );

  if (!existingRaw) {
    const account = loadAccount(ledger, holder.accountId);
    if (account) {
      account.numSubEntries(account.numSubEntries() + 1);
      storeAccount(ledger, account);
    }
  }
}

/** The LedgerKey for a holder's trustline in a credit asset. */
export function trustlineKey(holder: Wallet, asset: Asset): xdr.LedgerKey {
  const code = asset.getCode();
  const issuerId = accountIdFromPublicKey(asset.getIssuer());
  const tlAsset =
    code.length <= 4
      ? xdr.TrustLineAsset.assetTypeCreditAlphanum4(
          new xdr.AlphaNum4({
            assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(4)], 4),
            issuer: issuerId,
          }),
        )
      : xdr.TrustLineAsset.assetTypeCreditAlphanum12(
          new xdr.AlphaNum12({
            assetCode: Buffer.concat([Buffer.from(code, 'ascii'), Buffer.alloc(12)], 12),
            issuer: issuerId,
          }),
        );
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId: holder.accountId, asset: tlAsset }),
  );
}

/** Idempotent: only writes a trustline if the holder has none for this asset. */
function establishTrustlineIfMissing(ledger: Ledger, holder: Wallet, asset: Asset): void {
  if (asset.isNative()) return;
  if (ledger.getEntry(trustlineKey(holder, asset).toXDR('base64'))) return;
  establishTrustline(ledger, holder, asset);
}

export interface TokenOptions {
  code?: string;
  /** Defaults to a freshly funded issuer wallet. */
  issuer?: Wallet;
}

/**
 * Deploy a Stellar Asset Contract for a credit asset and return a handle.
 * The issuer is funded automatically unless one is supplied.
 */
export function deployToken(ledger: Ledger, opts: TokenOptions = {}): Token & { issuer: Wallet } {
  const issuer = opts.issuer ?? preFundedWallet(ledger);
  return deployTokenForAsset(ledger, new Asset(opts.code ?? 'TEST', issuer.publicKey), issuer);
}

/**
 * Deploy the SAC for an arbitrary asset, including one issued by an address you
 * do not control. The issuer account must already exist — use `adoptAccount`
 * for a foreign one.
 */
export function deployTokenForAsset(
  ledger: Ledger,
  asset: Asset,
  issuer?: Wallet,
): Token & { issuer: Wallet } {
  const issuerWallet = issuer ?? wrapWallet(ledger, Keypair.fromPublicKey(asset.getIssuer()));
  return buildToken(ledger, asset, issuerWallet);
}

function buildToken(ledger: Ledger, asset: Asset, issuer: Wallet): Token & { issuer: Wallet } {
  apply(ledger, sacCreateHostFn(asset), issuer.accountIdB64);

  const contractId = asset.contractId(ledger.networkPassphrase);
  const address = Address.fromString(contractId).toScAddress();

  const call = (fn: string, args: xdr.ScVal[], sourceB64: string) =>
    apply(ledger, invokeHostFn(address, fn, args), sourceB64);

  const read = (fn: string, args: xdr.ScVal[], sourceB64: string) => {
    const sim = ledger.simulate(invokeHostFn(address, fn, args), sourceB64);
    if (!sim.ok) throw new Error(`${fn} failed: ${sim.error}`);
    return scValToNative(xdr.ScVal.fromXDR(sim.returnValueXdr!, 'base64'));
  };

  return {
    asset,
    issuer,
    contractId,
    address,
    mint(to, amount) {
      // A G-account must hold a trustline before it can receive a credit asset.
      // Contract (C...) recipients do not need one.
      if (isWallet(to)) establishTrustlineIfMissing(ledger, to, asset);
      // The issuer authorizes as the transaction source account, so no
      // signature is involved — source-account credentials need none.
      call('mint', [xdr.ScVal.scvAddress(addrOf(to)), i128(amount)], issuer.accountIdB64);
    },
    trust(holder) {
      establishTrustlineIfMissing(ledger, holder, asset);
    },
    balanceOf(who) {
      return BigInt(read('balance', [xdr.ScVal.scvAddress(addrOf(who))], issuer.accountIdB64));
    },
    balanceOrZero(who) {
      try {
        return BigInt(read('balance', [xdr.ScVal.scvAddress(addrOf(who))], issuer.accountIdB64));
      } catch {
        return 0n;
      }
    },
    transfer(from, to, amount) {
      if (isWallet(to)) establishTrustlineIfMissing(ledger, to, asset);
      call(
        'transfer',
        [xdr.ScVal.scvAddress(from.address), xdr.ScVal.scvAddress(addrOf(to)), i128(amount)],
        from.accountIdB64,
      );
    },
    decimals() {
      return Number(read('decimals', [], issuer.accountIdB64));
    },
  };
}

/** The SAC for native XLM. Balances come from AccountEntry, and it cannot mint. */
export function nativeToken(ledger: Ledger, deployer: Wallet): Omit<Token, 'mint'> {
  const asset = Asset.native();
  apply(ledger, sacCreateHostFn(asset), deployer.accountIdB64);

  const contractId = asset.contractId(ledger.networkPassphrase);
  const address = Address.fromString(contractId).toScAddress();

  const read = (fn: string, args: xdr.ScVal[]) => {
    const sim = ledger.simulate(invokeHostFn(address, fn, args), deployer.accountIdB64);
    if (!sim.ok) throw new Error(`${fn} failed: ${sim.error}`);
    return scValToNative(xdr.ScVal.fromXDR(sim.returnValueXdr!, 'base64'));
  };

  return {
    asset,
    contractId,
    address,
    balanceOf: (who) => BigInt(read('balance', [xdr.ScVal.scvAddress(addrOf(who))])),
    transfer(from, to, amount) {
      apply(
        ledger,
        invokeHostFn(address, 'transfer', [
          xdr.ScVal.scvAddress(from.address),
          xdr.ScVal.scvAddress(addrOf(to)),
          i128(amount),
        ]),
        from.accountIdB64,
      );
    },
    decimals: () => Number(read('decimals', [])),
  };
}

// ---------------------------------------------------------------------------
// One-call world
// ---------------------------------------------------------------------------

export interface World {
  ledger: Ledger;
  /** A wallet holding XLM. */
  wallet: Wallet;
  /** A deployed token, with `minted` already credited to `wallet`. */
  token: Token & { issuer: Wallet };
}

export interface WorldOptions {
  xlm?: bigint;
  tokenCode?: string;
  /** Tokens minted to `wallet` during setup. Defaults to 1,000,000 units. */
  minted?: bigint;
  ledger?: Ledger;
}

/**
 * A funded wallet plus a deployed token with a starting balance, in one call.
 * Cheap enough to run in `beforeEach`.
 */
export function setupWorld(opts: WorldOptions = {}): World {
  const ledger = opts.ledger ?? new Ledger();
  const wallet = preFundedWallet(ledger, { xlm: opts.xlm });
  const token = deployToken(ledger, { code: opts.tokenCode });
  token.mint(wallet, opts.minted ?? 1_000_000n * 10_000_000n);
  return { ledger, wallet, token };
}
