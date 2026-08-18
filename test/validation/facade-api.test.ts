/**
 * Adversarial review of the LiteStellar facade AS AN API (src/litestellar.ts,
 * src/fixtures.ts), measured against LiteSVM's contract and against this repo's
 * own documentation.
 *
 * Every test here asserts the behaviour the API DOCUMENTS. A red test is a
 * demonstrated defect, not a wrong expectation — the comment above each one
 * names the source of truth (GUIDE.md line, doc comment, SDK source, or the
 * pinned soroban-env-common).
 *
 * Reference shape: litesvm/crates/litesvm/src/lib.rs and
 * crates/node-litesvm/litesvm/index.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Keypair,
  Address,
  Networks,
  authorizeEntry,
  rpc,
  TransactionBuilder,
  Operation,
  Account,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, XLM, HostFailure, signAuthEntriesSync } from '../../src/litestellar.js';
import { createP256Signer, smartAccountSecp256r1, type P256Signer } from '../../src/auth.js';

const f = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));
const ADD_I32 = f('add_i32.wasm');
const SMART_ACCOUNT = f('smart_account_current.wasm');

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const ADMIN = xdr.ScVal.scvVec([sym('Admin')]);
const p256Signer = (s: P256Signer, role = ADMIN) =>
  xdr.ScVal.scvVec([
    sym('Secp256r1'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym('public_key'), val: xdr.ScVal.scvBytes(s.publicKey) }),
    ]),
    role,
  ]);

/** Build a submittable Soroban envelope for `add(2,3)` on `c`. */
function envelope(
  svm: LiteStellar,
  from: { publicKey: string; sequence(): bigint; accountIdB64: string },
  c: { contractId: string; address: xdr.ScAddress },
  o: { seq?: bigint; maxTime?: number } = {},
): string {
  const seq = o.seq ?? from.sequence();
  let b = new TransactionBuilder(new Account(from.publicKey, String(seq)), {
    fee: '1000000',
    networkPassphrase: svm.networkPassphrase,
  }).addOperation(
    Operation.invokeContractFunction({
      contract: c.contractId,
      function: 'add',
      args: [sc.i32(2), sc.i32(3)],
    }),
  );
  b = o.maxTime !== undefined ? b.setTimebounds(0, o.maxTime) : b.setTimeout(300);
  const tx = b.build();
  const hf = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: c.address,
      functionName: 'add',
      args: [sc.i32(2), sc.i32(3)],
    }),
  );
  const sim = svm.ledger.simulate(hf, from.accountIdB64);
  return TransactionBuilder.cloneFrom(tx, {
    fee: '1000000',
    sorobanData: new xdr.SorobanTransactionData({
      ext: new (xdr as any).SorobanTransactionDataExt(0),
      resources: xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64'),
      resourceFee: (xdr as any).Int64.fromString('500000'),
    }),
  })
    .build()
    .toXDR();
}

// ---------------------------------------------------------------------------
// 1. the escape hatches
// ---------------------------------------------------------------------------

describe('escape hatches: do they disable what they claim?', () => {
  // Each individual switch DOES work; these four are the control group.
  it('withSigverify(false) really skips signature checks', () => {
    const svm = new LiteStellar().withSigverify(false);
    const a = svm.airdrop(1000n * XLM, { thresholds: [1, 1, 1, 1] });
    const c = svm.deployContract(ADD_I32, { as: a });
    expect(svm.sendTransaction(envelope(svm, a, c)).code).toBe('txSUCCESS');
  });

  it('withSequenceCheck(false) really skips seqNum + 1', () => {
    const svm = new LiteStellar().withSigverify(false).withSequenceCheck(false);
    const a = svm.airdrop(1000n * XLM);
    const c = svm.deployContract(ADD_I32, { as: a });
    expect(svm.sendTransaction(envelope(svm, a, c, { seq: a.sequence() + 40n })).code).toBe(
      'txSUCCESS',
    );
  });

  it('withTimebounds(false) really skips timebounds', () => {
    const svm = new LiteStellar().withSigverify(false).withTimebounds(false);
    svm.setTimestamp(2_000_000_000);
    const a = svm.airdrop(1000n * XLM);
    const c = svm.deployContract(ADD_I32, { as: a });
    expect(svm.sendTransaction(envelope(svm, a, c, { maxTime: 1_000 })).code).toBe('txSUCCESS');
  });

  it('withFeeCharging(false) really stops the debit', () => {
    const svm = new LiteStellar().withSigverify(false).withFeeCharging(false);
    const a = svm.airdrop(1000n * XLM);
    const c = svm.deployContract(ADD_I32, { as: a });
    const before = a.balance();
    svm.sendTransaction(envelope(svm, a, c));
    expect(before - a.balance()).toBe(0n);
  });

  /**
   * DEFECT 1. GUIDE.md:359-365 documents the five switches as a block and
   * `withoutClassicChecks()` as "// all of the above" — the list it closes
   * includes `.withFeeCharging(false)`. litestellar.ts:304-306 omits it:
   *
   *   withoutClassicChecks(): this {
   *     return this.withSigverify(false).withSequenceCheck(false).withTimebounds(false);
   *   }
   *
   * So "the fastest, least realistic configuration" still debits the source
   * account, and a balance assertion written against it is silently wrong.
   */
  it('withoutClassicChecks() turns OFF fee charging, as documented', () => {
    const svm = new LiteStellar().withoutClassicChecks();
    const a = svm.airdrop(1000n * XLM, { thresholds: [1, 1, 1, 1] });
    const c = svm.deployContract(ADD_I32, { as: a });
    const before = a.balance();
    const out = svm.sendTransaction(envelope(svm, a, c, { seq: a.sequence() + 40n }));
    expect(out.code).toBe('txSUCCESS');
    expect(before - a.balance(), 'withoutClassicChecks() still debited the fee').toBe(0n);
  });

  /**
   * DEFECT 2. The switches live on the LiteStellar object, but `rpcServer()`
   * (litestellar.ts:617-621) hands `this.ledger` to attachInProcessRpc, and
   * fake-rpc.ts:500 calls `ledger.sendTransaction(...)`, which is
   * index.ts:147 -> `applyTransaction(this, env, passphrase)` with NO
   * ValidationOptions. Every switch is dropped on the floor for the exact path
   * GUIDE.md:323-365 tells you to use for "testing your app unchanged".
   *
   * The same envelope succeeds through svm.sendTransaction() and is rejected
   * through svm.rpcServer() on the same LiteStellar.
   */
  it('rpcServer() honours the validation switches', async () => {
    const svm = new LiteStellar().withoutClassicChecks();
    const alice = svm.airdrop(1000n * XLM, { thresholds: [1, 1, 1, 1] });
    const c = svm.deployContract(ADD_I32, { as: alice });
    const envB64 = envelope(svm, alice, c); // deliberately UNSIGNED

    // control: the facade path respects withSigverify(false)
    expect(svm.sendTransaction(envB64).code).toBe('txSUCCESS');

    const svm2 = new LiteStellar().withoutClassicChecks();
    const alice2 = svm2.airdrop(1000n * XLM, { thresholds: [1, 1, 1, 1] });
    const c2 = svm2.deployContract(ADD_I32, { as: alice2 });
    const env2 = envelope(svm2, alice2, c2);
    const sent = await svm2.rpcServer().sendTransaction(
      TransactionBuilder.fromXDR(env2, svm2.networkPassphrase) as any,
    );
    expect(sent.status, 'rpcServer() ignored withSigverify(false)').not.toBe('ERROR');
  });
});

// ---------------------------------------------------------------------------
// 2. siblings of the salt-collision bug
// ---------------------------------------------------------------------------

describe('deployContract salt namespaces', () => {
  /**
   * DEFECT 3 — a direct sibling of the salt-collision bug. GUIDE.md:396-398:
   * "The default salt increments; pass `salt` only if you want a specific
   * address." That only holds if the two namespaces are disjoint. They are not:
   * litestellar.ts:645-649 starts saltCounter at 0, and
   *
   *   const salt = Buffer.alloc(32); salt.writeUInt32BE(0, 28);
   *
   * is 32 zero bytes — byte-identical to the `Buffer.alloc(32)` a reader of the
   * factory section (GUIDE.md:188-208) writes by hand. Explicit salts also
   * never advance the counter, so the collision is symmetric.
   */
  it('an explicit Buffer.alloc(32) salt does not collide with the default salt', () => {
    const svm = new LiteStellar();
    svm.deployContract(ADD_I32); // auto salt #0 == 32 zero bytes
    expect(() => svm.deployContract(ADD_I32, { salt: Buffer.alloc(32) })).not.toThrow();
  });

  it('the default salt does not collide with a previously used explicit salt', () => {
    const svm = new LiteStellar();
    svm.deployContract(ADD_I32, { salt: Buffer.alloc(32) });
    expect(() => svm.deployContract(ADD_I32)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. isolation: the facade's own state is outside the snapshot
// ---------------------------------------------------------------------------

describe('snapshot / restore / sandboxed', () => {
  /**
   * DEFECT 4a. `get payer()` (litestellar.ts:363-366) memoises a lazily created
   * wallet in a field the snapshot does not cover. Roll back past its creation
   * and LiteStellar keeps handing out a wallet whose AccountEntry is gone —
   * and never recreates it, despite the doc comment "created on first use".
   */
  it('the default payer still exists after a rollback that removed it', () => {
    const svm = new LiteStellar();
    // Expensive setup inside the sandbox is exactly the shape GUIDE.md:229-248
    // recommends; the payer is created lazily in here.
    svm.sandboxed(() => {
      svm.deployContract(ADD_I32);
    });
    expect(svm.entryCount).toBe(0);
    expect(() => svm.payer.balance(), 'payer wallet survived a rollback of its own account').not.toThrow();
  });

  /**
   * DEFECT 4b. saltCounter is facade state too, so replaying identical setup
   * from a restored ledger produces a DIFFERENT contract address and therefore
   * a different ledger. GUIDE.md:250-257 sells stateHash() as the exact proof
   * of a rollback; it cannot prove a replay is exact.
   */
  it('replaying the same setup after restore() reproduces the same ledger', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const snap = svm.snapshot();
    const setup = () => {
      svm.deployContract(ADD_I32, { as: alice });
      return svm.stateHash();
    };
    const first = setup();
    svm.restore(snap);
    expect(setup(), 'replay after restore produced a different ledger').toBe(first);
  });

  /**
   * DEFECT 5. Snapshot ids are plain indices into a per-instance Vec
   * (crates/host-wasm/src/lib.rs:454-479) with no instance tag. Passing one
   * LiteStellar's id to another silently restores the WRONG ledger whenever the
   * index happens to exist, and throws an opaque "no such snapshot" when it
   * does not. LiteSVM has no numeric handle for exactly this reason.
   */
  it('a snapshot id from a different LiteStellar is rejected, not silently applied', () => {
    const a = new LiteStellar();
    const b = new LiteStellar();
    a.airdrop();
    a.snapshot();
    a.airdrop();
    const idFromA = a.snapshot();

    b.airdrop();
    b.snapshot();
    b.airdrop();
    b.snapshot();
    b.airdrop();
    b.airdrop();
    const before = b.stateHash();

    expect(() => b.restore(idFromA)).toThrow();
    expect(b.stateHash(), 'b was silently rolled back by a foreign snapshot id').toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. the hand-rolled auth preimage
// ---------------------------------------------------------------------------

describe('signAuthEntriesSync vs the SDK', () => {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32, 3)),
        functionName: 'go',
        args: [],
      }),
    ),
    subInvocations: [],
  });
  const kp = Keypair.random();
  const addrCreds = () =>
    new xdr.SorobanAddressCredentials({
      address: new Address(kp.publicKey()).toScAddress(),
      nonce: new xdr.Int64(7n),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVec([]),
    });
  const entryFor = (creds: xdr.SorobanCredentials) =>
    new xdr.SorobanAuthorizationEntry({ rootInvocation: invocation, credentials: creds });

  const SIG = xdr.ScVal.scvBytes(Buffer.alloc(4, 1));

  async function sdkPayloadFor(entry: xdr.SorobanAuthorizationEntry): Promise<Buffer> {
    let payload!: Buffer;
    await authorizeEntry(
      entry,
      async (_p, p) => {
        payload = Buffer.from(p);
        return { signatureScVal: SIG };
      },
      12345,
      Networks.TESTNET,
    );
    return payload;
  }

  // control: the legacy Address arm is byte-identical to the SDK.
  it('matches the SDK for legacy Address credentials', async () => {
    const entry = entryFor(xdr.SorobanCredentials.sorobanCredentialsAddress(addrCreds()));
    const sdk = await sdkPayloadFor(entry);
    let ours!: Buffer;
    signAuthEntriesSync([entry.toXDR('base64')], {
      sign: (p) => {
        ours = Buffer.from(p);
        return SIG;
      },
      networkPassphrase: Networks.TESTNET,
      validUntilLedgerSeq: 12345,
    });
    expect(ours.equals(sdk)).toBe(true);
  });

  /**
   * DEFECT 6. litestellar.ts:139 reads `credentials.address()` UNCONDITIONALLY,
   * before the arm test on line 143. js-xdr throws "address not set" for any
   * other arm, so the CAP-71 `envelopeTypeSorobanAuthorizationWithAddress`
   * branch on lines 152-161 is unreachable dead code — the exact case its
   * comment (lines 122-125) claims to handle.
   *
   * The SDK gets this right by dispatching first
   * (stellar-sdk/lib/esm/base/auth.js:201-212, getAddressCredentials):
   *   Address        -> credentials.address()
   *   AddressV2      -> credentials.addressV2()
   *   WithDelegates  -> credentials.addressWithDelegates().addressCredentials()
   */
  it('matches the SDK for AddressV2 (CAP-71) credentials', async () => {
    const entry = entryFor(xdr.SorobanCredentials.sorobanCredentialsAddressV2(addrCreds()));
    const sdk = await sdkPayloadFor(entry);
    let ours!: Buffer;
    signAuthEntriesSync([entry.toXDR('base64')], {
      sign: (p) => {
        ours = Buffer.from(p);
        return SIG;
      },
      networkPassphrase: Networks.TESTNET,
      validUntilLedgerSeq: 12345,
    });
    expect(ours.equals(sdk)).toBe(true);
  });

  it('matches the SDK for AddressWithDelegates (CAP-71) credentials', async () => {
    const entry = entryFor(
      xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new (xdr as any).SorobanAddressCredentialsWithDelegates({
          addressCredentials: addrCreds(),
          delegates: [],
        }),
      ),
    );
    const sdk = await sdkPayloadFor(entry);
    let ours!: Buffer;
    signAuthEntriesSync([entry.toXDR('base64')], {
      sign: (p) => {
        ours = Buffer.from(p);
        return SIG;
      },
      networkPassphrase: Networks.TESTNET,
      validUntilLedgerSeq: 12345,
    });
    expect(ours.equals(sdk)).toBe(true);
  });

  /**
   * DEFECT 7. `AuthProofBuilder` (auth.ts:23) is
   *   (payload: Buffer) => xdr.ScVal | Promise<xdr.ScVal>
   * and its doc says "May be async — P-256 signers often are" (a real passkey
   * IS async: navigator.credentials.get). `InvokeOptions.signAuth` is typed as
   * that builder, so TypeScript accepts an async signer with no cast — but
   * litestellar.ts:573 casts the async half away:
   *
   *   sign: opts.signAuth as (p: Buffer) => xdr.ScVal
   *
   * and the Promise is handed to js-xdr as the signature. The failure surfaces
   * as `XdrWriterError: [object Promise] has union name undefined, not ScVal`,
   * which names neither signAuth nor async.
   */
  it('an async signAuth builder is either supported or rejected clearly', () => {
    const svm = new LiteStellar();
    const pk = createP256Signer();
    const acct = svm.deployContract(SMART_ACCOUNT, {
      constructorArgs: [sc.vec([p256Signer(pk)]), sc.vec([])],
    });
    const asyncBuilder = async (payload: Buffer) => smartAccountSecp256r1(pk)(payload) as xdr.ScVal;

    let thrown: unknown;
    try {
      acct.tryInvoke('add_signer', [p256Signer(createP256Signer())], { signAuth: asyncBuilder });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown === undefined || /async|await|Promise.*signAuth|signAuth/i.test(String(thrown)),
      `async signAuth failed with an unrelated error: ${thrown}`,
    ).toBe(true);
  });

  /**
   * DEFECT 8. When the enforcing pass fails — the ONE failure mode signAuth
   * exists to expose — litestellar.ts:581 returns without `diagnostics`, so
   * `r.diagnostics` is empty. GUIDE.md:290-299 promises diagnostics "which the
   * host produces on failure too", and the same failure through the ordinary
   * path does deliver them.
   */
  it('keeps host diagnostics when enforcing auth fails', () => {
    const svm = new LiteStellar();
    const pk = createP256Signer();
    const acct = svm.deployContract(SMART_ACCOUNT, {
      constructorArgs: [sc.vec([p256Signer(pk)]), sc.vec([])],
    });
    const newSigner = p256Signer(createP256Signer());

    // control: same failure, no signAuth -> 6 diagnostic events
    expect(acct.tryInvoke('add_signer', [newSigner]).diagnostics.length).toBeGreaterThan(0);

    const r = acct.tryInvoke('add_signer', [newSigner], {
      signAuth: smartAccountSecp256r1(createP256Signer()), // not a signer on the account
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length, 'diagnostics dropped on the enforcing-auth failure path').toBeGreaterThan(0);
  });

  /**
   * DEFECT 9. `Contract.view` / `Contract.simulate` take an `InvokeOptions`,
   * so `signAuth` and `validUntilLedger` type-check — and are then dropped:
   * simulateContract (litestellar.ts:529-536) only reads `opts.as`.
   */
  it('view()/simulate() do not silently accept options they ignore', () => {
    const svm = new LiteStellar();
    const pk = createP256Signer();
    const acct = svm.deployContract(SMART_ACCOUNT, {
      constructorArgs: [sc.vec([p256Signer(pk)]), sc.vec([])],
    });
    let called = false;
    acct.simulate('add_signer', [p256Signer(createP256Signer())], {
      signAuth: () => {
        called = true;
        return xdr.ScVal.scvVoid();
      },
    });
    expect(called, 'simulate() accepted signAuth and never called it').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. HostFailure parsing
// ---------------------------------------------------------------------------

describe('HostFailure error parsing', () => {
  /**
   * DEFECT 10. soroban-env-common-27.0.1/src/error.rs:66-88 prints FOUR shapes.
   * The regex at litestellar.ts:92 handles two:
   *
   *   :74  Error(Contract, #maj)      -> contractCode      OK
   *   :76  Error(Type, CodeName)      -> errorType/Code    OK
   *   :78  Error(Type, #maj)          -> misread as contractCode
   *   :82  Error(#min, CodeName)      -> no match at all
   *   :84  Error(#min, #maj)          -> no match at all
   *
   * `contractCode` is documented "Set when the failure is a contract-defined
   * error", so line :78 makes a host-internal code look contract-defined.
   */
  it('does not report a contractCode for a non-Contract error', () => {
    const h = new HostFailure('x', 'HostError: Error(Storage, #99)');
    expect(h.errorType).toBe('Storage');
    expect(h.contractCode, 'a Storage error was reported as contract error #99').toBeUndefined();
  });

  it('signals that an unrecognised error shape was not parsed', () => {
    // error.rs:82 — a known code under an unknown type.
    const h = new HostFailure('x', 'HostError: Error(#77, InvalidInput)');
    // Nothing distinguishes "no error information" from "parsed"; every is()
    // query answers false and a test can pass vacuously.
    expect(
      h.errorType !== undefined || h.errorCode !== undefined || h.contractCode !== undefined,
      'unparsed host error left every field undefined with no signal',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. fixtures
// ---------------------------------------------------------------------------

describe('fixtures', () => {
  /**
   * DEFECT 11. `Token.trust` (fixtures.ts:324) routes through
   * establishTrustlineIfMissing and is documented "Idempotent". The facade's
   * `LiteStellar.trust` (litestellar.ts:495-498) calls establishTrustline
   * DIRECTLY, which unconditionally writes a fresh TrustLineEntry with
   * `balance: opts.balance ?? 0n` and increments numSubEntries again.
   *
   * So the call GUIDE.md:105-107 offers for "sets up an authorization failure"
   * — `svm.trust(w, asset, { authorized: false })` — silently zeroes an
   * existing balance and double-charges the base reserve.
   */
  it('svm.trust() does not wipe an existing balance', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const usdc = svm.deployToken({ code: 'USDC' });
    usdc.mint(alice, 1_000n);
    expect(usdc.balanceOf(alice)).toBe(1_000n);

    svm.trust(alice, usdc.asset, { authorized: false });
    expect(usdc.balanceOf(alice), 'svm.trust() zeroed the holder balance').toBe(1_000n);
  });

  it('svm.trust() does not double-count the sub-entry reserve', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const usdc = svm.deployToken({ code: 'USDC' });
    usdc.trust(alice);
    const subs = svm.getAccount(alice.publicKey)!.numSubEntries();
    svm.trust(alice, usdc.asset);
    expect(svm.getAccount(alice.publicKey)!.numSubEntries(), 'a second trust() added a phantom sub-entry').toBe(subs);
  });

  /**
   * DEFECT 12. `nativeToken()` reads as a lookup of THE native SAC — one exists
   * per network, its address is fixed by the passphrase, and the doc comment
   * says "The SAC for native XLM". It is really a deploy: fixtures.ts:354 calls
   * the CreateContract host function every time, so the second call on a shared
   * LiteStellar dies with Error(Storage, ExistingValue) "contract already
   * exists". Nothing in GUIDE.md warns about it.
   */
  it('nativeToken() can be called twice on the same environment', () => {
    const svm = new LiteStellar();
    const first = svm.nativeToken();
    expect(() => svm.nativeToken()).not.toThrow();
    expect(svm.nativeToken().contractId).toBe(first.contractId);
  });
});
