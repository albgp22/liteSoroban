/**
 * Contract events, and cross-contract invocation.
 *
 * Expected values are derived from the pinned host, NOT from what this harness
 * returns:
 *
 *   soroban-env-host-27.0.1/src/e2e_invoke.rs:940  `encode_contract_events` —
 *       events with `failed_call` or type `Diagnostic` are filtered out.
 *   soroban-env-host-27.0.1/src/e2e_invoke.rs:513-519 (enforcing) and :884-916
 *       (recording) — on a failed invocation both modes return `vec![]`.
 *   soroban-env-host-27.0.1/src/test/e2e_tests.rs:649 —
 *       `assert_eq!(recording_result.contract_events, enforcing_result.contract_events)`.
 *   soroban-env-host-27.0.1/src/test/e2e_tests.rs:801 / :1235 — upload and
 *       create-contract emit no contract events.
 *   soroban-env-host-27.0.1/src/builtin_contracts/stellar_asset_contract/event.rs —
 *       exact SAC topic/data shapes, and `transfer_maybe_with_issuer` routing.
 *   soroban-env-host-27.0.1/src/builtin_contracts/stellar_asset_contract/metadata.rs —
 *       `read_name` renders "<code>:<issuer strkey>" (SEP-11) for alphanum4.
 *   soroban-env-host-27.0.1/src/test/e2e_tests.rs:3278
 *       `test_deployer_operations_using_simulation` — replayed below.
 *
 * Contract sources (rs-soroban-env/soroban-test-wasms/wasm-workspace):
 *   invoke_contract/src/lib.rs   add / add_with / add_with_try
 *   auth/src/lib.rs              tree_fn
 *   contract_sac_transfer/src/lib.rs
 *   deployer/src/lib.rs, create_contract/src/lib.rs
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Asset,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  hash as sha256,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn, uploadWasmHostFn } from '../../src/index.js';
import { attachInProcessRpc } from '../../src/fake-rpc.js';
import { preFundedWallet, deployToken, type Wallet } from '../../src/fixtures.js';

// ---------------------------------------------------------------------------
// fixtures + helpers
// ---------------------------------------------------------------------------

const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

/** soroban-test-wasms INVOKE_CONTRACT: `add`, `add_with`, `add_with_try`. */
const INVOKE_CONTRACT = fixture('invoke_contract.wasm');
/** soroban-test-wasms AUTH_TEST_CONTRACT: `tree_fn`. */
const AUTH_TEST = fixture('auth_test_contract.wasm');
/** soroban-test-wasms CONTRACT_SAC_TRANSFER_CONTRACT_P23. */
const SAC_TRANSFER = fixture('contract_sac_transfer.wasm');
/** soroban-test-wasms DEPLOYER_TEST_CONTRACT. */
const TEST_DEPLOYER = fixture('test_deployer.wasm');
/** soroban-test-wasms UPDATEABLE_CONTRACT. */
const UPDATEABLE = fixture('updateable_contract.wasm');
/** soroban-test-wasms ADD_I32. */
const ADD_I32 = fixture('add_i32_p20.wasm');
/** soroban-test-wasms CREATE_CONTRACT. */
const CREATE_CONTRACT = fixture('create_contract.wasm');

const I32_MAX = 2147483647;

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const addr = (a: xdr.ScAddress) => xdr.ScVal.scvAddress(a);

const saltOf = (n: number) => {
  const s = Buffer.alloc(32);
  s[0] = n;
  return s;
};

function deploy(L: Ledger, source: string, wasm: Uint8Array, salt: number): xdr.ScAddress {
  const wasmHash = L.seedWasm(wasm);
  const { sent } = L.simulateAndSend(createContractHostFn(source, wasmHash, saltOf(salt)), source);
  expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
}

/** The persistent instance entry every deployed contract owns. */
const instanceKey = (a: xdr.ScAddress) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: a,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');

/** The ContractCode entry for a wasm blob, keyed by sha256 of the bytes. */
const codeKey = (wasm: Uint8Array) =>
  xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: sha256(Buffer.from(wasm)) }),
  ).toXDR('base64');

/**
 * The contract id a `deployer().with_current_contract(salt)` call produces:
 * sha256(HashIDPreimage::ContractID{ networkID, FromAddress{ address, salt } }).
 */
function derivedContractAddress(
  L: Ledger,
  deployer: xdr.ScAddress,
  salt: Buffer,
): xdr.ScAddress {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: sha256(L.networkPassphrase),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: deployer, salt }),
      ),
    }),
  );
  return xdr.ScAddress.scAddressTypeContract(sha256(preimage.toXDR()));
}

/**
 * Mint to any address, returning the raw send result so the events are visible.
 *
 * `deployToken().mint()` cannot be used for a CONTRACT recipient — see the
 * regression test in "harness gaps" below.
 */
function mintTo(
  L: Ledger,
  token: { address: xdr.ScAddress },
  issuer: Wallet,
  to: xdr.ScAddress,
  amount: bigint,
) {
  const hf = invokeHostFn(token.address, 'mint', [addr(to), i128(amount)]);
  const { sent } = L.simulateAndSend(hf, issuer.accountIdB64);
  expect(sent.ok, `mint failed: ${sent.error}`).toBe(true);
  return sent;
}

interface DecodedEvent {
  type: string;
  contract: string | null;
  topics: any[];
  data: any;
}

function decodeEvent(b64: string): DecodedEvent {
  const ev = xdr.ContractEvent.fromXDR(b64, 'base64');
  const body = ev.body().v0();
  return {
    type: ev.type().name,
    contract: ev.contractId() ? StrKey.encodeContract(ev.contractId()!) : null,
    topics: body.topics().map((t) => scValToNative(t)),
    data: scValToNative(body.data()),
  };
}

const cid = (a: xdr.ScAddress) => StrKey.encodeContract(a.contractId());

/** contracttype struct -> ScMap keyed by symbols, sorted as the host demands. */
function structVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })),
  );
}

interface Tree {
  contract: xdr.ScAddress;
  needAuth: boolean[];
  children: Tree[];
  tryCall?: boolean;
}
/** auth/src/lib.rs TreeNode { contract, need_auth, children, try_call }. */
const treeVal = (t: Tree): xdr.ScVal =>
  structVal({
    contract: addr(t.contract),
    need_auth: xdr.ScVal.scvVec(t.needAuth.map((b) => xdr.ScVal.scvBool(b))),
    children: xdr.ScVal.scvVec(t.children.map(treeVal)),
    try_call: xdr.ScVal.scvBool(t.tryCall ?? false),
  });

/** Flatten a recorded auth tree to `[contract, fnName]` pairs, depth-first. */
function authTree(inv: xdr.SorobanAuthorizedInvocation): any {
  const f = inv.function();
  const label =
    f.switch().name === 'sorobanAuthorizedFunctionTypeContractFn'
      ? [StrKey.encodeContract(f.contractFn().contractAddress().contractId()),
         f.contractFn().functionName().toString()]
      : [f.switch().name];
  return { call: label, subs: inv.subInvocations().map(authTree) };
}

// ===========================================================================
// EVENTS
// ===========================================================================

describe('contract events', () => {
  let L: Ledger;
  let source: string;
  let A: xdr.ScAddress;
  let B: xdr.ScAddress;

  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
    // Two independent instances of the same wasm: a real caller and callee.
    A = deploy(L, source, INVOKE_CONTRACT, 1);
    B = deploy(L, source, INVOKE_CONTRACT, 2);
  });

  it('returns the events an invocation emitted, decodable as ContractEvent', () => {
    const hf = invokeHostFn(A, 'add_with', [i32(3), i32(4), addr(B)]);
    const { sim, sent } = L.simulateAndSend(hf, source);
    expect(sent.ok, sent.error).toBe(true);

    // invoke_contract/src/lib.rs: `add_with` publishes ("add_with",)/(x,y,id),
    // then invokes `add`, which publishes ("add",)/(a,b).
    expect(sim.eventsXdr).toHaveLength(2);
    expect(sent.eventsXdr).toHaveLength(2);

    const [e0, e1] = sent.eventsXdr.map(decodeEvent);

    expect(e0.type).toBe('contract');
    expect(e0.contract).toBe(cid(A));
    expect(e0.topics).toEqual(['add_with']);
    expect(e0.data).toEqual([3, 4, cid(B)]);

    expect(e1.type).toBe('contract');
    expect(e1.contract).toBe(cid(B));
    expect(e1.topics).toEqual(['add']);
    expect(e1.data).toEqual([3, 4]);
  });

  it('orders events by emission: the caller emits before the callee it invokes', () => {
    const { sent } = L.simulateAndSend(
      invokeHostFn(A, 'add_with', [i32(10), i32(20), addr(B)]),
      source,
    );
    expect(sent.eventsXdr.map(decodeEvent).map((e) => [e.contract, e.topics[0]])).toEqual([
      [cid(A), 'add_with'],
      [cid(B), 'add'],
    ]);
    expect(scValToNative(xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64'))).toBe(30);
  });

  it('simulate() and send() agree on the events, byte for byte', () => {
    // e2e_tests.rs:649 asserts recording_result.contract_events ==
    // enforcing_result.contract_events. Same invariant, same encoding.
    const hf = invokeHostFn(A, 'add_with', [i32(7), i32(8), addr(B)]);
    const { sim, sent } = L.simulateAndSend(hf, source);
    expect(sent.ok, sent.error).toBe(true);
    expect(sent.eventsXdr).toEqual(sim.eventsXdr);
  });

  it('a FAILED invocation returns no events, in both simulate() and send()', () => {
    // i32 overflow inside the callee traps. e2e_invoke.rs returns vec![] for
    // contract events whenever the invocation result is an error — in the
    // recording path (:915) and the enforcing path (:518).
    const bad = invokeHostFn(A, 'add_with', [i32(I32_MAX), i32(1), addr(B)]);

    const sim = L.simulate(bad, source);
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/Error\(WasmVm, InvalidAction\)/);
    expect(sim.eventsXdr).toEqual([]);

    // The failing call still needs a footprint to be applied at all; borrow one
    // from an identically shaped call that succeeds.
    const good = L.simulate(invokeHostFn(A, 'add_with', [i32(1), i32(2), addr(B)]), source);
    const sent = L.send(bad, source, good.resourcesXdr, [], []);
    expect(sent.ok).toBe(false);
    expect(sent.eventsXdr).toEqual([]);
  });

  it('drops events emitted inside a failed sub-call, keeps the caller\'s', () => {
    // `add_with_try` publishes, then try-invokes `add`, which publishes and
    // then overflows. encode_contract_events (e2e_invoke.rs:940) filters
    // `e.failed_call`, so the callee's event must not survive.
    const hf = invokeHostFn(A, 'add_with_try', [i32(I32_MAX), i32(1), addr(B)]);
    const { sim, sent } = L.simulateAndSend(hf, source);
    expect(sent.ok, sent.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64'))).toBe(0);

    expect(sent.eventsXdr).toHaveLength(1);
    const e = decodeEvent(sent.eventsXdr[0]);
    expect(e.contract).toBe(cid(A));
    expect(e.topics).toEqual(['add_with']);
    expect(sim.eventsXdr).toEqual(sent.eventsXdr);
  });

  it('upload and create-contract emit no contract events', () => {
    // e2e_tests.rs:801 (test_wasm_upload_success) and :1235
    // (test_create_contract_success) both assert contract_events.is_empty().
    const up = uploadWasmHostFn(ADD_I32);
    const upSim = L.simulate(up, source);
    expect(upSim.ok, upSim.error).toBe(true);
    expect(upSim.eventsXdr).toEqual([]);
    const upSent = L.send(up, source, upSim.resourcesXdr, upSim.authXdr, upSim.restoredRwEntryIndices);
    expect(upSent.ok, upSent.error).toBe(true);
    expect(upSent.eventsXdr).toEqual([]);

    const wasmHash = L.seedWasm(ADD_I32);
    const cc = L.simulateAndSend(createContractHostFn(source, wasmHash, saltOf(9)), source);
    expect(cc.sent.ok, cc.sent.error).toBe(true);
    expect(cc.sim.eventsXdr).toEqual([]);
    expect(cc.sent.eventsXdr).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SAC events
// ---------------------------------------------------------------------------

describe('Stellar Asset Contract events', () => {
  let L: Ledger;
  let issuer: Wallet;
  let token: ReturnType<typeof deployToken>;
  /** metadata.rs `read_name` for an alphanum4 asset: "<code>:<issuer strkey>". */
  let assetName: string;

  beforeEach(() => {
    L = new Ledger();
    issuer = preFundedWallet(L);
    token = deployToken(L, { code: 'TEST', issuer });
    assetName = `TEST:${issuer.publicKey}`;
  });

  it('mint emits ["mint", to, name] with the amount as i128 data', () => {
    // event.rs `mint`: topics = [Symbol("mint"), to, read_name()],
    // data = amount (no muxed id -> a bare i128, not a map).
    const holder = preFundedWallet(L);
    token.trust(holder);

    const hf = invokeHostFn(token.address, 'mint', [addr(holder.address), i128(500n)]);
    const { sim, sent } = L.simulateAndSend(hf, issuer.accountIdB64);
    expect(sent.ok, sent.error).toBe(true);

    expect(sent.eventsXdr).toHaveLength(1);
    const e = decodeEvent(sent.eventsXdr[0]);
    expect(e.type).toBe('contract');
    expect(e.contract).toBe(token.contractId);
    expect(e.topics).toEqual(['mint', holder.publicKey, assetName]);
    expect(e.data).toBe(500n);

    expect(sim.eventsXdr).toEqual(sent.eventsXdr);
    expect(token.balanceOf(holder)).toBe(500n);
  });

  it('transfer between two holders emits ["transfer", from, to, name]', () => {
    const a = preFundedWallet(L);
    const b = preFundedWallet(L);
    token.trust(a);
    token.trust(b);
    token.mint(a, 1_000n);

    const hf = invokeHostFn(token.address, 'transfer', [
      addr(a.address), addr(b.address), i128(250n),
    ]);
    const { sent } = L.simulateAndSend(hf, a.accountIdB64);
    expect(sent.ok, sent.error).toBe(true);

    expect(sent.eventsXdr).toHaveLength(1);
    const e = decodeEvent(sent.eventsXdr[0]);
    expect(e.topics).toEqual(['transfer', a.publicKey, b.publicKey, assetName]);
    expect(e.data).toBe(250n);
  });

  it('transfer_maybe_with_issuer rewrites issuer-side transfers to mint/burn', () => {
    // event.rs `transfer_maybe_with_issuer`: from == issuer -> mint,
    // to == issuer -> burn. A plain `transfer` call must therefore NOT emit a
    // `transfer` event when one leg is the issuer.
    const holder = preFundedWallet(L);
    token.trust(holder);

    const fromIssuer = L.simulateAndSend(
      invokeHostFn(token.address, 'transfer', [
        addr(issuer.address), addr(holder.address), i128(700n),
      ]),
      issuer.accountIdB64,
    );
    expect(fromIssuer.sent.ok, fromIssuer.sent.error).toBe(true);
    const minted = decodeEvent(fromIssuer.sent.eventsXdr[0]);
    expect(minted.topics).toEqual(['mint', holder.publicKey, assetName]);
    expect(minted.data).toBe(700n);

    const toIssuer = L.simulateAndSend(
      invokeHostFn(token.address, 'transfer', [
        addr(holder.address), addr(issuer.address), i128(300n),
      ]),
      holder.accountIdB64,
    );
    expect(toIssuer.sent.ok, toIssuer.sent.error).toBe(true);
    const burned = decodeEvent(toIssuer.sent.eventsXdr[0]);
    expect(burned.topics).toEqual(['burn', holder.publicKey, assetName]);
    expect(burned.data).toBe(300n);

    expect(token.balanceOf(holder)).toBe(400n);
  });

  it('a contract driving the SAC emits one transfer event per call, in order', () => {
    // contract_sac_transfer/src/lib.rs `batch_transfer` loops over destinations.
    const w = preFundedWallet(L);
    const c = deploy(L, w.accountIdB64, SAC_TRANSFER, 1);
    mintTo(L, token, issuer, c, 100n);

    const dests = [preFundedWallet(L), preFundedWallet(L), preFundedWallet(L)];
    for (const d of dests) token.trust(d);

    const hf = invokeHostFn(c, 'batch_transfer', [
      addr(token.address),
      xdr.ScVal.scvVec(dests.map((d) => addr(d.address))),
    ]);
    const { sim, sent } = L.simulateAndSend(hf, w.accountIdB64);
    expect(sent.ok, sent.error).toBe(true);

    expect(sent.eventsXdr.map(decodeEvent)).toEqual(
      dests.map((d) => ({
        type: 'contract',
        contract: token.contractId,
        topics: ['transfer', cid(c), d.publicKey, assetName],
        data: 1n,
      })),
    );
    expect(sim.eventsXdr).toEqual(sent.eventsXdr);
    expect(token.balanceOf(c)).toBe(97n);
  });

  it('native XLM transfers name the asset "native"', () => {
    // metadata.rs `set_metadata`: AssetInfo::Native -> name == symbol == "native".
    const a = preFundedWallet(L);
    const b = preFundedWallet(L);
    const nativeAddress = xdr.ScAddress.scAddressTypeContract(
      Buffer.from(StrKey.decodeContract(Asset.native().contractId(L.networkPassphrase))),
    );
    // deploy the native SAC
    const create = xdr.HostFunction.hostFunctionTypeCreateContract(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
          Asset.native().toXDRObject(),
        ),
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      }),
    );
    expect(L.simulateAndSend(create, a.accountIdB64).sent.ok).toBe(true);

    const { sent } = L.simulateAndSend(
      invokeHostFn(nativeAddress, 'transfer', [
        addr(a.address), addr(b.address), i128(1_234n),
      ]),
      a.accountIdB64,
    );
    expect(sent.ok, sent.error).toBe(true);
    const e = decodeEvent(sent.eventsXdr[0]);
    expect(e.topics).toEqual(['transfer', a.publicKey, b.publicKey, 'native']);
    expect(e.data).toBe(1_234n);
  });
});

// ---------------------------------------------------------------------------
// events through the rpc.Server facade
// ---------------------------------------------------------------------------

describe('events through the rpc.Server facade', () => {
  let L: Ledger;
  let w: Wallet;
  let A: xdr.ScAddress;
  let B: xdr.ScAddress;
  let server: rpc.Server;

  beforeEach(() => {
    L = new Ledger();
    w = preFundedWallet(L);
    A = deploy(L, w.accountIdB64, INVOKE_CONTRACT, 1);
    B = deploy(L, w.accountIdB64, INVOKE_CONTRACT, 2);
    server = new rpc.Server('https://in-process.invalid');
    attachInProcessRpc(server, L);
  });

  const buildInvoke = async (hf: xdr.HostFunction, data?: xdr.SorobanTransactionData) => {
    const account = await server.getAccount(w.publicKey);
    const b = new TransactionBuilder(account, {
      fee: '1000000',
      networkPassphrase: L.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: hf, auth: [] }))
      .setTimeout(30);
    if (data) b.setSorobanData(data);
    return b.build();
  };

  it('simulateTransaction returns DiagnosticEvent XDR in `events`', async () => {
    // The SDK parses this field with xdr.DiagnosticEvent.fromXDR
    // (rpc/parsers.js:174) and rpc.Api documents it as xdr.DiagnosticEvent[].
    // fake-rpc.ts:231 puts raw ContractEvent XDR there instead, so the SDK's
    // own parser throws the moment a simulated contract emits anything.
    const tx = await buildInvoke(invokeHostFn(A, 'add_with', [i32(3), i32(4), addr(B)]));
    // The assertion under test is that this call returns at all: the SDK
    // parses `events` eagerly and dies with "Bad union switch: 1" on a
    // ContractEvent (its first word is ExtensionPoint(0), read as the
    // DiagnosticEvent bool, which slides every later field by 4 bytes).
    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationSuccess(sim), JSON.stringify(sim)).toBe(true);
    // An empty `events` would be legal too (diagnostics off); ContractEvent
    // XDR in a DiagnosticEvent field never is.
    for (const e of (sim as rpc.Api.SimulateTransactionSuccessResponse).events) {
      expect(e).toBeInstanceOf(xdr.DiagnosticEvent);
    }
  });

  it('getTransaction carries the contract events the transaction emitted', async () => {
    const hf = invokeHostFn(A, 'add_with', [i32(5), i32(6), addr(B)]);
    // Build the footprint from the raw ledger API, since simulateTransaction
    // through the SDK cannot survive an event-emitting call (test above).
    const sim = L.simulate(hf, w.accountIdB64);
    expect(sim.ok, sim.error).toBe(true);
    const r = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const tx = await buildInvoke(
      hf,
      new SorobanDataBuilder()
        .setResources(r.instructions(), r.diskReadBytes(), r.writeBytes())
        .setReadOnly(r.footprint().readOnly())
        .setReadWrite(r.footprint().readWrite())
        .build(),
    );
    tx.sign(w.keypair);

    const send = await server.sendTransaction(tx);
    expect(send.status).toBe('PENDING');
    const got = (await server.pollTransaction(send.hash)) as rpc.Api.GetSuccessfulTransactionResponse;
    expect(got.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);

    // Two events were emitted (asserted directly against the host above).
    // The SDK exposes them as events.contractEventsXdr — one array per op.
    expect(got.events.contractEventsXdr.flat()).toHaveLength(2);
  });

  it('the classic layer does surface the events on TxOutcome', async () => {
    // Ledger.sendTransaction -> classic.ts:395 copies sent.eventsXdr through,
    // so the events exist; only the RPC facade loses them.
    const hf = invokeHostFn(A, 'add_with', [i32(1), i32(1), addr(B)]);
    const sim = L.simulate(hf, w.accountIdB64);
    const r = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const tx = await buildInvoke(
      hf,
      new SorobanDataBuilder()
        .setResources(r.instructions(), r.diskReadBytes(), r.writeBytes())
        .setReadOnly(r.footprint().readOnly())
        .setReadWrite(r.footprint().readWrite())
        .build(),
    );
    tx.sign(w.keypair);
    const outcome = L.sendTransaction(tx.toXDR());
    expect(outcome.ok, outcome.detail ?? outcome.code).toBe(true);
    expect(outcome.eventsXdr).toHaveLength(2);
    expect(decodeEvent(outcome.eventsXdr![1]).topics).toEqual(['add']);
  });

  // MISSING CAPABILITY. crates/host-wasm/src/lib.rs builds
  // `let mut diagnostics = Vec::new()` and passes `&mut diagnostics` into both
  // invoke_host_function and invoke_host_function_in_recording_mode — the host
  // fills it via extract_diagnostic_events (e2e_invoke.rs:958) — and then the
  // vector is dropped without ever being serialised. Neither SimulateResult nor
  // SendResult has a diagnostics field, so no test can assert on the fn_call /
  // error diagnostic stream. Real stellar-rpc returns exactly this in
  // simulateTransaction's `events` and in sendTransaction's
  // `diagnosticEventsXdr` on ERROR. What the test would look like:
  it.skip('exposes diagnostic events (fn_call / error) — MISSING CAPABILITY', () => {
    const hf = invokeHostFn(A, 'add_with', [i32(3), i32(4), addr(B)]);
    const sim = L.simulate(hf, w.accountIdB64) as any;
    // e2e_invoke.rs:958 records one DiagnosticEvent per host event, including
    // the two `fn_call` events for A.add_with and B.add.
    const diags = (sim.diagnosticEventsXdr as string[]).map((d) =>
      xdr.DiagnosticEvent.fromXDR(d, 'base64'),
    );
    const topics = diags.map((d) =>
      d.event().body().v0().topics().map((t) => scValToNative(t)),
    );
    expect(topics.filter((t) => t[0] === 'fn_call')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// harness gaps found while writing the above
// ---------------------------------------------------------------------------

describe('harness gaps', () => {
  it('deployToken().mint() accepts a CONTRACT recipient', () => {
    // src/fixtures.ts documents this: "Contract (C...) recipients do not need
    // one [a trustline]". But `mint`/`transfer` branch on `'accountId' in to`
    // to tell a Wallet from an ScAddress, and xdr.ScAddress is a js-xdr union
    // whose prototype carries an `accountId` arm accessor — so the test is true
    // for EVERY ScAddress. A contract address is therefore routed into
    // establishTrustlineIfMissing, which builds a LedgerKeyTrustLine with
    // `accountId: <a function>` and dies in toXDR.
    const L = new Ledger();
    const w = preFundedWallet(L);
    const token = deployToken(L, { code: 'CTR', issuer: w });
    const c = deploy(L, w.accountIdB64, SAC_TRANSFER, 1);

    expect(() => token.mint(c, 10n)).not.toThrow();
    expect(token.balanceOf(c)).toBe(10n);
  });
});

// ===========================================================================
// CROSS-CONTRACT INVOCATION
// ===========================================================================

describe('cross-contract invocation', () => {
  let L: Ledger;
  let source: string;
  let A: xdr.ScAddress;
  let B: xdr.ScAddress;

  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
    A = deploy(L, source, INVOKE_CONTRACT, 1);
    B = deploy(L, source, INVOKE_CONTRACT, 2);
  });

  it('the footprint spans BOTH contracts', () => {
    const sim = L.simulate(invokeHostFn(A, 'add_with', [i32(2), i32(3), addr(B)]), source);
    expect(sim.ok, sim.error).toBe(true);

    // A and B share one wasm, so: two instance entries plus one code entry.
    expect(new Set(sim.readOnlyKeys)).toEqual(
      new Set([instanceKey(A), instanceKey(B), codeKey(INVOKE_CONTRACT)]),
    );
    expect(sim.readWriteKeys).toEqual([]);

    // A single-contract call to the very same wasm touches only one instance —
    // so the extra key really is the callee, not padding.
    const solo = L.simulate(invokeHostFn(A, 'add', [i32(2), i32(3)]), source);
    expect(new Set(solo.readOnlyKeys)).toEqual(
      new Set([instanceKey(A), codeKey(INVOKE_CONTRACT)]),
    );
  });

  it('the enforcing path rejects a footprint missing the callee', () => {
    const hf = invokeHostFn(A, 'add_with', [i32(2), i32(3), addr(B)]);
    const sim = L.simulate(hf, source);

    const r = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const trimmed = r
      .footprint()
      .readOnly()
      .filter((k) => k.toXDR('base64') !== instanceKey(B));
    expect(trimmed).toHaveLength(2);
    r.footprint(new xdr.LedgerFootprint({ readOnly: trimmed, readWrite: [] }));

    const sent = L.send(hf, source, r.toXDR('base64'), sim.authXdr, []);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/ExceededLimit|outside of the footprint/);
  });

  it('errors propagate from the callee to the caller and fail the whole call', () => {
    const hf = invokeHostFn(A, 'add_with', [i32(I32_MAX), i32(1), addr(B)]);
    const sim = L.simulate(hf, source);
    expect(sim.ok).toBe(false);
    // The trap is raised in B, escalated through A's `call` host function.
    expect(sim.error).toMatch(/VM call trapped: UnreachableCodeReached/);
    expect(sim.error).toMatch(new RegExp(cid(B)));
    expect(sim.error).toMatch(/contract call failed/);

    // Nothing was written: a later read of the caller still works.
    const after = L.simulate(invokeHostFn(A, 'add_with', [i32(1), i32(1), addr(B)]), source);
    expect(after.ok, after.error).toBe(true);
  });

  it('try_invoke_contract lets the caller recover from the callee trap', () => {
    const { sent } = L.simulateAndSend(
      invokeHostFn(A, 'add_with_try', [i32(I32_MAX), i32(1), addr(B)]),
      source,
    );
    expect(sent.ok, sent.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64'))).toBe(0);
  });

  it('records sub-invocation auth: the callee sits under the caller', () => {
    const L2 = new Ledger();
    const w = preFundedWallet(L2);
    const src = w.accountIdB64;
    const a = deploy(L2, src, AUTH_TEST, 1);
    const b = deploy(L2, src, AUTH_TEST, 2);

    // auth/src/lib.rs tree_fn: require_auth on address 0, then invoke the
    // child, which requires auth from the same address again.
    const hf = invokeHostFn(a, 'tree_fn', [
      xdr.ScVal.scvVec([addr(w.address)]),
      treeVal({
        contract: a,
        needAuth: [true],
        children: [{ contract: b, needAuth: [true], children: [] }],
      }),
    ]);
    const sim = L2.simulate(hf, src);
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.authXdr).toHaveLength(1);

    const entry = xdr.SorobanAuthorizationEntry.fromXDR(sim.authXdr[0], 'base64');
    // Source-account credentials: the tx source is the address being authorized.
    expect(entry.credentials().switch().name).toBe('sorobanCredentialsSourceAccount');
    expect(authTree(entry.rootInvocation())).toEqual({
      call: [cid(a), 'tree_fn'],
      subs: [{ call: [cid(b), 'tree_fn'], subs: [] }],
    });

    const sent = L2.send(hf, src, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
  });

  it('the enforcing path rejects an auth tree missing the sub-invocation', () => {
    const L2 = new Ledger();
    const w = preFundedWallet(L2);
    const src = w.accountIdB64;
    const a = deploy(L2, src, AUTH_TEST, 1);
    const b = deploy(L2, src, AUTH_TEST, 2);

    const hf = invokeHostFn(a, 'tree_fn', [
      xdr.ScVal.scvVec([addr(w.address)]),
      treeVal({
        contract: a,
        needAuth: [true],
        children: [{ contract: b, needAuth: [true], children: [] }],
      }),
    ]);
    const sim = L2.simulate(hf, src);
    const doctored = xdr.SorobanAuthorizationEntry.fromXDR(sim.authXdr[0], 'base64');
    doctored.rootInvocation().subInvocations([]);

    const sent = L2.send(
      hf, src, sim.resourcesXdr, [doctored.toXDR('base64')], sim.restoredRwEntryIndices,
    );
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Error\(Auth, InvalidAction\)/);
  });

  it('a contract calling a SAC needs no auth entry (invoker auth)', () => {
    const L2 = new Ledger();
    const w = preFundedWallet(L2);
    const token = deployToken(L2, { code: 'INV', issuer: w });
    const c = deploy(L2, w.accountIdB64, SAC_TRANSFER, 1);
    mintTo(L2, token, w, c, 50n);
    const dest = preFundedWallet(L2);
    token.trust(dest);

    const hf = invokeHostFn(c, 'transfer_1', [addr(token.address), addr(dest.address)]);
    const sim = L2.simulate(hf, w.accountIdB64);
    expect(sim.ok, sim.error).toBe(true);
    // `from` is the calling contract itself, so the host authorizes it as the
    // invoker — no SorobanAuthorizationEntry is produced for the source account.
    expect(sim.authXdr).toEqual([]);

    // The footprint spans the calling contract AND the SAC.
    const all = new Set([...sim.readOnlyKeys, ...sim.readWriteKeys]);
    expect(all.has(instanceKey(c))).toBe(true);
    expect(all.has(codeKey(SAC_TRANSFER))).toBe(true);
    expect(all.has(instanceKey(token.address))).toBe(true);

    const sent = L2.send(hf, w.accountIdB64, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(token.balanceOf(c)).toBe(49n);
    expect(token.balanceOf(dest)).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// a contract deploying another contract
// ---------------------------------------------------------------------------

describe('contract-deployed contracts', () => {
  it('a contract deploys another and the new instance lands in the ledger', () => {
    const L = new Ledger();
    const source = L.fundAccount(1);
    const factory = deploy(L, source, CREATE_CONTRACT, 1);
    const addHash = L.seedWasm(ADD_I32);
    const salt = Buffer.alloc(32, 9);

    const hf = invokeHostFn(factory, 'create', [
      xdr.ScVal.scvBytes(Buffer.from(addHash, 'base64')),
      xdr.ScVal.scvBytes(salt),
    ]);
    const sim = L.simulate(hf, source);
    expect(sim.ok, sim.error).toBe(true);

    // The address is fully determined by (network, factory address, salt).
    const child = derivedContractAddress(L, factory, salt);
    expect(sim.readWriteKeys).toEqual([instanceKey(child)]);
    expect(new Set(sim.readOnlyKeys)).toEqual(
      new Set([instanceKey(factory), codeKey(CREATE_CONTRACT), codeKey(ADD_I32)]),
    );

    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(sent.changedKeys).toContain(instanceKey(child));

    // The child is live and runs the wasm it was deployed with.
    const call = L.simulate(invokeHostFn(child, 'add', [i32(20), i32(22)]), source);
    expect(call.ok, call.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(call.returnValueXdr!, 'base64'))).toBe(42);
  });

  it('replays upstream test_deployer_operations_using_simulation', () => {
    // e2e_tests.rs:3278. DEPLOYER_TEST_CONTRACT.deploy uploads two wasms from
    // inside the contract, deploys UPDATEABLE, calls `update` to swap its
    // executable to ADD_I32, then calls `add` three times.
    const L = new Ledger();
    const source = L.fundAccount(1);
    const deployer = deploy(L, source, TEST_DEPLOYER, 1);
    const salt = Buffer.alloc(32, 5);

    const hf = invokeHostFn(deployer, 'deploy', [
      xdr.ScVal.scvBytes(Buffer.from(UPDATEABLE)),
      xdr.ScVal.scvBytes(Buffer.from(ADD_I32)),
      xdr.ScVal.scvBytes(salt),
    ]);
    const sim = L.simulate(hf, source);
    expect(sim.ok, sim.error).toBe(true);

    const child = derivedContractAddress(L, deployer, salt);
    // Everything the contract creates is read-write: the child instance and
    // both freshly uploaded code entries.
    expect(new Set(sim.readWriteKeys)).toEqual(
      new Set([instanceKey(child), codeKey(UPDATEABLE), codeKey(ADD_I32)]),
    );
    expect(new Set(sim.readOnlyKeys)).toEqual(
      new Set([instanceKey(deployer), codeKey(TEST_DEPLOYER)]),
    );

    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(new Set(sent.changedKeys)).toEqual(new Set(sim.readWriteKeys));

    // The child ended up running ADD_I32, exactly as the contract asserted
    // internally (res2 == 11 / 12 / 13).
    const call = L.simulate(invokeHostFn(child, 'add', [i32(5), i32(6)]), source);
    expect(call.ok, call.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(call.returnValueXdr!, 'base64'))).toBe(11);
  });
});
