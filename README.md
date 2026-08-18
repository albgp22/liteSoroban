# liteSoroban

An in-process Stellar ledger for TypeScript tests — the real `soroban-env-host`
compiled to WebAssembly, running inside Node. No Docker, no RPC node, no network.

Shaped after [LiteSVM](https://github.com/LiteSVM/litesvm), and for the same
reasons: one object you construct, a fluent config with switches that turn off
the realism you are not testing, direct state manipulation as a first-class
citizen, and a synchronous API.

```bash
npm install
npm run build:wasm     # needs: rustup target add wasm32-unknown-unknown; cargo install wasm-pack
npm test               # 144 tests, ~800 ms
npm run test:validation # adversarial batteries — partly RED on purpose, see "Known gaps"
```

**[GUIDE.md](GUIDE.md) is the usage guide** — every snippet in it is executed by
`test/guide.test.ts`, so it cannot rot.

```ts
const svm   = new LiteStellar();
const alice = svm.airdrop();
const usdc  = svm.deployToken({ code: 'USDC' });
usdc.mint(alice, 1_000n);

const c = svm.deployContract(wasm, { as: alice });
expect(c.invoke('add', [sc.i32(2), sc.i32(3)])).toBe(5);
```

Setting up a funded wallet, a deployed token and a minted balance costs **0.8 ms**,
so `beforeEach` can build a whole world per test. A `stellar/quickstart` container
needs ~14 s to boot and ~1 s per state-changing transaction, with no per-test
rollback at any price.

## Read this before trusting a number

This harness is a **faithful emulator of the host it pins**, and **not** a
faithful emulator of a Stellar network. Those are different claims, and an
earlier version of this file conflated them.

- Its metering is byte-identical to `soroban-env-host` 27.0.1's own e2e
  expectations (nine exact `expect![]` values reproduced, including the
  1,767,593-instruction ADD_I32 upload preflight at `e2e_tests.rs:894`).
  **True.** (Beware when cross-checking against another host version: the same
  test asserts 1,528,075 at `:883` in 28.0.1 — the calibration moved.)
- Its instruction counts agree with mainnet **only if you ask for it**:

```ts
const svm = new LiteStellar().withNetworkCostParams();
```

`soroban-env-host`'s `Budget::default()` is byte-for-byte stellar-core's
`initialCpuCostParamsEntryForV20` — the calibration a network carries only until
its first settings upgrade. 18 of 86 CPU cost entries differ from a live
network's, dominated by `ValDeser` `const_term` **59,052** vs **331**. Measured
differentially against a live node (stellar-rpc 27.1.1, captive-core 27.1.0,
protocol 27), in-process raw vs the node's implied raw:

| scenario | real node | default | `withNetworkCostParams()` |
|---|---:|---:|---:|
| upload add_i32 | 1,547,805 | +14.1% | **+1.4%** |
| `add(2,3)` | 304,084 | +134.1% | **+0.3%** |
| `put_persistent` | 550,088 | +72.5% | **+0.1%** |
| `get_persistent` | 550,166 | +93.8% | **+0.1%** |

`withNetworkCostParams()` ships a protocol-27 table captured from a real node's
`ConfigSetting` entries. To match a specific network exactly — mainnet at a
specific moment, say — read its live table instead:

```ts
svm.withNetworkCostParams(await loadCostParamsFromRpc(mainnetServer));
```

**Left on by default? No.** The default stays uncalibrated so that a harness
that has not opted in cannot quietly produce numbers someone trusts. `metersLikeNetwork`
tells you which mode you are in.

The residual ~1.4% on upload is not calibration: it is the `AccountEntry`
extension chain and the missing module cache, both under "Known gaps".

What *is* byte-identical to the real node on all six scenarios: footprints
(read-only and read-write key sets), return `ScVal`s, contract events, and
recorded auth entries. Disk/write bytes match on five of six.

## What it is good for

- **Contract behaviour** — does my contract do the right thing, with real
  storage, real TTL arithmetic, real cross-contract calls.
- **Authorization** — the host runs a custom account's `__check_auth` for real,
  including ed25519 and secp256r1/passkey proofs, nonce replay and expiry.
- **Footprints** — recorded *and* enforced; stripping a footprint fails.
- **Error codes** — nine `HostError` variants reachable and distinguishable.
- **Isolation** — a fresh environment costs 3 µs; `snapshot()`/`restore()` is free.

## What it is not good for

- Resource, fee or budget assertions (see above).
- State archival on the apply path, until the module cache lands.
- Anything needing classic operations (Payment, CreateAccount, ChangeTrust).

## Architecture

| Layer | Where | What it does |
|---|---|---|
| Soroban host | Rust → wasm (`crates/host-wasm`) | Execution, storage, TTL, budget, footprint, `__check_auth`, SAC |
| Classic | TS (`src/classic.ts`) | Envelopes, sequence numbers, timebounds, signature weights, fees, fee bumps |
| Auth | TS (`src/auth.ts`) | Signing authorization entries for custom accounts |
| RPC facade | TS (`src/fake-rpc.ts`) | JSON-RPC over `httpClient.defaults.adapter` |
| Facade | TS (`src/litestellar.ts`) | The LiteSVM-shaped API above |

Both SDK entry points work unchanged: `rpc.Server` (simulate →
`assembleTransaction` → `sendTransaction` → `pollTransaction`) and
`contract.Client` (including `signAndSend`).

### Escape hatches

```ts
new LiteStellar()
  .withSigverify(false)      // don't verify envelope signatures
  .withSequenceCheck(false)  // don't enforce seqNum + 1
  .withFeeCharging(false)    // don't debit fees
  .withTimebounds(false)     // don't enforce timebounds
  .withoutClassicChecks();   // all of the above
```

### Custom accounts: the four-step round trip

Authorizing through a contract account is not simulate-then-send:

```
1. simulate                         -> recorded auth entries, __check_auth NOT run
2. sign those entries               -> a proof __check_auth accepts
3. simulate WITH the signed entries -> footprint covering __check_auth's reads
4. send
```

Skip 2 → `Error(Auth, InvalidAction)`. Skip 3 → `Error(Storage, ExceededLimit)`
and *"trying to access contract data key outside of the footprint"*, because the
first simulation never entered `__check_auth`. `contract.invoke(fn, args,
{ signAuth })` does all four.

Two host settings must be right or every custom-account authorization fails for
reasons that look nothing like the cause: `network_id` must equal
`sha256(networkPassphrase)` (the host's own `DEFAULT_NETWORK_ID` is `[5u8; 32]`,
which matches no real passphrase), and the base PRNG seed must vary between
simulations or the second one reuses the first's nonce and dies with
`Error(Auth, ExistingValue)`.

## Known gaps

Found by nine adversarial test batteries plus a differential run against a live
node; the red tests in `test/validation/` pin them.

**Blocking real-network fidelity**
- Cost calibration defaults to protocol-20 (above). Fix: `setCostParams`.
- `module_cache: None` in the enforcing path charges the full `VmInstantiation`
  Wasm parse (const_term 451,626) where recording mode charges
  `VmCachedInstantiation` (41,142) to the shadow budget. The two halves disagree
  by 25-59%, which is why `enforceDeclaredResources` is **off by default** —
  enforcing the declared limit makes every deploy fail.

**Classic layer**
- `txBAD_AUTH_EXTRA` is not implemented; unconsumed signatures are not rejected.
- The LOW threshold is not applied at transaction level.
- Fee bumps: no minimum-inclusion-fee check, no actual-bump check.
- `ExtendFootprintTTL` and `RestoreFootprint` are validated but not dispatched —
  an honest `txFAILED`, never a silent success.
- `AccountEntry` is written with `ext = v0`; stellar-core normalises to the
  v1→v2→v3 chain, 52 bytes larger, which lands in `disk_read_bytes`.

**RPC facade** — all 18 `rpc.Server` methods respond and `test/rpc-compat.test.ts`
checks the SDK-parsed result of each. Still wrong, found by review round 2:
- The four validation switches do not reach the RPC submit path, so the same
  envelope can behave differently through `svm.sendTransaction` and `rpcServer()`.
- `requestAirdrop` on an EXISTING account rebuilds its `AccountEntry`, rewinding
  the sequence and dropping signers.
- `instructionLeeway` in `resourceConfig` is ignored.
- Diagnostics do not reach `getTransaction`; fee stats are synthetic.
- `Client.deploy` reaches the network (an SDK leak at `client.js:36-38`, not ours).

**Apply-path metering** is 58-121% high on ordinary invocations and +220% CPU on a
custom-account authorization, because the enforcing path has no module cache.
Only the PREFLIGHT numbers are calibrated. Do not assert on applied resources.

## Findings worth keeping

Things that cost time and are written down nowhere else.

**An unsigned transaction is rejected even when the medium threshold is 0.**
Tempting to conclude otherwise: a fresh account has `thresholds [1,0,0,0]`
(`CreateAccountOpFrame.cpp:72`) and `getNeededThreshold` (`OperationFrame.cpp:57`)
returns that 0 verbatim. But for an ed25519-only account, weight in
`SignatureChecker::checkSignature` accumulates only inside the loop over the
transaction's signatures, so an unsigned transaction falls through to
`return false` whatever the threshold. Threshold 0 means "any one valid signer
suffices". Core pins it in `TxEnvelopeTests.cpp SECTION("no signature")`.
(Careful with the general form of that statement: core's PRE_AUTH_TX loop runs
over SIGNERS and *can* return true with no signatures. This harness implements
ed25519 signers only — see "Known gaps".)

**stellar-core checks signatures TWICE, independently.**
`checkAllTransactionSignatures` checks the *transaction* source at
`THRESHOLD_LOW`; `OperationFrame::checkSignature` separately checks the
*operation* source at MEDIUM and fails with `opBAD_AUTH`. Implementing only the
second leaves the transaction source unauthenticated whenever the operation
names its own — accepting envelopes the network rejects. An earlier version of
this harness did exactly that.

**The operation source account is the Soroban invoker**, not the transaction
source — `InvokeHostFunctionOpFrame.cpp` passes `mOpFrame.getSourceID()`.

**P27 vs P28 signature break.** `invoke_host_function` takes **14** args in
`soroban-env-host` 27.0.1 (`encoded_ledger_entries` and `encoded_ttl_entries` as
two parallel equal-length iterators) and **13** in 28.0.1 (TTL folded in via
`TtlLedgerEntryMeta`). Recording mode is identical in both. stellar-rpc vendors
both and dispatches on `ledger_info.protocol_version`.

**`SorobanResources.read_bytes` is `disk_read_bytes` in P27.**

**Contracts build to `wasm32v1-none`; the host builds to
`wasm32-unknown-unknown`.** soroban-sdk 27 refuses the latter on Rust 1.82+
("reference-types, multi-value"). `stellar contract build` picks correctly. The
host crate is the opposite case — it is not a contract, it runs in Node.

**SDF's wasm-opt recipe is not sufficient for the host.** The recipe published
for `@stellar/stellar-xdr-json` is `["-O", "--enable-bulk-memory"]`; the host
emits nontrapping float→int conversions via wasmi, so you also need
`--enable-nontrapping-float-to-int`, `--enable-sign-ext`,
`--enable-mutable-globals`, `--enable-reference-types`. Do **not** add
`--enable-multivalue` — wasm-opt then rewrites the return ABI and the generated
glue breaks at runtime.

**Never name a wasm-bindgen parameter `wasm`.** The name is copied verbatim into
the generated JS, where it shadows the module-level binding holding the instance
exports. Symptom: `TypeError: wasm.__wbindgen_add_to_stack_pointer is not a
function`, thrown from a `finally` block.

**`getLedgerEntries` returns `LedgerEntryData`, not `LedgerEntry`** (SDK
`parsers.js:121`), and `simulateTransaction`'s `events` field is
**`DiagnosticEvent`**, not `ContractEvent` — a raw ContractEvent makes the SDK
die with "Bad union switch: 1".

**secp256r1 signatures are over the payload as a PREHASH**, and the host rejects
high-S signatures (`crypto/mod.rs:185`). WebCrypto cannot express prehash ECDSA,
hence `@noble/curves` with `{ prehash: false }` (which is low-S by default).
P-256 auth costs ~58% more than ed25519: 7,045,503 vs 4,457,165 instructions on
the same call.

**`contract.Client` honours `options.server`** in its constructor
(`client.js:45`), `from` (`:198`) and `fromWasmHash` (`:135`) — but
`Client.deploy` leaks, building `new RpcServer(rpcUrl)` at `client.js:36-38`.
There is a regression test pinning this.

**`'accountId' in someScAddress` is always true.** js-xdr unions expose an
accessor for every arm on the prototype, so it is not a type guard.

## Layout

```
crates/host-wasm/         Rust cdylib: host + ledger map, wasm-bindgen surface
pkg/                      wasm-pack output (generated, gitignored)
src/litestellar.ts        the LiteSVM-shaped facade — start here
src/index.ts              Ledger: the low-level primitives
src/classic.ts            envelopes, seqnums, signatures, fees, fee bumps
src/auth.ts               custom-account auth signing, P-256 signers
src/fixtures.ts           wallets, tokens, trustlines
src/fake-rpc.ts           rpc.Server adapter
src/cost-params.ts        network cost calibration
test/                     the green suite
test/guide.test.ts        executes every snippet in GUIDE.md
test/factory.test.ts      factory -> smart account -> passkey auth, end to end
test/rpc-compat.test.ts   all 18 rpc.Server methods + contract.Client
test/validation/          adversarial batteries, partly red by design
scripts/build-fixtures.sh rebuild the contract fixtures from source
test/bench*.mjs           measurements
```
