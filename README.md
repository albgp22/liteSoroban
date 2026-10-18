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
npm test               # 246 tests, ~800 ms
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

Setting up a funded wallet, a deployed token and a minted balance costs **~1 ms**,
so `beforeEach` can build a whole world per test. A `stellar/quickstart` container
needs ~14 s to boot and ~1 s per state-changing transaction, with no per-test
rollback at any price.

## Read this before trusting a number

This harness is a **faithful emulator of the host it pins**, and **not** a
faithful emulator of a Stellar network. Those are different claims, and an
earlier version of this file conflated them.

- Its metering is byte-identical to `soroban-env-host` 29.0.2's own e2e
  expectations (ten exact `expect![]` values reproduced, including the
  1,528,075-instruction ADD_I32 upload preflight at `e2e_tests.rs:883`).
  **True.** (Beware when cross-checking against another host version: the same
  test asserts 1,767,593 at `:894` in 27.0.1 — the calibration moved in 28.0.0.)
- Its instruction counts use the network's calibration **out of the box**.
  Up to 27.0.1, `soroban-env-host`'s `Budget::default()` was byte-for-byte
  stellar-core's `initialCpuCostParamsEntryForV20`, the calibration a network
  carries only until its first settings upgrade (`ValDeser` `const_term`
  **59,052** vs a live network's **331**). 28.0.0 replaced those defaults with
  the live calibration: on the pinned 29.0.2, all 86 CPU and 86 memory entries
  equal the protocol-27 table this repository captured from a real node's
  `ConfigSetting` entries.

`withNetworkCostParams()` installs that table explicitly, which on this host
changes no count, and sets `metersLikeNetwork`. It matters once a network's
table moves away from the host's defaults; to match a specific network exactly
— mainnet at a specific moment, say — read its live table:

```ts
svm.withNetworkCostParams(await loadCostParamsFromRpc(mainnetServer));
```

The differential numbers in this table were measured with host 27.0.1 against a
live protocol-27 node
(stellar-rpc 27.1.1, captive-core 27.1.0), in-process raw vs the node's implied
raw, with the protocol-27 table installed. They are kept as the record of the
27 to 29 drift; the node numbers pinned in `test/validation/` have since been
re-captured against a protocol-29 node (below):

| scenario | protocol-27 node | host 27.0.1 | host 29.0.2 |
|---|---:|---:|---:|
| upload add_i32 | 1,547,805 | +1.4% | −1.4% |
| `add(2,3)` | 304,084 | +0.3% | −9.4% |
| `put_persistent` | 550,088 | +0.1% | −24.8% |
| `get_persistent` | 550,166 | +0.1% | −24.6% |

The host 29.0.2 column is the same table against the same protocol-27 node, so
the drift is the host's own metering moving between versions, not calibration.
Against a protocol-29 node (stellar-rpc 29.0.1, stellar-core v29.0.0,
re-captured 2026-10-18) the recorded counts are exact, to the instruction, on
every scenario whose footprint is pure Soroban: an upload, a deploy, `add`,
`put_persistent`, `get_persistent`, a 10 KB write, a cross-contract call and a
custom account's `__check_auth` round trip. The `test/validation/` calibration
constants are pinned to that node. Footprints holding a classic `AccountEntry`
now simulate within 0.5% too (a native SAC transfer between two G-accounts:
159,818 against the node's 159,028, with disk and write bytes exact), since
simulation reads accounts promoted to ext v3 the way stellar-rpc's preflight
does, and `instructionLeeway` is exact. One residue: that transfer's APPLIED
memory through the low-level `Ledger.send` is ~7% under the node, because that
path never bumps the payer's sequence, which on a network promotes it to ext v3;
an envelope through `sendTransaction` does get the promotion.

What *was* byte-identical to the protocol-27 node on all six scenarios: footprints
(read-only and read-write key sets), return `ScVal`s, contract events, and
recorded auth entries. Disk/write bytes match on five of six.

## What it is good for

- **Contract behaviour** — does my contract do the right thing, with real
  storage, real TTL arithmetic under testnet's state-archival settings, real
  cross-contract calls.
- **Authorization** — the host runs a custom account's `__check_auth` for real,
  including ed25519 and secp256r1/passkey proofs, nonce replay and expiry.
- **Footprints** — recorded *and* enforced; stripping a footprint fails.
- **Error codes** — nine `HostError` variants reachable and distinguishable.
- **Isolation** — a fresh environment costs 3 µs; `snapshot()`/`restore()` is free.
- **Fees** — debited as stellar-core debits them: the declared resource fee plus
  the inclusion fee capped at the base fee, less the refund of whatever rent and
  events did not consume (all of it when the operation fails). `minResourceFee`
  is soroban-simulation's. Given a local protocol-29 node's fee settings, the
  debit, `feeCharged`, `minResourceFee` and meta fee split matched that node to
  the stroop for invocations (overbid or not), a fee bump, a failed call, and
  `ExtendFootprintTTL` with and short of rent (`test/fees.test.ts`). The rent of
  a NEW entry (writes, uploads, deploys) matches only where the minimum TTLs
  are the node's, which the host's are not yet (see "Known gaps"). The default
  fee settings are testnet's.

## What it is not good for

- Instruction or memory counts for anything beyond the scenarios measured above.
- Explicit `RestoreFootprint` / `ExtendFootprintTTL` operations, which are validated
  but not dispatched (see "Known gaps"). Auto-restore *inside* an invocation works,
  and the applied count matches the recorded one to within 1%.
- Anything needing classic operations (Payment, CreateAccount, ChangeTrust).

## Architecture

| Layer | Where | What it does |
|---|---|---|
| Soroban host | Rust → wasm (`crates/host-wasm`) | Execution, storage, TTL, budget, footprint, `__check_auth`, SAC |
| Classic | TS (`src/classic.ts`) | Envelopes, sequence numbers, preconditions, signature weights, fees, fee bumps |
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
  .withSequenceCheck(false)  // don't enforce seqNum + 1 (or minSeqNum's range)
  .withFeeCharging(false)    // don't charge fees or check the resource fee
  .withTimebounds(false)     // don't enforce time/ledger bounds, minSeqAge, minSeqLedgerGap
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

Skip 2 or 3 and the call runs out of the instructions the first simulation
declared, because that simulation never entered `__check_auth`. The declared count
is enforced by default, as on a network, so both mistakes surface as
`Error(Budget, ExceededLimit)`. With `ledger.enforceDeclaredResources(false)` you
get the host's own errors instead: skip 2 → `Error(Auth, InvalidAction)`, skip 3 →
`Error(Storage, ExceededLimit)` and *"trying to access contract data key outside
of the footprint"*. `contract.invoke(fn, args, { signAuth })` does all four.

Two host settings must be right or every custom-account authorization fails for
reasons that look nothing like the cause: `network_id` must equal
`sha256(networkPassphrase)` (the host's own `DEFAULT_NETWORK_ID` is `[5u8; 32]`,
which matches no real passphrase), and the base PRNG seed must vary between
simulations or the second one reuses the first's nonce and dies with
`Error(Auth, ExistingValue)`.

## Known gaps

Found by nine adversarial test batteries plus a differential run against a live
node; the red tests in `test/validation/` pin them.

**Blocking real-network fidelity** — nothing open. Two items used to be here and are
closed: cost calibration defaulting to protocol-20 (the host has shipped the live
table since 28.0.0, see above) and the enforcing path's missing module cache (see
"Apply-path metering").

**Classic layer** — signatures (every signer type, consumption, `txBAD_AUTH_EXTRA`,
operation thresholds, `extraSigners`), PRECOND_V2 preconditions (time and ledger
bounds, `minSeqNum`, `minSeqAge`, `minSeqLedgerGap`, `extraSigners` validity, in
core's check order), fee-bump fee rules, fees as core charges them (inclusion
fee capped at the base fee, refund of the unused refundable fee, rent, and the
resource-fee and `*_INSUFFICIENT_REFUNDABLE_FEE` checks), the `AccountEntry`
extension chain (promoted on a sequence bump; seen promoted by simulation, as
stellar-rpc's preflight does), and `ExtendFootprintTTL` / `RestoreFootprint`
(validated, applied and simulated) follow stellar-core and soroban-simulation and
were checked scenario by scenario against a local protocol-29 node
(`test/classic-validation.test.ts`, `test/preconditions.test.ts`,
`test/footprint-ops.test.ts`, `test/fees.test.ts`). Still missing:
- `maxTime` is checked against the harness clock as it stands. A node checks it
  against the last close time plus twice its expected ledger close time plus the
  time since that close (`getUpperBoundCloseTimeOffset`), so an envelope a few
  seconds from expiry is txTOO_LATE there and accepted here: on the local node
  `maxTime = close time + 1` was txTOO_LATE, `+ 30` was accepted. Same for
  PRECOND_TIME.
- Fees use ONE network's fee settings: testnet's as read on 2026-10-18 by
  default, whose rent rate moves with testnet's state size. Charge another
  network's with `withFeeSettings(await loadFeeSettingsFromRpc(server))`. There
  is no surge pricing: the inclusion fee is always charged at the 100-stroop
  base fee.
- Not checked against the network's limits, apart from the events size: the
  per-transaction resource caps (core's `checkSorobanResources`, refused at
  submission) and entry sizes or a restore's read/write bytes
  (`RESOURCE_LIMIT_EXCEEDED` at apply).
- Simulating an extend over an expired persistent entry is an error here;
  stellar-rpc answers with a restore preamble instead. Both mean "restore first".

**RPC facade** — all 18 `rpc.Server` methods respond and `test/rpc-compat.test.ts`
checks the SDK-parsed result of each. Ledger numbers are a node's: every
`latestLedger` is the last closed ledger (`svm.ledgerSequence - 1`), simulation
runs in it as stellar-rpc's preflight does, and a submission is validated against
and applied in the next one, so `getTransaction().ledger` is `latest + 1`. Checked
against a local protocol-29 node (`test/rpc-ledger-numbers.test.ts`). Still wrong,
found by review round 2:
- Diagnostics do not reach `getTransaction`; fee stats are synthetic.
- The harness has one clock. The latest ledger's close time is the timestamp the
  next transaction is validated and applied at, so once a transaction applies,
  `getLatestLedger` names its ledger with a close time 5 s after its `createdAt`.
  On a node the two are the same.
- `Client.deploy` reaches the network (an SDK leak at `client.js:36-38`, not ours).

`getLedgerEntries` also serves no `ConfigSetting` entries, so neither the
state-archival settings nor the cost tables can be read back through
`svm.rpcServer()`. The harness itself runs testnet's state-archival settings
(720 / 120,960 / 3,110,400); `loadArchivalSettingsFromRpc` reads a real node's.

**Apply-path metering** matches the node. The enforcing path used to pass
`module_cache: None`, so every applied invocation re-parsed its Wasm at the full
`VmInstantiation` price (const_term 451,626) where recording mode charges the
cached price (`VmCachedInstantiation`, 41,142 plus a per-byte term) to its shadow
budget. `send` now hands the host a module cache built from the ContractCode in
the transaction's footprint, the way stellar-core does, and drops from it any
code the transaction restores (a node cannot have cached an archived entry, so
that parse is billed in full). Applied CPU against the `core_metrics` events of a
live protocol-29 node (stellar-core 29.0.0, stellar-rpc 29.0.1, measured
2026-10-18 with that node's own cost table installed):

| scenario | node | before | now |
|---|---:|---:|---:|
| deploy add_i32 | 493,979 | 862,811 (+74.7%) | 494,190 (+0.04%) |
| deploy contract_data | 737,801 | 2,126,648 (+188.2%) | 738,012 (+0.03%) |
| deploy invoke_contract | 330,409 | 847,553 (+156.5%) | 330,620 (+0.06%) |
| `add(2,3)` | 276,240 | 472,671 (+71.1%) | 276,240 (0.0%) |
| `put_persistent` | 411,280 | 1,172,909 (+185.2%) | 411,585 (+0.07%) |
| `get_persistent` | 412,868 | 1,174,192 (+184.4%) | 412,868 (0.0%) |
| cross-contract call | 619,017 | 1,562,424 (+152.4%) | 619,017 (0.0%) |

Applied memory (`mem_byte`) is now exact on all seven (it was 2.9-9.9% high), and
the recorded counts equal the node's implied raw counts exactly. A custom
account's `__check_auth` was +219.6% CPU and +53.1% memory; against the
protocol-29 node the same change brings it to +0.06-0.08% and +0.0%. Uploads of
bytes the node had already stored differ by 1-3% in both directions; that is the
existing-code artifact described in `test/validation/differential.test.ts`, not
the cache.

That also made it safe to enforce the instruction count a transaction declares,
which is now **on by default** (`ledger.enforceDeclaredResources(false)` turns it
off): every deploy and invocation above fits its declared count with 3.8-27% to
spare, and the floor of that margin is stellar-rpc's own 4% padding. It used to be
off because enforcing it failed every deploy with `Error(Budget, ExceededLimit)`.

What is still not modelled: a node builds its cache at ledger close, so a contract
uploaded and invoked within the SAME ledger pays the full parse there (the host's
own comments say so; not measured here), while this harness, which has no ledger
close, always finds the code cached.

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
both and dispatches on `ledger_info.protocol_version`. 29.0.2 keeps the 28.x
signatures, and the harness targets that shape: one iterator item per footprint
key, absent keys included as `(None, None)` — skip one and every later entry
lands on the wrong key (`PROTOCOL PINNING` in `crates/host-wasm/src/lib.rs`).

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
src/state-archival.ts     network state-archival TTLs
src/fee-settings.ts       network fee settings (testnet's by default)
test/                     the green suite
test/guide.test.ts        executes every snippet in GUIDE.md
test/factory.test.ts      factory -> smart account -> passkey auth, end to end
test/rpc-compat.test.ts   all 18 rpc.Server methods + contract.Client
test/validation/          adversarial batteries, partly red by design
scripts/build-fixtures.sh rebuild the contract fixtures from source
test/bench*.mjs           measurements
```
