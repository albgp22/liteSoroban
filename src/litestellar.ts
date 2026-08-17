/**
 * LiteStellar — an in-process Stellar ledger for tests.
 *
 * Shaped after LiteSVM, and for the same reasons: one object you construct, a
 * fluent config with switches that turn OFF the realism you are not testing,
 * direct state manipulation as a first-class citizen, and a synchronous API so
 * tests read like assertions instead of promise chains.
 *
 * Under it sits the real `soroban-env-host` compiled to wasm — see src/index.ts
 * for the low-level `Ledger`, which stays exposed for tests that are about the
 * envelope, the footprint or the RPC wire.
 *
 *   const svm = new LiteStellar().withSigverify(false);
 *   const alice = svm.airdrop();
 *   const token = svm.deployToken({ code: 'USDC' });
 *   token.mint(alice, 1_000n);
 *
 *   const c = svm.deployContract(wasm, { as: alice });
 *   expect(c.invoke('add', [i32(2), i32(3)])).toBe(5);
 */
import {
  xdr,
  Asset,
  Address,
  Keypair,
  Networks,
  rpc,
  hash as sha256,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';

import { Ledger, createContractHostFn, uploadWasmHostFn, invokeHostFn, HOST_PROTOCOL } from './index.js';
import type { SimulateResult, SendResult } from './index.js';
import {
  accountIdFromPublicKey,
  loadAccount,
  applyTransaction,
  type FundOptions,
  type TxOutcome,
  type ValidationOptions,
} from './classic.js';
import {
  preFundedWallet,
  wrapWallet,
  deployToken as deployTokenFixture,
  nativeToken as nativeTokenFixture,
  establishTrustline,
  XLM,
  type Wallet,
  type Token,
} from './fixtures.js';
import { attachInProcessRpc } from './fake-rpc.js';
import type { AuthProofBuilder } from './auth.js';

export { XLM };
export type { Wallet, Token, AuthProofBuilder };

// ---------------------------------------------------------------------------
// errors — parsed, not stringly-typed
// ---------------------------------------------------------------------------

/**
 * A host failure with its error type and code pulled out of the host's Rust
 * Debug output, so tests can assert on a SPECIFIC error rather than substring
 * matching a formatted string.
 */
export class HostFailure extends Error {
  /** e.g. 'Storage', 'Auth', 'Budget', 'WasmVm', 'Value', 'Contract' */
  readonly errorType?: string;
  /** e.g. 'ExceededLimit', 'InvalidAction', 'ExistingValue' */
  readonly errorCode?: string;
  /** Set when the failure is a contract-defined error: Error(Contract, #13) -> 13 */
  readonly contractCode?: number;
  /** The full host output, diagnostics included. */
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = 'HostFailure';
    this.raw = raw;
    const m = /Error\(([A-Za-z]+),\s*(#?\d+|[A-Za-z]+)\)/.exec(raw);
    if (m) {
      this.errorType = m[1];
      if (m[2].startsWith('#')) this.contractCode = Number(m[2].slice(1));
      else this.errorCode = m[2];
    }
  }

  /** True when this is the given host error, e.g. is('Storage', 'ExceededLimit'). */
  is(type: string, code?: string): boolean {
    return this.errorType === type && (code === undefined || this.errorCode === code);
  }
}

function hostFailure(prefix: string, raw: string | undefined): HostFailure {
  const text = raw ?? '(no diagnostics)';
  const first = text.split('\n')[0];
  return new HostFailure(`${prefix}: ${first}`, text);
}

// ---------------------------------------------------------------------------
// synchronous authorization-entry signing
// ---------------------------------------------------------------------------

/**
 * Sign recorded auth entries WITHOUT going async.
 *
 * The SDK's `authorizeEntry` is async purely because it awaits the signer
 * callback. Rebuilding the preimage is a dozen lines, and keeping the whole API
 * synchronous is worth it — LiteSVM's ergonomics depend on it.
 *
 * Mirrors base/auth.js:115: legacy `Address` credentials use the plain
 * SorobanAuthorization preimage; `AddressV2` and `AddressWithDelegates` (CAP-71)
 * bind the address in via the WithAddress preimage.
 */
export function signAuthEntriesSync(
  entriesB64: string[],
  opts: { sign: (payload: Buffer) => xdr.ScVal; networkPassphrase: string; validUntilLedgerSeq: number },
): string[] {
  const networkId = sha256(Buffer.from(opts.networkPassphrase));

  return entriesB64.map((b64) => {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64');
    const credentials = entry.credentials();
    // Source-account credentials carry no signature at all.
    if (credentials.switch().name === 'sorobanCredentialsSourceAccount') return b64;

    const addr = credentials.address();
    addr.signatureExpirationLedger(opts.validUntilLedgerSeq);

    let preimage: xdr.HashIdPreimage;
    if (credentials.switch().name === 'sorobanCredentialsAddress') {
      preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: addr.nonce(),
          signatureExpirationLedger: opts.validUntilLedgerSeq,
          invocation: entry.rootInvocation(),
        }),
      );
    } else {
      preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
        new (xdr as any).HashIdPreimageSorobanAuthorizationWithAddress({
          networkId,
          address: addr.address(),
          nonce: addr.nonce(),
          signatureExpirationLedger: opts.validUntilLedgerSeq,
          invocation: entry.rootInvocation(),
        }),
      );
    }

    addr.signature(opts.sign(sha256(preimage.toXDR())));
    return entry.toXDR('base64');
  });
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  /** Source account for the invocation. Defaults to the environment's payer. */
  as?: Wallet;
  /**
   * Proof builder for a custom account's `__check_auth`. Supplying this makes
   * the call do the full round trip: record auth, sign it, re-simulate under
   * enforcing auth to widen the footprint, then apply.
   */
  signAuth?: AuthProofBuilder;
  /** Ledger at which the signature expires. Defaults to now + 100. */
  validUntilLedger?: number;
}

export interface InvokeResult {
  ok: boolean;
  /** Decoded return value, when the call succeeded. */
  value?: any;
  error?: HostFailure;
  events: xdr.ContractEvent[];
  /** Instructions the enforcing pass measured. */
  instructions: number;
  readBytes: number;
  writeBytes: number;
  footprint: { readOnly: string[]; readWrite: string[] };
  changedKeys: string[];
  removedKeys: string[];
}

export interface DeployOptions extends InvokeOptions {
  constructorArgs?: xdr.ScVal[];
  salt?: Buffer;
}

// ---------------------------------------------------------------------------
// Contract handle
// ---------------------------------------------------------------------------

export class Contract {
  constructor(
    private readonly env: LiteStellar,
    readonly address: xdr.ScAddress,
  ) {}

  /** C... strkey */
  get contractId(): string {
    return Address.fromScAddress(this.address).toString();
  }

  /** ScVal-wrapped address, for passing this contract as an argument. */
  get scAddress(): xdr.ScVal {
    return xdr.ScVal.scvAddress(this.address);
  }

  /** Invoke and return the DECODED value. Throws HostFailure on failure. */
  invoke(fn: string, args: xdr.ScVal[] = [], opts: InvokeOptions = {}): any {
    const r = this.tryInvoke(fn, args, opts);
    if (!r.ok) throw r.error;
    return r.value;
  }

  /** Invoke without throwing — inspect `ok`, `error`, `events`, `instructions`. */
  tryInvoke(fn: string, args: xdr.ScVal[] = [], opts: InvokeOptions = {}): InvokeResult {
    return this.env.invokeContract(this.address, fn, args, opts);
  }

  /** Simulate only: no state change, but a real footprint and resource measurement. */
  simulate(fn: string, args: xdr.ScVal[] = [], opts: InvokeOptions = {}): SimulateResult {
    return this.env.simulateContract(this.address, fn, args, opts);
  }

  /** Read-only convenience: simulate and decode. Throws on failure. */
  view(fn: string, args: xdr.ScVal[] = [], opts: InvokeOptions = {}): any {
    const sim = this.simulate(fn, args, opts);
    if (!sim.ok) throw hostFailure(`${fn} failed`, sim.error);
    return scValToNative(xdr.ScVal.fromXDR(sim.returnValueXdr!, 'base64'));
  }
}

// ---------------------------------------------------------------------------
// LiteStellar
// ---------------------------------------------------------------------------

export interface LiteStellarOptions {
  protocolVersion?: number;
  networkPassphrase?: string;
  ledgerSequence?: number;
}

export class LiteStellar {
  /** The low-level ledger. Use it directly when the test IS about the plumbing. */
  readonly ledger: Ledger;

  private validation: ValidationOptions = {};
  private payerWallet?: Wallet;

  constructor(opts: LiteStellarOptions = {}) {
    this.ledger = new Ledger({
      protocolVersion: opts.protocolVersion,
      networkPassphrase: opts.networkPassphrase,
      ledgerSeq: opts.ledgerSequence,
    });
  }

  // -- fluent configuration ------------------------------------------------

  /** Turn envelope signature verification off, LiteSVM style. */
  withSigverify(on: boolean): this {
    this.validation.sigverify = on;
    return this;
  }
  /** Stop enforcing strict seqNum + 1 on submitted envelopes. */
  withSequenceCheck(on: boolean): this {
    this.validation.sequenceCheck = on;
    return this;
  }
  /** Stop debiting fees. */
  withFeeCharging(on: boolean): this {
    this.validation.feeCharging = on;
    return this;
  }
  /** Stop enforcing timebounds. */
  withTimebounds(on: boolean): this {
    this.validation.timebounds = on;
    return this;
  }
  /** Everything off: the fastest, least realistic configuration. */
  withoutClassicChecks(): this {
    return this.withSigverify(false).withSequenceCheck(false).withTimebounds(false);
  }
  /** The account used as the source when a call does not name one. */
  withPayer(wallet: Wallet): this {
    this.payerWallet = wallet;
    return this;
  }

  // -- environment ---------------------------------------------------------

  get protocolVersion(): number {
    return this.ledger.protocolVersion;
  }
  get networkPassphrase(): string {
    return this.ledger.networkPassphrase;
  }
  get ledgerSequence(): number {
    return this.ledger.ledgerSeq;
  }
  get timestamp(): number {
    return this.ledger.timestamp;
  }
  get entryCount(): number {
    return this.ledger.entryCount();
  }

  /** The default source account, created on first use. */
  get payer(): Wallet {
    if (!this.payerWallet) this.payerWallet = preFundedWallet(this.ledger);
    return this.payerWallet;
  }

  // -- time travel ---------------------------------------------------------

  advanceLedgers(n: number): this {
    this.ledger.advanceLedgers(n);
    return this;
  }

  /** Jump straight to a ledger sequence — the analogue of warpToSlot. */
  warpToLedger(sequence: number): this {
    const delta = sequence - this.ledger.ledgerSeq;
    if (delta < 0) throw new Error(`cannot warp backwards: at ${this.ledger.ledgerSeq}, asked ${sequence}`);
    this.ledger.advanceLedgers(delta);
    return this;
  }

  setTimestamp(t: number | bigint): this {
    this.ledger.setTimestamp(t);
    return this;
  }

  // -- accounts ------------------------------------------------------------

  /** Create a funded account and return a wallet. The analogue of airdrop(). */
  airdrop(xlm: bigint = 10_000n * XLM, opts: Omit<FundOptions, 'balance'> = {}): Wallet {
    return preFundedWallet(this.ledger, { xlm, ...opts });
  }

  /** Fund a keypair you already hold. */
  fund(keypair: Keypair, xlm: bigint = 10_000n * XLM, opts: Omit<FundOptions, 'balance'> = {}): Wallet {
    this.ledger.fund(keypair.publicKey(), { balance: xlm, ...opts });
    return wrapWallet(this.ledger, keypair);
  }

  getAccount(publicKey: string): xdr.AccountEntry | null {
    return loadAccount(this.ledger, accountIdFromPublicKey(publicKey));
  }

  getBalance(publicKey: string): bigint {
    const a = this.getAccount(publicKey);
    return a ? BigInt(a.balance().toString()) : 0n;
  }

  /** Write any ledger entry directly — the set_account escape hatch. */
  setEntry(entryB64: string, liveUntil?: number): string {
    return this.ledger.putEntry(entryB64, liveUntil);
  }
  getEntry(keyB64: string): string | undefined {
    return this.ledger.getEntry(keyB64);
  }
  getEntryTtl(keyB64: string): number | undefined {
    return this.ledger.getEntryTtl(keyB64);
  }
  deleteEntry(keyB64: string): boolean {
    return this.ledger.removeEntry(keyB64);
  }

  // -- contracts -----------------------------------------------------------

  /** Put contract code in the ledger without a transaction. Returns the hash. */
  addContract(wasm: Uint8Array): string {
    return this.ledger.seedWasm(wasm);
  }

  /** Upload through a real UploadContractWasm host function. */
  uploadContract(wasm: Uint8Array, opts: InvokeOptions = {}): string {
    const source = this.sourceOf(opts);
    const sim = this.ledger.simulate(uploadWasmHostFn(wasm), source);
    if (!sim.ok) throw hostFailure('upload simulation failed', sim.error);
    const sent = this.ledger.send(
      uploadWasmHostFn(wasm), source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices,
    );
    if (!sent.ok) throw hostFailure('upload failed', sent.error);
    return sent.returnValueXdr!;
  }

  /** Seed the code and instantiate a contract from it. */
  deployContract(wasm: Uint8Array, opts: DeployOptions = {}): Contract {
    const wasmHash = this.ledger.seedWasm(wasm);
    return this.deployFromHash(wasmHash, opts);
  }

  deployFromHash(wasmHashB64: string, opts: DeployOptions = {}): Contract {
    const source = this.sourceOf(opts);
    const hostFn = createContractHostFn(
      source, wasmHashB64, opts.salt ?? Buffer.alloc(32), opts.constructorArgs ?? [],
    );
    const result = this.applyHostFn(hostFn, source, opts);
    if (!result.ok) throw result.error;
    return new Contract(this, xdr.ScVal.fromXDR(result.rawReturn!, 'base64').address());
  }

  /** A handle for a contract that is already deployed. */
  contractAt(id: string | xdr.ScAddress): Contract {
    const address = typeof id === 'string' ? Address.fromString(id).toScAddress() : id;
    return new Contract(this, address);
  }

  // -- tokens --------------------------------------------------------------

  deployToken(opts: { code?: string; issuer?: Wallet } = {}): Token & { issuer: Wallet } {
    return deployTokenFixture(this.ledger, opts);
  }

  nativeToken(deployer: Wallet = this.payer): Omit<Token, 'mint'> {
    return nativeTokenFixture(this.ledger, deployer);
  }

  trust(holder: Wallet, asset: Asset, opts: { limit?: bigint; authorized?: boolean } = {}): this {
    establishTrustline(this.ledger, holder, asset, opts);
    return this;
  }

  // -- invocation ----------------------------------------------------------

  /** Used by Contract; prefer `contract.invoke(...)`. */
  invokeContract(
    address: xdr.ScAddress,
    fn: string,
    args: xdr.ScVal[],
    opts: InvokeOptions = {},
  ): InvokeResult {
    const source = this.sourceOf(opts);
    const r = this.applyHostFn(invokeHostFn(address, fn, args), source, opts);
    return {
      ok: r.ok,
      value: r.ok && r.rawReturn ? scValToNative(xdr.ScVal.fromXDR(r.rawReturn, 'base64')) : undefined,
      error: r.error,
      events: (r.events ?? []).map((e) => xdr.ContractEvent.fromXDR(e, 'base64')),
      instructions: r.sim?.instructions ?? 0,
      readBytes: r.sim?.readBytes ?? 0,
      writeBytes: r.sim?.writeBytes ?? 0,
      footprint: {
        readOnly: r.sim?.readOnlyKeys ?? [],
        readWrite: r.sim?.readWriteKeys ?? [],
      },
      changedKeys: r.changedKeys ?? [],
      removedKeys: r.removedKeys ?? [],
    };
  }

  simulateContract(
    address: xdr.ScAddress,
    fn: string,
    args: xdr.ScVal[],
    opts: InvokeOptions = {},
  ): SimulateResult {
    return this.ledger.simulate(invokeHostFn(address, fn, args), this.sourceOf(opts));
  }

  /**
   * The full round trip, in one place:
   *   simulate -> (sign auth) -> (re-simulate enforcing) -> apply.
   * The middle two steps only happen when `signAuth` is supplied, which is
   * exactly when a custom account's `__check_auth` is in the path.
   */
  private applyHostFn(
    hostFn: xdr.HostFunction,
    source: string,
    opts: InvokeOptions,
  ): {
    ok: boolean;
    rawReturn?: string;
    error?: HostFailure;
    events?: string[];
    changedKeys?: string[];
    removedKeys?: string[];
    sim?: SimulateResult;
  } {
    const recorded = this.ledger.simulate(hostFn, source);
    if (!recorded.ok) {
      return { ok: false, error: hostFailure('simulation failed', recorded.error), sim: recorded };
    }

    let sim = recorded;
    let auth = recorded.authXdr;

    if (opts.signAuth && auth.length > 0) {
      const signed = signAuthEntriesSync(auth, {
        sign: opts.signAuth as (p: Buffer) => xdr.ScVal,
        networkPassphrase: this.ledger.networkPassphrase,
        validUntilLedgerSeq: opts.validUntilLedger ?? this.ledger.ledgerSeq + 100,
      });
      // Only the enforcing pass runs __check_auth, so only it sees the entries
      // that __check_auth reads. Skipping this yields a footprint violation.
      const enforced = this.ledger.simulateWithAuth(hostFn, source, signed);
      if (!enforced.ok) {
        return { ok: false, error: hostFailure('authorization failed', enforced.error), sim: enforced };
      }
      sim = enforced;
      auth = signed;
    }

    const sent: SendResult = this.ledger.send(
      hostFn, source, sim.resourcesXdr, auth, sim.restoredRwEntryIndices,
    );
    if (!sent.ok) {
      return { ok: false, error: hostFailure('invocation failed', sent.error), sim };
    }
    return {
      ok: true,
      rawReturn: sent.returnValueXdr,
      events: sent.eventsXdr,
      changedKeys: sent.changedKeys,
      removedKeys: sent.removedKeys,
      sim,
    };
  }

  // -- the classic path ----------------------------------------------------

  /** Submit a signed envelope through the full classic validation. */
  sendTransaction(envelopeB64: string): TxOutcome {
    return applyTransaction(this.ledger, envelopeB64, this.ledger.networkPassphrase, this.validation);
  }

  /** An rpc.Server backed by this environment, with zero network access. */
  rpcServer(url = 'https://in-process.invalid'): rpc.Server {
    const server = new rpc.Server(url);
    attachInProcessRpc(server, this.ledger);
    return server;
  }

  // -- isolation -----------------------------------------------------------

  snapshot(): number {
    return this.ledger.snapshot();
  }
  restore(id: number): this {
    this.ledger.restore(id);
    return this;
  }

  /** Run `body` against a snapshot and roll back afterwards, always. */
  sandboxed<T>(body: (env: this) => T): T {
    const snap = this.snapshot();
    try {
      return body(this);
    } finally {
      this.restore(snap);
    }
  }

  // -- internals -----------------------------------------------------------

  private sourceOf(opts: InvokeOptions): string {
    return (opts.as ?? this.payer).accountIdB64;
  }
}

// ---------------------------------------------------------------------------
// argument helpers — the noisiest part of writing Soroban tests
// ---------------------------------------------------------------------------

export const sc = {
  sym: (s: string) => nativeToScVal(s, { type: 'symbol' }),
  str: (s: string) => nativeToScVal(s, { type: 'string' }),
  u32: (n: number) => nativeToScVal(n, { type: 'u32' }),
  i32: (n: number) => nativeToScVal(n, { type: 'i32' }),
  u64: (n: bigint) => nativeToScVal(n, { type: 'u64' }),
  i64: (n: bigint) => nativeToScVal(n, { type: 'i64' }),
  u128: (n: bigint) => nativeToScVal(n, { type: 'u128' }),
  i128: (n: bigint) => nativeToScVal(n, { type: 'i128' }),
  bool: (b: boolean) => xdr.ScVal.scvBool(b),
  bytes: (b: Buffer | Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b)),
  vec: (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items),
  map: (entries: { key: xdr.ScVal; val: xdr.ScVal }[]) =>
    xdr.ScVal.scvMap(entries.map((e) => new xdr.ScMapEntry({ key: e.key, val: e.val }))),
  address: (a: Wallet | Contract | xdr.ScAddress) =>
    xdr.ScVal.scvAddress('address' in a ? (a.address as xdr.ScAddress) : (a as xdr.ScAddress)),
  void: () => xdr.ScVal.scvVoid(),
};
