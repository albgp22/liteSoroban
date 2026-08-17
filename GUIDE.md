# Using liteSoroban

Every snippet below is executed by `test/guide.test.ts`, so it cannot rot.

- [Setup](#setup)
- [Five minutes](#five-minutes)
- [Accounts and XLM](#accounts-and-xlm)
- [Contracts](#contracts)
- [Tokens](#tokens)
- [Tokens you do not issue](#tokens-you-do-not-issue)
- [Custom accounts and passkeys](#custom-accounts-and-passkeys)
- [Deploying through a factory](#deploying-through-a-factory)
- [Test isolation](#test-isolation)
- [Time travel](#time-travel)
- [Asserting on failures](#asserting-on-failures)
- [Asserting on resources](#asserting-on-resources)
- [Testing your app unchanged](#testing-your-app-unchanged)
- [Dropping to the low level](#dropping-to-the-low-level)
- [Gotchas](#gotchas)

## Setup

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build:wasm
npm test
```

The wasm artifact is a build product and is not committed, so `build:wasm` is a
one-time prerequisite. It takes about five seconds.

## Five minutes

```ts
import { LiteStellar, sc } from '../src/litestellar.js';

const svm   = new LiteStellar();
const alice = svm.airdrop();                       // funded account, no friendbot
const c     = svm.deployContract(ADD_I32_WASM);    // upload + instantiate

expect(c.invoke('add', [sc.i32(2), sc.i32(3)])).toBe(5);
```

`invoke` runs the whole simulate → apply cycle, returns the **decoded** value,
and throws on failure. That is the 90% path.

## Accounts and XLM

```ts
const alice = svm.airdrop();                  // 10,000 XLM by default
const poor  = svm.airdrop(5n * XLM);          // 5 XLM
const multi = svm.airdrop(100n * XLM, {
  thresholds: [1, 1, 2, 3],                   // [master, low, medium, high]
  signers: [{ key: cosigner.publicKey(), weight: 1 }],
});

alice.balance();      // bigint, in stroops
alice.sequence();     // bigint
alice.publicKey;      // G...
alice.scAddress;      // ready to pass as a contract argument
```

A wallet carries its `Keypair`, so it can sign. `svm.fund(existingKeypair)`
wraps a keypair you already hold.

> Default thresholds are `[1, 0, 0, 0]` — what stellar-core gives a fresh
> account. That does **not** mean transactions from it need no signature; see
> [Gotchas](#gotchas).

## Contracts

```ts
const c = svm.deployContract(wasm);                          // default payer
const d = svm.deployContract(wasm, { as: alice });           // named deployer
const e = svm.deployContract(wasm, {
  constructorArgs: [sc.vec([signer]), sc.vec([])],           // __constructor
});

c.invoke('put_persistent', [sc.sym('k'), sc.u64(42n)]);      // decoded, throws
c.view('get_persistent', [sc.sym('k')]);                     // read-only, decoded
c.tryInvoke('get_persistent', [sc.sym('nope')]);             // never throws

svm.contractAt('CA7...');                                    // an existing contract
```

Argument helpers live on `sc`: `sym str u32 i32 u64 i64 u128 i128 bool bytes vec
map address void`.

## Tokens

```ts
const usdc = svm.deployToken({ code: 'USDC' });   // issuer funded automatically
usdc.mint(alice, 1_000n);
usdc.transfer(alice, bob, 250n);
usdc.balanceOf(bob);                              // 250n
usdc.decimals();                                  // 7
usdc.contractId;                                  // C...

const xlm = svm.nativeToken();                    // the native SAC
xlm.balanceOf(alice);                             // reads the AccountEntry
```

Holding a credit asset requires a trustline. `mint` and `transfer` create one
for a wallet recipient automatically; `usdc.trust(w)` does it explicitly, and
`svm.trust(w, asset, { authorized: false })` sets up an authorization failure.

## Tokens you do not issue

Your app touches real USDC. A test needs a wallet holding some. You have Circle's
issuer address and no secret key — on a network that is the end of it.

It is not the end of it here, because minting through a SAC is authorized by the
**issuer as transaction source**: source-account credentials, which carry no
signature. Owning the account entry is enough; owning the key is not.

```ts
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

svm.adoptAccount(USDC_ISSUER);                                 // write the entry
const usdc = svm.deployTokenFor(new Asset('USDC', USDC_ISSUER));

usdc.mint(alice, 250_000_0000000n);                            // 250k USDC
usdc.balanceOf(alice);
```

The contract id is derived from `(asset, network passphrase)`, so with the
mainnet passphrase you get **the same `C...` address your app has hardcoded**:

```ts
const svm = new LiteStellar({ networkPassphrase: Networks.PUBLIC });
svm.adoptAccount(USDC_ISSUER);
svm.deployTokenFor(new Asset('USDC', USDC_ISSUER)).contractId
// === new Asset('USDC', USDC_ISSUER).contractId(Networks.PUBLIC)
```

`adoptAccount` does not fabricate a keypair it cannot have — the returned
wallet's `keypair.canSign()` is `false`, so anything genuinely needing an
envelope signature from that account still fails, correctly.

**Faster route: skip the token entirely and write the balance.** If the test only
needs the wallet to *have* the asset, poke the trustline in — no issuer account,
no contract, no execution. Measured at **0.21 ms vs 0.70 ms** for deploy+mint:

```ts
import { establishTrustline } from '../src/fixtures.js';

establishTrustline(svm.ledger, alice, new Asset('USDC', USDC_ISSUER), {
  balance: 1_000_0000000n,
});
```

A SAC deployed for that asset afterwards agrees with the balance you wrote. And
`{ authorized: false }` gives you a trustline that exists but is not authorized,
for testing the failure path.

## Custom accounts and passkeys

Authorizing through a contract account takes four steps — simulate, sign the
recorded auth entries, re-simulate under enforcing auth so the footprint covers
what `__check_auth` reads, then apply. Pass `signAuth` and it is one call:

```ts
import { createP256Signer, smartAccountSecp256r1 } from '../src/auth.js';

const passkey = createP256Signer();               // P-256, low-S, prehash
const account = svm.deployContract(SMART_ACCOUNT, {
  constructorArgs: [sc.vec([signerFor(passkey)]), sc.vec([])],
});

account.invoke('add_signer', [newSigner], {
  signAuth: smartAccountSecp256r1(passkey),
});
```

`signAuth` takes any `(payload: Buffer) => xdr.ScVal`, so a different contract's
proof format is a different builder. The shipped ones
(`smartAccountEd25519`, `smartAccountSecp256r1`, `smartAccountMultiEd25519`,
`smartAccountMixed`) target the Crossmint smart-account shape.

## Deploying through a factory

Production rarely deploys an account directly — a factory does it, so the
address is deterministic and the backend can compute it before the account
exists. That whole flow runs here:

```ts
const factory = svm.deployContract(FACTORY_WASM);
const wasmHash = svm.addContract(SMART_ACCOUNT_WASM);   // code into the ledger

const args = sc.map([                                    // ContractDeploymentArgs
  { key: sc.sym('constructor_args'), val: sc.vec([sc.vec([adminSigner]), sc.vec([])]) },
  { key: sc.sym('salt'),             val: sc.bytes(salt) },
  { key: sc.sym('wasm_hash'),        val: sc.bytes(Buffer.from(wasmHash, 'base64')) },
]);

// Know the address before it exists...
const predicted = factory.view('get_deployed_address', [
  sc.bytes(salt), sc.bytes(Buffer.from(wasmHash, 'base64')), ctorArgs,
]);

// ...then deploy to it.
const deployed = factory.invoke('deploy', [args]);
expect(deployed.toString()).toBe(predicted.toString());

const account = svm.contractAt(deployed.toString());
```

Also covered by `test/factory.test.ts`: `deploy_idempotent` (a redeploy returns
the existing address instead of failing), `upload_and_deploy` (wasm upload and
deployment in one call), `deploy_and_call` (deploy then invoke in a single
transaction), the `DEPLOYED` event, and a factory-deployed account authorizing
with its passkey end to end.

A soroban `#[contracttype]` struct is an `ScMap` keyed by field name, and **ScMap
keys must be sorted** — the host rejects an unsorted map with
`Error(Object, InvalidInput)`. `constructor_args < salt < wasm_hash` already is.

### Rebuilding the contract fixtures

```bash
./scripts/build-fixtures.sh ~/src/stellar-smart-account
```

Contracts build to `wasm32v1-none`; do not copy the repo's checked-in
`testdata/` wasm, which is an older build with a different signer shape.

## Test isolation

Each `new LiteStellar()` is a completely independent ledger and costs about
3 µs, so the simplest isolation is a fresh one per test:

```ts
beforeEach(() => { svm = new LiteStellar(); });
```

When setup is expensive enough to share, roll back instead:

```ts
svm.sandboxed(() => {
  c.invoke('put_persistent', [sc.sym('tmp'), sc.u64(1n)]);
});                                    // rolled back, even if the body throws

const snap = svm.snapshot();
// ...
svm.restore(snap);
```

`stateHash()` proves a rollback was exact across the whole ledger — not just the
keys the test happened to check:

```ts
const before = svm.stateHash();
svm.sandboxed(() => c.invoke('put_persistent', [sc.sym('x'), sc.u64(1n)]));
expect(svm.stateHash()).toBe(before);
```

## Time travel

```ts
svm.advanceLedgers(100);
svm.warpToLedger(2_000_000);      // forward only
svm.setTimestamp(1_800_000_000);

svm.ledgerSequence;
svm.timestamp;
```

Ledger sequence and timestamp are part of a snapshot, so `restore()` rolls the
clock back too.

## Asserting on failures

`invoke` throws a `HostFailure` with the error parsed out, not a string to grep:

```ts
try {
  c.invoke('get_persistent', [sc.sym('missing')]);
} catch (e) {
  const f = e as HostFailure;
  f.errorType;      // 'Storage' | 'Auth' | 'Budget' | 'WasmVm' | 'Contract' | ...
  f.errorCode;      // 'ExceededLimit' | 'InvalidAction' | ...
  f.contractCode;   // 13, for Error(Contract, #13)
  f.is('Auth', 'InvalidAction');
  f.raw;            // full host output with diagnostics
}
```

`tryInvoke` returns the same information without throwing, plus the host's
diagnostic events — which the host produces on failure too:

```ts
const r = c.tryInvoke('get_persistent', [sc.sym('nope')]);
r.ok;             // false
r.error;          // HostFailure
r.diagnostics;    // xdr.DiagnosticEvent[] — fn_call, fn_return, error
r.events;         // xdr.ContractEvent[]
```

## Asserting on resources

**Opt in first**, or the numbers do not transfer to any real network:

```ts
const svm = new LiteStellar().withNetworkCostParams();
svm.metersLikeNetwork;     // true

const r = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)]);
r.instructions;            // within ~1% of a real node
r.readBytes;
r.writeBytes;
r.footprint.readOnly;      // base64 LedgerKey[]
r.footprint.readWrite;
```

To match a specific network exactly, read its live table:

```ts
svm.withNetworkCostParams(await loadCostParamsFromRpc(mainnetServer));
```

## Testing your app unchanged

`svm.rpcServer()` returns a real `rpc.Server` whose JSON-RPC is served in
process. Your app's submit-and-poll loop runs for real, with no socket:

```ts
const server  = svm.rpcServer();
const account = await server.getAccount(alice.publicKey);

const tx = new TransactionBuilder(account, {
  fee: '1000', networkPassphrase: svm.networkPassphrase,
}).addOperation(Operation.invokeHostFunction({ func, auth: [] }))
  .setTimeout(300).build();

const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
assembled.sign(alice.keypair);

const sent = await server.sendTransaction(assembled);   // PENDING
const got  = await server.pollTransaction(sent.hash);   // SUCCESS
```

All 18 `rpc.Server` methods work, including `getEvents` (fed from what
`sendTransaction` applied), `getLedgers`, `getTransactions`, `getFeeStats`,
`getVersionInfo` and `requestAirdrop` — which funds through an in-process
friendbot, no socket involved. `test/rpc-compat.test.ts` calls every one of them
and checks the SDK-parsed result, so a regression is named rather than vague.

`contract.Client` works the same way — pass `server` in `ClientOptions`; the
constructor, `Client.from` and `Client.fromWasmHash` all honour it.
`Client.deploy` is the one exception: it builds its own `RpcServer` at
`client.js:36-38` and reaches the network. There is a test pinning that, so if
upstream fixes the leak we find out.

When a test is not about envelopes, turn the classic rules off:

```ts
new LiteStellar()
  .withSigverify(false)      // don't verify envelope signatures
  .withSequenceCheck(false)  // don't enforce seqNum + 1
  .withFeeCharging(false)
  .withTimebounds(false)
  .withoutClassicChecks();   // all of the above
```

## Dropping to the low level

`svm.ledger` is the raw environment, for tests that are about the plumbing —
footprints, the enforcing path, the XDR itself:

```ts
const sim  = svm.ledger.simulate(hostFn, alice.accountIdB64);
const sent = svm.ledger.send(hostFn, alice.accountIdB64,
  sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);

svm.ledger.simulateWithAuth(hostFn, source, signedAuthEntries);
svm.setEntry(ledgerEntryXdr);          // write any entry directly
svm.getEntry(ledgerKeyXdr);
svm.allKeys();
```

## Gotchas

**An unsigned transaction is rejected even when the medium threshold is 0.**
Threshold 0 means "any one valid signer suffices", not "no signature required".

**`balanceOf` throws for an account with no trustline.** That is real Stellar
behaviour, not a harness quirk. Use `balanceOrZero` or call `trust()` first.

**Simulation does not run `__check_auth`.** A custom-account call can simulate
green and fail on submit. That gap is real, and reproducing it is one of the
reasons this harness exists — use `signAuth`.

**Contract ids derive from (deployer, salt).** Deploying the same wasm twice from
the same account with the same explicit salt collides. The default salt
increments; pass `salt` only if you want a specific address.

**Resource numbers are uncalibrated by default.** See
[Asserting on resources](#asserting-on-resources).

**The protocol pin is loud on purpose.** `new LiteStellar({ protocolVersion: 28 })`
throws while the host is pinned to 27, rather than silently simulating the wrong
protocol.

## What this does not do

Classic operations (Payment, CreateAccount, ChangeTrust), fee refunds,
`ExtendFootprintTTL` / `RestoreFootprint` dispatch, and five RPC methods. See
"Known gaps" in [README.md](README.md).
