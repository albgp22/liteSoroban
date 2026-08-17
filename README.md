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
npm test               # 71 tests, ~550 ms
npm run test:validation # adversarial batteries — partly RED on purpose, see "Known gaps"
```

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
- Its instruction counts therefore agree with mainnet. **FALSE — retracted.**

Measured differentially against a live `stellar/quickstart` node (stellar-rpc
27.1.1, captive-core 27.1.0, protocol 27), raw in-process vs the node's implied
raw count, over-metering throughout:

| scenario | in-process | real node | delta |
|---|---:|---:|---:|
| upload add_i32 | 1,787,932 | 1,547,805 | +15.5% |
| deploy | 880,275 | 530,127 | +66.0% |
| `add(2,3)` | 712,883 | 304,084 | +134.4% |
| `put_persistent` | 949,599 | 550,088 | +72.6% |
| `get_persistent` | 1,066,743 | 550,166 | +93.9% |
| native SAC transfer | 647,395 | 185,750 | +248.7% |

Root cause, confirmed by reading `ConfigSettingContractCostParamsCpuInstructions`
off the running node: `Budget::default()` is byte-for-byte stellar-core's
`initialCpuCostParamsEntryForV20` — the calibration a network has *before* its
first settings upgrade. 18 of 86 CPU cost entries differ, dominated by `ValDeser`
`const_term` **59,052** (host default) vs **331** (network).

There is a fix and it is wired up: pass the network's real table to
`setCostParams(cpuParamsXdr, memParamsXdr, cpuLimit, memLimit)`, which builds the
budget with `Budget::try_from_configs` the way stellar-rpc's preflight does.
Read the params from any node's `ConfigSetting` ledger entries. Until you do
that, **do not assert on instructions, resources or fees.**

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

**RPC facade**
- `getEvents`, `getTransactions`, `getLedgers`, `getFeeStats` and
  `getVersionInfo` return `-32601`.
- `getTransaction` does not populate contract events in the meta.

## Findings worth keeping

Things that cost time and are written down nowhere else.

**An unsigned transaction is rejected even when the medium threshold is 0.**
Tempting to conclude otherwise: a fresh account has `thresholds [1,0,0,0]`
(`CreateAccountOpFrame.cpp:72`) and `getNeededThreshold` (`OperationFrame.cpp:57`)
returns that 0 verbatim. But in `SignatureChecker::checkSignature` every
`return true` sits **inside** the loop over the transaction's signatures, so an
unsigned transaction falls through to `return false` whatever the threshold.
Threshold 0 means "any one valid signer suffices". Core pins it in
`TxEnvelopeTests.cpp SECTION("no signature")`. An earlier version of this harness
asserted the opposite, in a test and in this file.

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
test/                     the green suite
test/validation/          adversarial batteries, partly red by design
test/bench*.mjs           measurements
```
