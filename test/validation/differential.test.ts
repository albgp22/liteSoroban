/**
 * DIFFERENTIAL CONFORMANCE — in-process harness vs a REAL stellar-core node.
 *
 * The same scenario is run twice: once against the in-process `Ledger`, once
 * against a live stellar-rpc + stellar-core standalone network through an
 * ordinary `rpc.Server`. Everything that should be identical is compared:
 *
 *   - the simulated footprint (read_only / read_write key sets, sorted base64)
 *   - resources: instructions, disk read bytes, write bytes
 *   - the returned ScVal
 *   - contract events
 *   - the ScError on failure paths (footprint violation, budget exhaustion)
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NORMALISED, AND WHY
 * ---------------------------------------------------------------------------
 *
 * 1. ABSOLUTE LEDGER SEQUENCE. The in-process ledger starts at 1,000,000; the
 *    standalone node is a few thousand ledgers old. Nothing that depends on the
 *    absolute sequence is compared:
 *      - `liveUntilLedgerSeq` / TTLs                 — excluded
 *      - `lastModifiedLedgerSeq` on ledger entries   — excluded
 *      - `minResourceFee` / `resourceFee`            — excluded (rent is a
 *        function of ledger sequence AND of live Soroban state size, which a
 *        fresh in-memory map can never match; `fake-rpc.ts` invents this number
 *        anyway, see README "No fee refunds")
 *    When node state is copied into the in-process ledger, TTLs are REBASED:
 *    `inProcessLiveUntil = inProcessSeq + (nodeLiveUntil - nodeSeq)`, so an
 *    entry that is live on the node is live in-process by the same margin. This
 *    matters: `Host::instantiate_vm` simulates a module-cache HIT only when the
 *    ContractCode key is live in the snapshot, and a cache miss meters ~400k
 *    extra instructions.
 *
 * 2. STATE. Rather than fabricate an equivalent account, the node's real
 *    `AccountEntry` XDR is copied verbatim into the in-process ledger before
 *    each scenario. A node account that has already submitted a transaction
 *    carries `AccountEntryExtensionV1/V2/V3`, which `Ledger.fund()` does not
 *    produce, and account entry size feeds `disk_read_bytes` / `write_bytes`
 *    directly.
 *
 * 3. THE UPLOADED WASM IS MADE UNIQUE PER RUN by appending a custom section.
 *    The node keeps state between test runs; uploading a wasm that is already
 *    present meters differently (write_bytes 0, ~135k more instructions), so a
 *    fixed fixture would make this suite order-dependent on node history. Both
 *    sides receive byte-identical bytes, so the comparison is unaffected.
 *
 * 4. INSTRUCTIONS ARE COMPARED THROUGH stellar-rpc's DOCUMENTED ADJUSTMENT.
 *    stellar-rpc does not return the raw metered count: `preflight/src/shared.rs`
 *    uses `SimulationAdjustmentConfig::default_adjustment()`, which is
 *    `instructions: SimulationAdjustmentFactor::new(1.04, 50_000)`, raised to
 *    the caller's `instructionLeeway`. Every simulation below passes
 *    `{ cpuInstructions: 0 }` so the additive factor is exactly 50,000, and
 *    `soroban-simulation/src/resources.rs::adjust_u32` is applied to the
 *    in-process raw count before comparing. Nothing is fitted to observed data.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Address,
  BASE_FEE,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import {
  Ledger,
  uploadWasmHostFn,
  createContractHostFn,
  invokeHostFn,
  type SimulateResult,
} from '../../src/index.js';
import { wrapWallet, type Wallet } from '../../src/fixtures.js';
import { PROTOCOL_27_COST_PARAMS } from '../../src/cost-params.js';

// ---------------------------------------------------------------------------
// the live network
// ---------------------------------------------------------------------------

const NETWORK_URL = process.env.STELLAR_QUICKSTART_URL ?? 'http://localhost:8000';
const RPC_URL = `${NETWORK_URL}/rpc`;
const FRIENDBOT_URL = `${NETWORK_URL}/friendbot`;
const PASSPHRASE = 'Standalone Network ; February 2017';

const server = new rpc.Server(RPC_URL, { allowHttp: true });

/** Probed at module load so `describe.skipIf` can see it during collection. */
const NODE: { up: boolean; why?: string; passphrase?: string; protocolVersion?: number } =
  await (async () => {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(5000),
      });
      const health = await res.json();
      if (health?.result?.status !== 'healthy') {
        return { up: false, why: `getHealth returned ${JSON.stringify(health)}` };
      }
      const net = await server.getNetwork();
      return { up: true, passphrase: net.passphrase, protocolVersion: net.protocolVersion };
    } catch (e: any) {
      return { up: false, why: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
    }
  })();

if (!NODE.up) {
  // Loud, because a silently skipped differential suite is worse than no suite.
  console.warn(
    `\n[differential] stellar node at ${RPC_URL} is NOT reachable — the whole ` +
      `differential dimension is SKIPPED (${NODE.why}).\n`,
  );
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const ADD_I32 = fixture('add_i32.wasm');
const CONTRACT_DATA = fixture('contract_data.wasm');
/** The exact binary upstream's `e2e_tests.rs` measures (`soroban_test_wasms::ADD_I32`). */
const UPSTREAM_ADD_I32 = fixture('upstream_add_i32.wasm');

const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });

/** Append a wasm custom section holding random bytes — see note 3 in the header. */
function uniquifyWasm(wasm: Uint8Array): Uint8Array {
  const tag = new Uint8Array(16);
  crypto.getRandomValues(tag);
  const name = Buffer.from('difftest', 'ascii');
  const payload = Buffer.concat([Buffer.from([name.length]), name, Buffer.from(tag)]);
  return new Uint8Array(
    Buffer.concat([Buffer.from(wasm), Buffer.from([0x00, payload.length]), payload]),
  );
}

// ---------------------------------------------------------------------------
// stellar-rpc's preflight adjustment, transcribed from ground truth
// ---------------------------------------------------------------------------

/**
 * `soroban-simulation/src/resources.rs`:
 *   fn adjust_u32(&self, value) -> if value == 0 { 0 } else {
 *       value.saturating_add(additive).max((value as f64 * mult).floor() as u32) }
 *
 * with `SimulationAdjustmentConfig::default_adjustment().instructions ==
 * SimulationAdjustmentFactor::new(1.04, 50_000)` and stellar-rpc raising the
 * additive factor to `max(50_000, instructionLeeway)` — we always pass
 * instructionLeeway 0, so it stays 50,000.
 */
const RPC_INSTRUCTION_MULTIPLIER = 1.04;
const RPC_INSTRUCTION_ADDITIVE = 50_000;

function adjustInstructions(raw: number): number {
  if (raw === 0) return 0;
  return Math.max(raw + RPC_INSTRUCTION_ADDITIVE, Math.floor(raw * RPC_INSTRUCTION_MULTIPLIER));
}

/** Best-effort inverse, for reporting the node's raw metered count. */
function impliedRawInstructions(adjusted: number): number {
  const additive = adjusted - RPC_INSTRUCTION_ADDITIVE;
  if (additive > 0 && adjustInstructions(additive) === adjusted) return additive;
  for (const cand of [Math.ceil(adjusted / RPC_INSTRUCTION_MULTIPLIER), Math.floor(adjusted / RPC_INSTRUCTION_MULTIPLIER)]) {
    if (adjustInstructions(cand) === adjusted) return cand;
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// the shape both sides are reduced to
// ---------------------------------------------------------------------------

interface Side {
  ok: boolean;
  error?: string;
  readOnly: string[];
  readWrite: string[];
  /** Raw metered instructions for the in-process side, ADJUSTED for the node. */
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  retval?: string;
  contractEvents: string[];
  auth: string[];
}

interface Scenario {
  node: Side;
  inproc: Side;
}

const sorted = (xs: string[]) => [...xs].sort();

function fromInProcess(sim: SimulateResult): Side {
  return {
    ok: sim.ok,
    error: sim.error,
    readOnly: sorted(sim.readOnlyKeys),
    readWrite: sorted(sim.readWriteKeys),
    instructions: sim.instructions,
    diskReadBytes: sim.readBytes, // P27: SorobanResources.read_bytes IS disk_read_bytes
    writeBytes: sim.writeBytes,
    retval: sim.returnValueXdr,
    contractEvents: sim.eventsXdr,
    auth: sim.authXdr,
  };
}

function fromNode(sim: rpc.Api.SimulateTransactionResponse): Side {
  if (!rpc.Api.isSimulationSuccess(sim)) {
    return {
      ok: false,
      error: (sim as rpc.Api.SimulateTransactionErrorResponse).error,
      readOnly: [],
      readWrite: [],
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
      contractEvents: [],
      auth: [],
    };
  }
  const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
  const res = ok.transactionData.build().resources();
  return {
    ok: true,
    readOnly: sorted(res.footprint().readOnly().map((k) => k.toXDR('base64'))),
    readWrite: sorted(res.footprint().readWrite().map((k) => k.toXDR('base64'))),
    instructions: res.instructions(),
    diskReadBytes: res.diskReadBytes(),
    writeBytes: res.writeBytes(),
    retval: ok.result?.retval.toXDR('base64'),
    // The node returns DIAGNOSTIC events (fn_call / fn_return / contract);
    // the harness's SimulateResult.eventsXdr carries `contract_events` only.
    contractEvents: (ok.events ?? [])
      .filter((e) => e.event().type().name === 'contract')
      .map((e) => e.event().toXDR('base64')),
    auth: (ok.result?.auth ?? []).map((a) => a.toXDR('base64')),
  };
}

// ---------------------------------------------------------------------------
// node plumbing
// ---------------------------------------------------------------------------

async function friendbot(publicKey: string): Promise<void> {
  const r = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${await r.text()}`);
}

function buildTx(account: any, fn: xdr.HostFunction) {
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: fn, auth: [] }))
    .setTimeout(120)
    .build();
}

async function nodeSimulate(kp: Keypair, fn: xdr.HostFunction) {
  const account = await server.getAccount(kp.publicKey());
  const tx = buildTx(account, fn);
  // instructionLeeway 0 pins the additive adjustment factor at exactly 50,000.
  const sim = await server.simulateTransaction(tx, { cpuInstructions: 0 });
  return { tx, sim };
}

interface NodeApply {
  status: string;
  /** InvokeHostFunctionResult union arm, e.g. invokeHostFunctionTrapped. */
  opResult?: string;
  scErrors: string[];
}

async function nodeApply(
  kp: Keypair,
  fn: xdr.HostFunction,
  mutateSorobanData?: (d: xdr.SorobanTransactionData) => void,
): Promise<NodeApply> {
  const { tx, sim } = await nodeSimulate(kp, fn);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`node simulation failed: ${(sim as any).error}`);
  }
  let prepared = rpc.assembleTransaction(tx, sim).build();
  if (mutateSorobanData) {
    const data = prepared.toEnvelope().v1().tx().ext().sorobanData();
    mutateSorobanData(data);
    prepared = TransactionBuilder.cloneFrom(prepared).setSorobanData(data).build();
  }
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status !== 'PENDING') {
    return {
      status: sent.status,
      opResult: sent.errorResult?.result().switch().name,
      scErrors: [],
    };
  }
  const got: any = await server.pollTransaction(sent.hash, {
    attempts: 60,
    sleepStrategy: () => 500,
  });
  let opResult: string | undefined;
  try {
    const resultXdr: string =
      typeof got.resultXdr === 'string' ? got.resultXdr : got.resultXdr.toXDR('base64');
    opResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64')
      .result()
      .results()[0]
      .tr()
      .invokeHostFunctionResult()
      .switch().name;
  } catch {
    /* txSUCCESS with a different shape, or a fee-bump; not needed here */
  }
  return { status: got.status, opResult, scErrors: scErrorsOf(got.diagnosticEventsXdr) };
}

/** `Error(Storage, ExceededLimit)`-style rendering of an `ScError`. */
function formatScError(e: any): string {
  const type = e.switch().name.replace(/^sce/, '');
  if (type === 'Contract') return `Contract, #${e.contractCode()}`;
  let code: any;
  try {
    code = e.code();
  } catch {
    code = e.value();
  }
  const name = typeof code?.name === 'string' ? code.name : String(code);
  return `${type}, ${name.replace(/^scec/, '').replace(/^./, (c) => c.toUpperCase())}`;
}

function scErrorsOf(diagnostics: xdr.DiagnosticEvent[] | undefined): string[] {
  const out: string[] = [];
  for (const d of diagnostics ?? []) {
    const body = d.event().body().v0();
    for (const t of body.topics()) {
      if (t.switch().name === 'scvError') out.push(formatScError(t.error()));
    }
    const data = body.data();
    if (data.switch().name === 'scvError') out.push(formatScError(data.error()));
  }
  return out;
}

/** Parse the host's Debug-formatted `HostError` back into `Type, Code`. */
function scErrorOfHostError(error: string | undefined): string | null {
  const m = /Error\(([A-Za-z]+),\s*([A-Za-z0-9#]+)\)/.exec(error ?? '');
  return m ? `${m[1]}, ${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// mirroring node state into the in-process ledger (see note 1 + 2 in the header)
// ---------------------------------------------------------------------------

function accountKey(publicKey: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: xdr.AccountId.publicKeyTypeEd25519(Keypair.fromPublicKey(publicKey).rawPublicKey()),
    }),
  );
}

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Copy the node's entries for `keys` into `L`, rebasing every TTL onto the
 * in-process ledger sequence. Returns how many entries were found.
 */
async function mirror(L: Ledger, keys: xdr.LedgerKey[]): Promise<number> {
  const latest = await server.getLatestLedger();
  const res = await server.getLedgerEntries(...keys);
  for (const e of res.entries) {
    const liveUntil =
      e.liveUntilLedgerSeq === undefined
        ? undefined
        : L.ledgerSeq + Math.max(0, Number(e.liveUntilLedgerSeq) - latest.sequence);
    L.putEntry(
      new xdr.LedgerEntry({
        lastModifiedLedgerSeq: L.ledgerSeq,
        data: e.val,
        ext: new xdr.LedgerEntryExt(0),
      }).toXDR('base64'),
      liveUntil,
    );
  }
  return res.entries.length;
}

// ---------------------------------------------------------------------------
// ground truth: the pinned host's `Budget::default()` CPU cost model. Since
// soroban-env-host 28.0.0 that is the live calibration; on 29.0.2 it equals the
// shipped protocol-27 table entry for entry (test/cost-params.test.ts asserts
// it). An earlier version hard-coded 27.0.1's defaults here, which were
// stellar-core's protocol-20 `initialCpuCostParamsEntryForV20`, and so failed
// against any network running the current host.
// ---------------------------------------------------------------------------

const HOST_DEFAULT_CPU_COST_PARAMS: ReadonlyArray<readonly [string, number, number]> = (
  xdr.ContractCostParams.fromXDR(PROTOCOL_27_COST_PARAMS.cpuInstructions, 'base64') as any[]
).map(
  (e, i) =>
    [
      (xdr.ContractCostType as any).fromValue(i).name as string,
      Number(e.constTerm().toString()),
      Number(e.linearTerm().toString()),
    ] as const,
);

// ---------------------------------------------------------------------------
// ground-truth anchor — no node required
// ---------------------------------------------------------------------------

describe('metering anchor: the harness vs the host it pins', () => {
  it('reproduces upstream e2e_tests.rs `test_wasm_upload_success_in_recording_mode` exactly', () => {
    // soroban-env-host-29.0.2/src/test/e2e_tests.rs:883
    //   expect!["1528075"].assert_eq(&res.resources.instructions.to_string());
    //   expect!["684"].assert_eq(&res.resources.write_bytes.to_string());
    const L = new Ledger({ networkPassphrase: PASSPHRASE });
    const source = L.fundAccount(1);
    const sim = L.simulate(uploadWasmHostFn(UPSTREAM_ADD_I32), source);

    expect(sim.ok, sim.error).toBe(true);
    expect(sim.instructions).toBe(1528075);
    expect(sim.writeBytes).toBe(684);
    expect(sim.readBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the differential suite
// ---------------------------------------------------------------------------

describe.skipIf(!NODE.up)('differential conformance vs a real stellar-core node', () => {
  const scenarios: Record<string, Scenario> = {};
  const failures: Record<
    string,
    { node: NodeApply; inprocOk: boolean; inprocScError: string | null; inprocError?: string }
  > = {};
  /** Account-entry shape as each side holds it, and the re-synced re-run. */
  let accountShapes:
    | { key: string; node: string; nodeStored: string | undefined; inproc: string | undefined }[]
    | undefined;
  let sacResynced: Scenario | undefined;
  let setupError: unknown;
  let L: Ledger;
  let wallet: Wallet;
  let other: Wallet;

  beforeAll(async () => {
    try {
      expect(NODE.passphrase, 'the node must be the standalone network this suite assumes').toBe(
        PASSPHRASE,
      );

      const kp = Keypair.random();
      const kp2 = Keypair.random();
      await friendbot(kp.publicKey());
      await friendbot(kp2.publicKey());

      // Same passphrase => same network id => same contract ids and auth payloads.
      L = new Ledger({ networkPassphrase: PASSPHRASE });
      wallet = wrapWallet(L, kp);
      other = wrapWallet(L, kp2);

      const sync = () => mirror(L, [accountKey(kp.publicKey()), accountKey(kp2.publicKey())]);

      // -- scenario 1: upload -------------------------------------------------
      const wasm = uniquifyWasm(ADD_I32);
      const uploadFn = uploadWasmHostFn(wasm);

      await sync();
      const nodeUpload = await nodeSimulate(kp, uploadFn);
      const inprocUpload = L.simulate(uploadFn, wallet.accountIdB64);
      scenarios.upload = { node: fromNode(nodeUpload.sim), inproc: fromInProcess(inprocUpload) };

      // apply on both so the rest of the scenarios share a precondition
      await nodeApply(kp, uploadFn);
      const uploadSent = L.send(
        uploadFn,
        wallet.accountIdB64,
        inprocUpload.resourcesXdr,
        inprocUpload.authXdr,
        inprocUpload.restoredRwEntryIndices,
      );
      expect(uploadSent.ok, `in-process upload failed: ${uploadSent.error}`).toBe(true);

      const wasmHash = xdr.ScVal.fromXDR(inprocUpload.returnValueXdr!, 'base64')
        .bytes()
        .toString('base64');

      // -- scenario 2: deploy -------------------------------------------------
      const deployFn = createContractHostFn(wallet.accountIdB64, wasmHash, Buffer.alloc(32, 0x2a));

      await sync();
      const nodeDeploy = await nodeSimulate(kp, deployFn);
      const inprocDeploy = L.simulate(deployFn, wallet.accountIdB64);
      scenarios.deploy = { node: fromNode(nodeDeploy.sim), inproc: fromInProcess(inprocDeploy) };

      await nodeApply(kp, deployFn);
      const deploySent = L.send(
        deployFn,
        wallet.accountIdB64,
        inprocDeploy.resourcesXdr,
        inprocDeploy.authXdr,
        inprocDeploy.restoredRwEntryIndices,
      );
      expect(deploySent.ok, `in-process deploy failed: ${deploySent.error}`).toBe(true);

      const addContract = xdr.ScVal.fromXDR(inprocDeploy.returnValueXdr!, 'base64').address();

      // -- scenario 3: invoke add(2, 3) --------------------------------------
      const addFn = invokeHostFn(addContract, 'add', [i32(2), i32(3)]);

      await sync();
      const nodeAdd = await nodeSimulate(kp, addFn);
      const inprocAdd = L.simulate(addFn, wallet.accountIdB64);
      scenarios.add = { node: fromNode(nodeAdd.sim), inproc: fromInProcess(inprocAdd) };

      // -- scenarios 4/5: contract_data put_persistent / get_persistent -------
      const dataWasm = uniquifyWasm(CONTRACT_DATA);
      const dataUploadFn = uploadWasmHostFn(dataWasm);

      await sync();
      const inprocDataUpload = L.simulate(dataUploadFn, wallet.accountIdB64);
      await nodeApply(kp, dataUploadFn);
      L.send(
        dataUploadFn,
        wallet.accountIdB64,
        inprocDataUpload.resourcesXdr,
        inprocDataUpload.authXdr,
        inprocDataUpload.restoredRwEntryIndices,
      );
      const dataHash = xdr.ScVal.fromXDR(inprocDataUpload.returnValueXdr!, 'base64')
        .bytes()
        .toString('base64');

      const dataDeployFn = createContractHostFn(
        wallet.accountIdB64,
        dataHash,
        Buffer.alloc(32, 0x5c),
      );
      const inprocDataDeploy = L.simulate(dataDeployFn, wallet.accountIdB64);
      await nodeApply(kp, dataDeployFn);
      L.send(
        dataDeployFn,
        wallet.accountIdB64,
        inprocDataDeploy.resourcesXdr,
        inprocDataDeploy.authXdr,
        inprocDataDeploy.restoredRwEntryIndices,
      );
      const dataContract = xdr.ScVal.fromXDR(inprocDataDeploy.returnValueXdr!, 'base64').address();

      const putFn = invokeHostFn(dataContract, 'put_persistent', [sym('ctr'), u64(42n)]);
      await sync();
      const nodePut = await nodeSimulate(kp, putFn);
      const inprocPut = L.simulate(putFn, wallet.accountIdB64);
      scenarios.put_persistent = { node: fromNode(nodePut.sim), inproc: fromInProcess(inprocPut) };

      await nodeApply(kp, putFn);
      const putSent = L.send(
        putFn,
        wallet.accountIdB64,
        inprocPut.resourcesXdr,
        inprocPut.authXdr,
        inprocPut.restoredRwEntryIndices,
      );
      expect(putSent.ok, `in-process put_persistent failed: ${putSent.error}`).toBe(true);

      const getFn = invokeHostFn(dataContract, 'get_persistent', [sym('ctr')]);
      await sync();
      const nodeGet = await nodeSimulate(kp, getFn);
      const inprocGet = L.simulate(getFn, wallet.accountIdB64);
      scenarios.get_persistent = { node: fromNode(nodeGet.sim), inproc: fromInProcess(inprocGet) };

      // -- scenario 6: a call that actually emits a contract event ------------
      // The native Stellar Asset Contract is a builtin, so no upload is needed;
      // `transfer` is the only readily available source of real contract events.
      const native = Asset.native();
      const sacId = native.contractId(PASSPHRASE);
      const sacCreateFn = xdr.HostFunction.hostFunctionTypeCreateContract(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
            native.toXDRObject(),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      );
      const alreadyDeployed = await server.getLedgerEntries(instanceKey(sacId));
      if (alreadyDeployed.entries.length === 0) await nodeApply(kp, sacCreateFn);

      const transferFn = invokeHostFn(Address.fromString(sacId).toScAddress(), 'transfer', [
        xdr.ScVal.scvAddress(wallet.address),
        xdr.ScVal.scvAddress(other.address),
        i128(1n),
      ]);
      await sync();
      await mirror(L, [instanceKey(sacId)]);
      const nodeTransfer = await nodeSimulate(kp, transferFn);
      const inprocTransfer = L.simulate(transferFn, wallet.accountIdB64);
      scenarios.sac_transfer = {
        node: fromNode(nodeTransfer.sim),
        inproc: fromInProcess(inprocTransfer),
      };

      // -- scenario 6b: the same call, re-run against the node's OWN pre-state -
      // `simulateTransaction.stateChanges[].before` is the exact `LedgerEntry`
      // the node's preflight snapshot fed to the host. Loading it isolates
      // "does the host meter the same way" from "does the harness hold the same
      // bytes" — the two are separate questions and only one of them fails.
      if (rpc.Api.isSimulationSuccess(nodeTransfer.sim)) {
        const changes = (nodeTransfer.sim as rpc.Api.SimulateTransactionSuccessResponse)
          .stateChanges ?? [];
        accountShapes = [];
        for (const ch of changes) {
          if (!ch.before) continue;
          const key = ch.key.toXDR('base64');
          // What the node STORES (getLedgerEntries), as opposed to `before`,
          // which is the entry after preflight's account normalisation.
          const stored = (await server.getLedgerEntries(ch.key)).entries[0];
          accountShapes.push({
            key,
            node: ch.before.toXDR('base64'),
            nodeStored: stored?.val.toXDR('base64'),
            inproc: L.getEntry(key),
          });
          L.putEntry(ch.before.toXDR('base64'));
        }
        const inprocResynced = L.simulate(transferFn, wallet.accountIdB64);
        sacResynced = {
          node: fromNode(nodeTransfer.sim),
          inproc: fromInProcess(inprocResynced),
        };
      }

      // -- scenario 7: footprint violation (apply path) -----------------------
      const emptyFootprint = (d: xdr.SorobanTransactionData) =>
        d.resources().footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));

      const nodeFootprint = await nodeApply(kp, addFn, emptyFootprint);
      const strippedResources = xdr.SorobanResources.fromXDR(inprocAdd.resourcesXdr, 'base64');
      strippedResources.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));
      let inprocFootprint: { ok: boolean; error?: string };
      try {
        inprocFootprint = L.send(
          addFn,
          wallet.accountIdB64,
          strippedResources.toXDR('base64'),
          inprocAdd.authXdr,
          [],
        );
      } catch (e: any) {
        inprocFootprint = { ok: false, error: String(e?.message ?? e) };
      }
      failures.footprint_violation = {
        node: nodeFootprint,
        inprocOk: inprocFootprint.ok,
        inprocScError: scErrorOfHostError(inprocFootprint.error),
        inprocError: inprocFootprint.error,
      };

      // -- scenario 8: budget failure (apply path) ----------------------------
      // A transaction declares its own CPU limit in SorobanResources.instructions;
      // stellar-core builds the budget from it. 1,000 is far below what add() costs.
      const starveInstructions = (d: xdr.SorobanTransactionData) => d.resources().instructions(1000);

      const nodeBudget = await nodeApply(kp, addFn, starveInstructions);
      const starved = xdr.SorobanResources.fromXDR(inprocAdd.resourcesXdr, 'base64');
      starved.instructions(1000);
      let inprocBudget: { ok: boolean; error?: string };
      try {
        inprocBudget = L.send(
          addFn,
          wallet.accountIdB64,
          starved.toXDR('base64'),
          inprocAdd.authXdr,
          [],
        );
      } catch (e: any) {
        inprocBudget = { ok: false, error: String(e?.message ?? e) };
      }
      failures.budget_failure = {
        node: nodeBudget,
        inprocOk: inprocBudget.ok,
        inprocScError: scErrorOfHostError(inprocBudget.error),
        inprocError: inprocBudget.error,
      };
    } catch (e) {
      setupError = e;
    }
  }, 600_000);

  it('the differential setup completed', () => {
    if (setupError) throw setupError;
    expect(Object.keys(scenarios).sort()).toEqual([
      'add',
      'deploy',
      'get_persistent',
      'put_persistent',
      'sac_transfer',
      'upload',
    ]);
  });

  // -- per-scenario comparisons ---------------------------------------------

  for (const name of [
    'upload',
    'deploy',
    'add',
    'put_persistent',
    'get_persistent',
    'sac_transfer',
  ]) {
    describe(name, () => {
      it('both sides simulated successfully', () => {
        const s = scenarios[name];
        expect(s, 'scenario missing — see "the differential setup completed"').toBeDefined();
        expect(s.node.ok, `node: ${s.node.error}`).toBe(true);
        expect(s.inproc.ok, `in-process: ${s.inproc.error}`).toBe(true);
      });

      it('footprint read_only and read_write key sets match', () => {
        const s = scenarios[name];
        expect(s.inproc.readOnly).toEqual(s.node.readOnly);
        expect(s.inproc.readWrite).toEqual(s.node.readWrite);
      });

      it('disk read bytes and write bytes match', () => {
        const s = scenarios[name];
        expect({ disk: s.inproc.diskReadBytes, write: s.inproc.writeBytes }).toEqual({
          disk: s.node.diskReadBytes,
          write: s.node.writeBytes,
        });
      });

      it('return value and contract events match', () => {
        const s = scenarios[name];
        expect(s.inproc.retval).toBe(s.node.retval);
        expect(s.inproc.contractEvents).toEqual(s.node.contractEvents);
      });

      it('recorded authorization entries match', () => {
        const s = scenarios[name];
        expect(s.inproc.auth).toEqual(s.node.auth);
      });

      it('instruction count matches after applying stellar-rpc\'s preflight adjustment', () => {
        const s = scenarios[name];
        const expected = adjustInstructions(s.inproc.instructions);
        const nodeRaw = impliedRawInstructions(s.node.instructions);
        const delta = s.inproc.instructions - nodeRaw;
        expect(
          expected,
          `INSTRUCTION MISMATCH (${name}):\n` +
            `  in-process raw          = ${s.inproc.instructions}\n` +
            `  in-process adjusted     = ${expected}   (x1.04 / +50000, whichever is larger)\n` +
            `  node reported (adjusted)= ${s.node.instructions}\n` +
            `  node implied raw        = ${nodeRaw}\n` +
            `  delta (in-process - node) = ${delta}  (${((delta / nodeRaw) * 100).toFixed(1)}% over)\n`,
        ).toBe(s.node.instructions);
      });
    });
  }

  // -- classic account entries: representation vs metering -------------------

  describe('AccountEntry representation', () => {
    // Two different representations, and an earlier version of this test
    // compared one with the other:
    //   - what the node STORES, i.e. getLedgerEntries: ext = v0 for an account
    //     that never submitted a transaction, the v1 -> v2 -> v3 chain once its
    //     sequence has moved (TransactionFrame::processSeqNum);
    //   - what preflight hands the HOST, i.e. stateChanges[].before: every
    //     account promoted to the chain by soroban-simulation's
    //     SimulationSnapshotSource (snapshot_source.rs), +52 bytes each.
    // The harness stores the first and simulates through the second; the
    // simulated half is pinned by the sac_transfer disk/write-bytes test above.
    const accountShape = (b64: string | undefined, kind: 'entry' | 'data') => {
      if (!b64) return { accountBytes: 0, extDepth: -1 };
      const data =
        kind === 'entry'
          ? xdr.LedgerEntry.fromXDR(b64, 'base64').data()
          : xdr.LedgerEntryData.fromXDR(b64, 'base64');
      const acc = data.account();
      let depth = acc.ext().switch();
      if (depth === 1) depth = acc.ext().v1().ext().switch() === 2 ? 2 : 1;
      if (depth === 2) depth = acc.ext().v1().ext().v2().ext().switch() === 3 ? 3 : 2;
      return { accountBytes: acc.toXDR().length, extDepth: depth };
    };

    it('the harness stores the same AccountEntry shape the node stores', () => {
      expect(accountShapes, 'setup did not capture the pre-state').toBeDefined();
      expect(accountShapes!.length, 'the SAC transfer must touch two accounts').toBe(2);
      expect(accountShapes!.map((s) => accountShape(s.inproc, 'entry'))).toEqual(
        accountShapes!.map((s) => accountShape(s.nodeStored, 'data')),
      );
    });

    it("preflight hands the host every account promoted to ext v3, as the harness's simulation does", () => {
      expect(accountShapes, 'setup did not capture the pre-state').toBeDefined();
      for (const s of accountShapes!) expect(accountShape(s.node, 'entry').extDepth).toBe(3);
    });

    it('given the node\'s own pre-state, disk read / write bytes agree exactly', () => {
      expect(sacResynced, 'setup did not run the re-synced simulation').toBeDefined();
      const s = sacResynced!;
      expect(s.inproc.ok, s.inproc.error).toBe(true);
      expect({ disk: s.inproc.diskReadBytes, write: s.inproc.writeBytes }).toEqual({
        disk: s.node.diskReadBytes,
        write: s.node.writeBytes,
      });
      // and the footprint, return value and events are still identical
      expect(s.inproc.readOnly).toEqual(s.node.readOnly);
      expect(s.inproc.readWrite).toEqual(s.node.readWrite);
      expect(s.inproc.contractEvents).toEqual(s.node.contractEvents);
    });
  });

  // -- failure paths ---------------------------------------------------------

  describe('footprint violation (enforcing apply path)', () => {
    it('the node rejects a transaction whose footprint was stripped', () => {
      const f = failures.footprint_violation;
      expect(f, 'setup did not run').toBeDefined();
      expect(f.node.status).toBe('FAILED');
      expect(f.node.opResult).toBe('invokeHostFunctionTrapped');
      expect(f.node.scErrors).toContain('Storage, ExceededLimit');
    });

    it('the in-process apply path rejects it with the SAME ScError', () => {
      const f = failures.footprint_violation;
      expect(f.inprocOk, `in-process send should have failed: ${f.inprocError}`).toBe(false);
      expect(f.inprocScError).toBe('Storage, ExceededLimit');
    });
  });

  describe('budget failure (enforcing apply path)', () => {
    it('the node rejects a transaction that declares too few instructions', () => {
      const f = failures.budget_failure;
      expect(f, 'setup did not run').toBeDefined();
      expect(f.node.status).toBe('FAILED');
      expect(f.node.opResult).toBe('invokeHostFunctionResourceLimitExceeded');
      expect(f.node.scErrors).toContain('Budget, ExceededLimit');
    });

    it('the in-process apply path enforces the declared instruction limit too', () => {
      const f = failures.budget_failure;
      expect(
        f.inprocOk,
        'SorobanResources.instructions is the transaction\'s CPU budget: stellar-core builds ' +
          'the Budget from it, so a transaction declaring 1,000 instructions MUST fail with ' +
          'Error(Budget, ExceededLimit). The in-process `send` passes Budget::default() to ' +
          'e2e_invoke::invoke_host_function and never reads resources.instructions, so the ' +
          'declared limit is ignored and the call succeeds.',
      ).toBe(false);
      expect(f.inprocScError).toBe('Budget, ExceededLimit');
    });
  });

  // -- why the instruction counts differ -------------------------------------

  it('the harness meters with the same CPU cost parameters as the live network', async () => {
    const key = xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({
        configSettingId: xdr.ConfigSettingId.configSettingContractCostParamsCpuInstructions(),
      }),
    );
    const res = await server.getLedgerEntries(key);
    expect(res.entries.length, 'the node must expose its CPU cost params').toBe(1);
    const live = (res.entries[0].val as any).configSetting().contractCostParamsCpuInsns();

    const differences: string[] = [];
    for (let i = 0; i < Math.min(live.length, HOST_DEFAULT_CPU_COST_PARAMS.length); i++) {
      const [name, constTerm, linTerm] = HOST_DEFAULT_CPU_COST_PARAMS[i];
      const liveConst = Number(live[i].constTerm().toString());
      const liveLin = Number(live[i].linearTerm().toString());
      if (liveConst !== constTerm || liveLin !== linTerm) {
        differences.push(
          `  [${i}] ${name}: host Budget::default() = (${constTerm}, ${linTerm}), ` +
            `network = (${liveConst}, ${liveLin})`,
        );
      }
    }

    expect(live.length, 'cost parameter table length').toBe(HOST_DEFAULT_CPU_COST_PARAMS.length);
    expect(
      differences,
      'The in-process host meters with the pinned soroban-env-host `Budget::default()`. A network ' +
        'meters with its ConfigSettingContractCostParamsCpuInstructions; where they differ, load it ' +
        'with withNetworkCostParams(await loadCostParamsFromRpc(server)). Differing entries:\n' +
        differences.join('\n'),
    ).toEqual([]);
  });
});
