/**
 * DIMENSION: resource limits, budget exhaustion, error-code fidelity.
 *
 * Ground truth used throughout (read, not guessed):
 *
 *   soroban-env-host 27.0.1
 *     src/budget/limits.rs:41         DEFAULT_HOST_DEPTH_LIMIT   = 100
 *     src/budget/limits.rs:45         DEFAULT_CPU_INSN_LIMIT     = 100_000_000
 *     src/budget/limits.rs:46         DEFAULT_MEM_BYTES_LIMIT    = 40 * 1024 * 1024
 *     src/budget.rs:1049-1051         BudgetImpl::default() resets both dimensions to those
 *     src/budget.rs:306               "Default settings for local/sandbox testing only. The
 *                                      actual operations will use parameters read on-chain
 *                                      from network configuration via `from_configs`"
 *     src/e2e_invoke.rs:687-688       "The input `Budget` should normally be configured to
 *                                      match the network limits."
 *     src/e2e_invoke.rs:408-423       invoke_host_function() NEVER reads resources.instructions
 *                                      for enforcement -- the caller must set the CPU limit.
 *     src/test/e2e_tests.rs:384-387   upstream's own enforcing helper does exactly that:
 *                                      Budget::default() + budget.reset_cpu_limit(
 *                                        resources.instructions as u64)
 *
 *   stellar-core master
 *     src/rust/src/soroban_proto_any.rs:446    Budget::try_from_configs(instruction_limit,
 *                                                ledger_info.memory_limit, on-chain cpu params,
 *                                                on-chain mem params)
 *     src/transactions/InvokeHostFunctionOpFrame.cpp:690  instruction_limit is
 *                                                mResources.instructions -- the DECLARED value
 *     src/transactions/InvokeHostFunctionOpFrame.cpp:737  post-hoc check
 *                                                mResources.instructions < out.cpu_insns ->
 *                                                INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED
 *     src/transactions/InvokeHostFunctionOpFrame.cpp:368  diskReadBytes enforced per read
 *     src/transactions/InvokeHostFunctionOpFrame.cpp:805  writeBytes enforced per write
 *     src/transactions/TransactionFrame.cpp:786           instructions > txMaxInstructions
 *                                                          -> validation failure
 *     src/transactions/TransactionFrame.cpp:1425-1441     duplicate key across RO/RW footprints
 *                                                          -> txSOROBAN_INVALID
 *
 * CONCLUSION on `Budget::default()` (asserted below, not asserted here):
 *   - Ceilings: 100_000_000 CPU insns / 40 MiB, compiled in. limits.rs:43-44 says
 *     outright "These are some sane values, however the embedder should typically
 *     customize these to match the network config". They are not read from any
 *     config and this harness exposes no way to change them.
 *   - Per-transaction limit: WRONG. On the network the budget's CPU limit is the
 *     transaction's own DECLARED resources.instructions, not the network maximum.
 *     crates/host-wasm/src/lib.rs:498 never calls reset_cpu_limit, so the declared
 *     value is inert and under-declaring instructions can never fail here.
 *   - Cost parameters: hardcoded crate calibration rather than the on-chain
 *     ConfigSettingContractCostParams{CpuInstructions,MemoryBytes}. They agree at
 *     protocol 27, but a cost-parameter upgrade cannot be modelled or detected.
 *
 * Expected error TYPE/CODE pairs come from upstream tests, never from this harness:
 *     e2e_tests.rs:750  test_run_out_of_budget_before_calling_host        Budget/ExceededLimit
 *     e2e_tests.rs:1004 test_wasm_upload_budget_exceeded                  Budget/ExceededLimit
 *     e2e_tests.rs:1029 test_wasm_upload_with_incorrect_footprint_fails   Storage/ExceededLimit
 *     e2e_tests.rs:1056 test_wasm_upload_without_footprint_fails          Storage/ExceededLimit
 *     e2e_tests.rs:1802 test_create_contract_without_auth_fails           Auth/InvalidAction
 *     e2e_tests.rs:1828 test_create_contract_without_wasm_entry_fails     Storage/MissingValue
 *     e2e_tests.rs:987  test_wasm_upload_failure_using_simulation         WasmVm/InvalidAction
 *     src/test/invocation.rs:132 invoke_cross_contract_with_err           Object/IndexBounds
 *     soroban-test-wasms/wasm-workspace/err/src/lib.rs   Eek::BADNESS = 12345 -> Contract/#12345
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  xdr,
  rpc,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import {
  Ledger,
  createContractHostFn,
  invokeHostFn,
  uploadWasmHostFn,
  type SimulateResult,
  type SendResult,
} from '../../src/index.js';
import { attachInProcessRpc } from '../../src/fake-rpc.js';
import { accountIdFromPublicKey, loadAccount } from '../../src/classic.js';

// ---------------------------------------------------------------------------
// ground-truth constants, transcribed from the pinned host
// ---------------------------------------------------------------------------

/** soroban-env-host-27.0.1/src/budget/limits.rs:45 */
const DEFAULT_CPU_INSN_LIMIT = 100_000_000;
/** soroban-env-host-27.0.1/src/budget/limits.rs:46 */
const DEFAULT_MEM_BYTES_LIMIT = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const ADD_I32 = fixture('upstream_add_i32.wasm');
const CONTRACT_STORAGE = fixture('upstream_contract_data.wasm');
const LOADGEN = fixture('loadgen.wasm');
const ALLOC = fixture('alloc.wasm');
const VEC = fixture('vec.wasm');
const ERR = fixture('err.wasm');
const LINEAR_MEMORY = fixture('linear_memory.wasm');

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });

// ---------------------------------------------------------------------------
// error-string parsing
//
// The harness returns `format!("{e:?}")` of a Rust HostError. Its Debug impl
// (src/host/error.rs:108) writes "HostError: {error:?}" then the event log.
// Errors raised OUTSIDE the invocation (recording-mode top-level failures) are
// re-thrown as a JsError whose message is "host: " + the same Debug string.
// There is no structured value to compare, so every assertion here has to go
// through a regex. That is itself one of the findings.
// ---------------------------------------------------------------------------

const HOST_ERROR_RE = /^(?:host: )?HostError: Error\(([A-Za-z]+), (#?[A-Za-z0-9]+)\)/;

interface HostErr {
  type: string;
  code: string;
}

function parseHostError(s: string | undefined, where: string): HostErr {
  expect(s, `${where}: expected a host error string, got ${s}`).toBeTypeOf('string');
  const m = HOST_ERROR_RE.exec(s!.trim());
  expect(m, `${where}: cannot parse a host error out of ${JSON.stringify(s)}`).not.toBeNull();
  return { type: m![1], code: m![2] };
}

/** The error of a call that returned `{ ok: false }`. */
function returnedError(r: SimulateResult | SendResult, where: string): HostErr {
  expect(r.ok, `${where}: expected failure, but the call succeeded`).toBe(false);
  return parseHostError(r.error, where);
}

/** The error of a call that threw out of wasm instead of returning. */
function thrownError(fn: () => unknown, where: string): HostErr {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `${where}: expected a throw, but the call returned normally`).toBeDefined();
  return parseHostError((caught as Error).message, where);
}

const fmt = (e: HostErr) => `Error(${e.type}, ${e.code})`;

// ---------------------------------------------------------------------------
// resource helpers
// ---------------------------------------------------------------------------

const decodeResources = (b64: string) => xdr.SorobanResources.fromXDR(b64, 'base64');

function withResources(
  b64: string,
  mutate: (r: xdr.SorobanResources) => void,
): string {
  const r = decodeResources(b64);
  mutate(r);
  return r.toXDR('base64');
}

function sorobanData(resources: xdr.SorobanResources, resourceFee: bigint) {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources,
    resourceFee: new xdr.Int64(resourceFee),
  });
}

describe('resource limits, budget exhaustion and error-code fidelity', () => {
  let L: Ledger;
  let kp: Keypair;
  let source: string;

  beforeEach(() => {
    L = new Ledger();
    kp = Keypair.random();
    L.fund(kp.publicKey());
    source = accountIdFromPublicKey(kp.publicKey()).toXDR('base64');
  });

  /** Upload + deploy, returning the contract address. */
  function deploy(code: Uint8Array, salt = 0): xdr.ScAddress {
    const wasmHash = L.seedWasm(code);
    const { sent } = L.simulateAndSend(
      createContractHostFn(source, wasmHash, Buffer.alloc(32, salt)),
      source,
    );
    expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
    return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  }

  // =========================================================================
  // 1. What Budget::default() actually enforces, and how it differs from
  //    the way stellar-core builds the budget for a real transaction.
  // =========================================================================
  describe('Budget::default() vs the mainnet budget', () => {
    it('enforces the compiled-in 100M instruction ceiling on the enforcing path', () => {
      const addr = deploy(LOADGEN);

      // A cheap call, purely to obtain a legitimate footprint. Arguments do not
      // change the footprint of do_cpu_only_work: it touches no storage.
      const cheap = L.simulate(
        invokeHostFn(addr, 'do_cpu_only_work', [u32(1_000), u32(0), u32(0)]),
        source,
      );
      expect(cheap.ok, cheap.error).toBe(true);

      // ~40.8 CPU instructions per guest cycle, measured; 3M cycles is ~122M,
      // comfortably past DEFAULT_CPU_INSN_LIMIT.
      const expensive = invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]);
      const sent = L.send(expensive, source, cheap.resourcesXdr, cheap.authXdr, []);

      // e2e_tests.rs:1004 test_wasm_upload_budget_exceeded: budget exhaustion on
      // the enforcing path is a RETURNED invoke_result error, not a top-level one.
      const err = returnedError(sent, 'over-budget enforcing call');
      expect(fmt(err)).toBe('Error(Budget, ExceededLimit)');

      // ...and it stopped at the limit, not somewhere arbitrary.
      // Upstream asserts get_cpu_insns_remaining() == 0.
      expect(Number(sent.cpuInsns)).toBeGreaterThan(DEFAULT_CPU_INSN_LIMIT * 0.99);
      expect(Number(sent.cpuInsns)).toBeLessThanOrEqual(DEFAULT_CPU_INSN_LIMIT);

      // Nothing was committed.
      expect(sent.changedKeys).toEqual([]);
      expect(sent.removedKeys).toEqual([]);
      expect(sent.eventsXdr).toEqual([]);
    });

    it('an allocation-heavy contract also lands on Budget/ExceededLimit, not a generic failure', () => {
      const addr = deploy(ALLOC);

      const cheap = L.simulate(invokeHostFn(addr, 'sum', [u32(128)]), source);
      expect(cheap.ok, cheap.error).toBe(true);
      // Sanity: the small call is nowhere near either ceiling, so the big one
      // failing really is the budget and not some other property of the input.
      expect(Number(cheap.cpuInsns)).toBeLessThan(DEFAULT_CPU_INSN_LIMIT);
      expect(Number(cheap.memBytes)).toBeLessThan(DEFAULT_MEM_BYTES_LIMIT);

      const huge = invokeHostFn(addr, 'sum', [u32(100_000)]);
      const sent = L.send(huge, source, cheap.resourcesXdr, cheap.authXdr, []);
      const err = returnedError(sent, 'alloc past the budget');
      expect(fmt(err)).toBe('Error(Budget, ExceededLimit)');
    });

    it('GAP: the enforcing path ignores the DECLARED SorobanResources.instructions', () => {
      // stellar-core: InvokeHostFunctionOpFrame.cpp:690 passes mResources.instructions
      // as the budget's CPU limit (soroban_proto_any.rs:446), so a transaction that
      // under-declares its instructions fails with Budget/ExceededLimit and is
      // reported as INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED.
      // Upstream's own e2e helper does the same (e2e_tests.rs:384-387), which is why
      // e2e_tests.rs:750 test_run_out_of_budget_before_calling_host can declare
      // 1000 instructions and assert Budget/ExceededLimit.
      //
      // crates/host-wasm/src/lib.rs:498 does `let budget = Budget::default();` with
      // no reset_cpu_limit, so the declared value is inert.
      const hostFn = uploadWasmHostFn(ADD_I32);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);
      expect(sim.instructions).toBeGreaterThan(1_000_000);

      const starved = withResources(sim.resourcesXdr, (r) => r.instructions(1_000));
      const sent = L.send(hostFn, source, starved, sim.authXdr, []);

      const err = returnedError(sent, 'upload declaring 1000 instructions');
      expect(fmt(err)).toBe('Error(Budget, ExceededLimit)');
    });

    it('GAP: the enforcing path ignores the DECLARED writeBytes', () => {
      // stellar-core: InvokeHostFunctionOpFrame.cpp:805 -- every entry written is
      // metered against mResources.writeBytes and overrunning it yields
      // INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED with a Budget/ExceededLimit
      // diagnostic. Neither the host nor this harness performs that check.
      const addr = deploy(CONTRACT_STORAGE);
      const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(7n)]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);
      expect(sim.writeBytes).toBeGreaterThan(0);

      const starved = withResources(sim.resourcesXdr, (r) => r.writeBytes(0));
      const sent = L.send(hostFn, source, starved, sim.authXdr, []);
      expect(sent.ok, 'declaring writeBytes=0 while writing an entry must fail').toBe(false);
    });

    it('GAP: the enforcing path ignores the DECLARED diskReadBytes', () => {
      // stellar-core: InvokeHostFunctionOpFrame.cpp:368.
      const addr = deploy(CONTRACT_STORAGE);
      L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('k'), u64(7n)]), source);

      const hostFn = invokeHostFn(addr, 'get_persistent', [sym('k')]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const starved = withResources(sim.resourcesXdr, (r) => r.diskReadBytes(0));
      const sent = L.send(hostFn, source, starved, sim.authXdr, []);
      expect(sent.ok, 'declaring diskReadBytes=0 while reading entries must fail').toBe(false);
    });

    it.skip('MISSING CAPABILITY: no way to configure the budget to a network config', () => {
      // e2e_invoke.rs:687 "The input `Budget` should normally be configured to match
      // the network limits", and budget.rs:306 says Default is "for local/sandbox
      // testing only". stellar-core builds it with Budget::try_from_configs(
      //   txMaxInstructions-or-declared, txMemoryLimit,
      //   ConfigSettingContractCostParamsCpuInstructions,
      //   ConfigSettingContractCostParamsMemoryBytes)  -- all read from the ledger.
      //
      // The harness hardcodes Budget::default() in both simulate() and send()
      // (crates/host-wasm/src/lib.rs:386 and :498) and exposes no knob. A test
      // that wants to pin a contract against a *lowered* network limit, or against
      // a future cost-parameter upgrade, cannot be written at all.
      //
      // What is needed: Ledger({ cpuInstructionLimit, memoryBytesLimit }) at minimum,
      // and ideally `setCostParams(cpuParamsXdr, memParamsXdr)`.
    });
  });

  // =========================================================================
  // 2. Budget exhaustion on the RECORDING path, and through the façades.
  // =========================================================================
  describe('budget exhaustion in recording mode', () => {
    it('throws instead of returning a failed simulation', () => {
      // This half is faithful: e2e_invoke.rs:686 documents that "Exceeding the
      // budget is the only error condition for this function", i.e. recording mode
      // returns a top-level Err rather than populating invoke_result. The harness
      // maps that to a JsError.
      const addr = deploy(LOADGEN);
      const err = thrownError(
        () =>
          L.simulate(
            invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
            source,
          ),
        'recording-mode budget exhaustion',
      );
      expect(fmt(err)).toBe('Error(Budget, ExceededLimit)');
    });

    it('GAP: simulateTransaction() through rpc.Server throws instead of returning a simulation error', async () => {
      // Real stellar-rpc answers an over-budget preflight with a JSON-RPC *result*
      // carrying `error`, which the SDK surfaces as Api.SimulateTransactionErrorResponse.
      // fake-rpc.ts:212 calls ledger.simulate() with no try/catch, so the adapter
      // rejects the promise and no app code path can distinguish "preflight says this
      // transaction is too expensive" from "the harness broke".
      const addr = deploy(LOADGEN);

      const server = new rpc.Server('https://in-process.invalid');
      attachInProcessRpc(server, L);

      const account = await server.getAccount(kp.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build();

      const sim = await server.simulateTransaction(tx);
      expect(rpc.Api.isSimulationError(sim), 'expected a SimulationError result').toBe(true);
    });
  });

  // =========================================================================
  // 3. Budget exhaustion through the classic apply path.
  // =========================================================================
  describe('budget exhaustion through sendTransaction', () => {
    it('is txFAILED, with the fee charged and the sequence number consumed', () => {
      const addr = deploy(LOADGEN);

      const cheap = L.simulate(
        invokeHostFn(addr, 'do_cpu_only_work', [u32(1_000), u32(0), u32(0)]),
        source,
      );
      expect(cheap.ok, cheap.error).toBe(true);

      const before = loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!;
      const balanceBefore = BigInt(before.balance().toString());
      const seqBefore = BigInt(before.seqNum().toString());

      const account = { accountId: () => kp.publicKey(), sequenceNumber: () => seqBefore.toString(), incrementSequenceNumber: () => {} } as any;
      const resources = decodeResources(cheap.resourcesXdr);
      const resourceFee = 2_000_000n;
      const tx = new TransactionBuilder(account, {
        fee: String(resourceFee + 100n),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
            auth: [],
          }),
        )
        .setSorobanData(sorobanData(resources, resourceFee))
        .setTimeout(300)
        .build();
      tx.sign(kp);

      const out = L.sendTransaction(tx.toEnvelope().toXDR('base64'));

      // stellar-core: INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED -> the operation
      // fails, the transaction is txFAILED, the fee is charged, the seqnum burned.
      expect(out.code).toBe('txFAILED');
      expect(out.ok).toBe(false);
      expect(fmt(parseHostError(out.error, 'classic over-budget'))).toBe(
        'Error(Budget, ExceededLimit)',
      );

      const after = loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!;
      expect(BigInt(after.seqNum().toString())).toBe(seqBefore + 1n);
      expect(BigInt(after.balance().toString())).toBeLessThan(balanceBefore);
    });

    it('GAP: no SorobanResources validation — an absurd instruction count is accepted', () => {
      // TransactionFrame.cpp:786: resources.instructions > txMaxInstructions is a
      // *validation* failure before the host ever runs. u32::MAX instructions is 17x
      // the largest txMaxInstructions core itself will ever construct
      // (NetworkConfig.h:215-216: TX_MAX_INSTRUCTIONS * 100 = 250M), so no network
      // config makes this transaction valid.
      const addr = deploy(CONTRACT_STORAGE);
      const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const resources = decodeResources(sim.resourcesXdr);
      resources.instructions(0xffff_ffff);

      const account = { accountId: () => kp.publicKey(), sequenceNumber: () => '0', incrementSequenceNumber: () => {} } as any;
      const resourceFee = 2_000_000n;
      const tx = new TransactionBuilder(account, {
        fee: String(resourceFee + 100n),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: sim.authXdr.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64')) }))
        .setSorobanData(sorobanData(resources, resourceFee))
        .setTimeout(300)
        .build();
      tx.sign(kp);

      const out = L.sendTransaction(tx.toEnvelope().toXDR('base64'));
      expect(out.code).toBe('txSOROBAN_INVALID');
    });
  });

  // =========================================================================
  // 4. Footprint violations.
  // =========================================================================
  describe('footprint violations', () => {
    it('writing to an entry declared read-only is Storage/ExceededLimit', () => {
      const addr = deploy(CONTRACT_STORAGE);
      const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(7n)]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);
      expect(sim.readWriteKeys.length).toBeGreaterThan(0);

      const demoted = withResources(sim.resourcesXdr, (r) => {
        const fp = r.footprint();
        r.footprint(
          new xdr.LedgerFootprint({
            readOnly: [...fp.readOnly(), ...fp.readWrite()],
            readWrite: [],
          }),
        );
      });

      const sent = L.send(hostFn, source, demoted, sim.authXdr, []);
      const err = returnedError(sent, 'write to a read-only entry');
      expect(fmt(err)).toBe('Error(Storage, ExceededLimit)');
      expect(sent.changedKeys).toEqual([]);
    });

    it('an entry missing from the footprint entirely is Storage/ExceededLimit', () => {
      // e2e_tests.rs:1056 test_wasm_upload_without_footprint_fails.
      const hostFn = uploadWasmHostFn(LINEAR_MEMORY);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const empty = withResources(sim.resourcesXdr, (r) =>
        r.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] })),
      );
      const sent = L.send(hostFn, source, empty, sim.authXdr, []);
      const err = returnedError(sent, 'upload with an empty footprint');
      expect(fmt(err)).toBe('Error(Storage, ExceededLimit)');
    });

    it('an upload declared read-only instead of read-write is Storage/ExceededLimit', () => {
      // e2e_tests.rs:1029 test_wasm_upload_with_incorrect_footprint_fails.
      const hostFn = uploadWasmHostFn(LINEAR_MEMORY);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const flipped = withResources(sim.resourcesXdr, (r) => {
        const rw = r.footprint().readWrite();
        r.footprint(new xdr.LedgerFootprint({ readOnly: rw, readWrite: [] }));
      });
      const sent = L.send(hostFn, source, flipped, sim.authXdr, []);
      const err = returnedError(sent, 'upload with RO instead of RW');
      expect(fmt(err)).toBe('Error(Storage, ExceededLimit)');
    });

    it('deploying a contract whose wasm entry is absent is Storage/MissingValue', () => {
      // e2e_tests.rs:1828 test_create_contract_without_wasm_entry_fails. The wasm
      // hash is well formed but nothing was ever uploaded under it.
      const neverUploaded = createHash('sha256').update(Buffer.from(VEC)).digest();
      const hostFn = createContractHostFn(
        source,
        neverUploaded.toString('base64'),
        Buffer.alloc(32, 9),
      );
      const sim = L.simulate(hostFn, source);
      const err = returnedError(sim, 'deploy with an un-uploaded wasm hash');
      expect(fmt(err)).toBe('Error(Storage, MissingValue)');
    });

    it('a key present in BOTH footprints is demoted to read-only by the host', () => {
      // e2e_invoke.rs:998-1022 build_storage_footprint_from_xdr inserts read_write
      // first and read_only second into the same map, so the read-only entry wins.
      // A transaction like this can never write.
      const addr = deploy(CONTRACT_STORAGE);
      const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(7n)]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const overlapped = withResources(sim.resourcesXdr, (r) => {
        const fp = r.footprint();
        const rw = fp.readWrite();
        r.footprint(new xdr.LedgerFootprint({ readOnly: [...fp.readOnly(), ...rw], readWrite: rw }));
      });
      const sent = L.send(hostFn, source, overlapped, sim.authXdr, []);
      const err = returnedError(sent, 'RO/RW overlap');
      expect(fmt(err)).toBe('Error(Storage, ExceededLimit)');
    });

    it('GAP: an RO/RW footprint overlap is not rejected as txSOROBAN_INVALID', () => {
      // TransactionFrame.cpp:1425-1441: "Found duplicate key in the Soroban footprint;
      // every key across read-only and read-write footprints has to be unique."
      // -> txSOROBAN_INVALID, before the host runs. The harness has no such check,
      // so it silently produces a host-level Storage error instead, and a test that
      // pins core's validation behaviour cannot pass.
      const addr = deploy(CONTRACT_STORAGE);
      const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok, sim.error).toBe(true);

      const resources = decodeResources(sim.resourcesXdr);
      const fp = resources.footprint();
      const rw = fp.readWrite();
      resources.footprint(
        new xdr.LedgerFootprint({ readOnly: [...fp.readOnly(), ...rw], readWrite: rw }),
      );

      const account = { accountId: () => kp.publicKey(), sequenceNumber: () => '0', incrementSequenceNumber: () => {} } as any;
      const resourceFee = 2_000_000n;
      const tx = new TransactionBuilder(account, {
        fee: String(resourceFee + 100n),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: [] }))
        .setSorobanData(sorobanData(resources, resourceFee))
        .setTimeout(300)
        .build();
      tx.sign(kp);

      const out = L.sendTransaction(tx.toEnvelope().toXDR('base64'));
      expect(out.code).toBe('txSOROBAN_INVALID');
    });
  });

  // =========================================================================
  // 5. Error-code fidelity.
  // =========================================================================
  describe('error-code fidelity', () => {
    it('the distinct HostError variants are all reachable and all distinguishable', () => {
      const seen = new Map<string, string>();
      const record = (label: string, e: HostErr) => {
        const key = fmt(e);
        expect(
          seen.has(key),
          `${label} produced ${key}, already produced by ${seen.get(key)}`,
        ).toBe(false);
        seen.set(key, label);
      };

      // -- Budget/ExceededLimit (e2e_tests.rs:1004)
      {
        const addr = deploy(LOADGEN, 1);
        const cheap = L.simulate(
          invokeHostFn(addr, 'do_cpu_only_work', [u32(1_000), u32(0), u32(0)]),
          source,
        );
        const sent = L.send(
          invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
          source,
          cheap.resourcesXdr,
          cheap.authXdr,
          [],
        );
        record('budget exhaustion', returnedError(sent, 'budget'));
      }

      // -- Storage/ExceededLimit (e2e_tests.rs:1029)
      {
        const hostFn = uploadWasmHostFn(LINEAR_MEMORY);
        const sim = L.simulate(hostFn, source);
        const flipped = withResources(sim.resourcesXdr, (r) =>
          r.footprint(new xdr.LedgerFootprint({ readOnly: r.footprint().readWrite(), readWrite: [] })),
        );
        record('footprint violation', returnedError(L.send(hostFn, source, flipped, [], []), 'footprint'));
      }

      // -- Storage/MissingValue (e2e_tests.rs:1828)
      {
        const hash = createHash('sha256').update(Buffer.from(VEC)).digest();
        const sim = L.simulate(
          createContractHostFn(source, hash.toString('base64'), Buffer.alloc(32, 3)),
          source,
        );
        record('missing wasm entry', returnedError(sim, 'missing wasm'));
      }

      // -- Auth/InvalidAction (e2e_tests.rs:1802 test_create_contract_without_auth_fails)
      {
        const wasmHash = L.seedWasm(ADD_I32);
        const hostFn = createContractHostFn(source, wasmHash, Buffer.alloc(32, 4));
        const sim = L.simulate(hostFn, source);
        expect(sim.ok, sim.error).toBe(true);
        expect(sim.authXdr.length).toBeGreaterThan(0);
        // Same footprint, same resources, auth stripped.
        const sent = L.send(hostFn, source, sim.resourcesXdr, [], []);
        record('deploy without auth', returnedError(sent, 'no auth'));
      }

      // -- WasmVm/InvalidAction (e2e_tests.rs:987)
      {
        const sim = L.simulate(uploadWasmHostFn(new Uint8Array(1000)), source);
        record('invalid wasm bytes', returnedError(sim, 'invalid wasm'));
      }

      // -- Object/IndexBounds (src/test/invocation.rs:132)
      {
        const addr = deploy(VEC, 5);
        const sim = L.simulate(invokeHostFn(addr, 'vec_err', [u32(1)]), source);
        record('vec index out of bounds', returnedError(sim, 'vec_err'));
      }

      // -- Contract/#12345 (soroban-test-wasms err/src/lib.rs, Eek::BADNESS = 12345)
      {
        const addr = deploy(ERR, 6);
        const sim = L.simulate(invokeHostFn(addr, 'err_eek', []), source);
        const e = returnedError(sim, 'err_eek');
        expect(fmt(e)).toBe('Error(Contract, #12345)');
        record('contract error', e);
      }

      // -- Context/InvalidAction: err.spoof() returns Ok(Error) carrying a
      //    non-Contract error; the host refuses to let a contract forge one.
      {
        const addr = deploy(ERR, 8);
        const sim = L.simulate(invokeHostFn(addr, 'spoof', []), source);
        record('spoofed host error', returnedError(sim, 'spoof'));
      }

      // -- Value/InvalidInput: an argument nested past DEFAULT_HOST_DEPTH_LIMIT (100).
      {
        const addr = deploy(CONTRACT_STORAGE, 7);
        let deep: xdr.ScVal = xdr.ScVal.scvU32(1);
        for (let i = 0; i < 200; i++) deep = xdr.ScVal.scvVec([deep]);
        record(
          'over-deep ScVal argument',
          thrownError(
            () => L.simulate(invokeHostFn(addr, 'put_persistent', [deep, u64(1n)]), source),
            'deep ScVal',
          ),
        );
      }

      // Nine distinct (type, code) pairs, none colliding.
      expect([...seen.keys()].sort()).toEqual(
        [
          'Error(Auth, InvalidAction)',
          'Error(Budget, ExceededLimit)',
          'Error(Context, InvalidAction)',
          'Error(Contract, #12345)',
          'Error(Object, IndexBounds)',
          'Error(Storage, ExceededLimit)',
          'Error(Storage, MissingValue)',
          'Error(Value, InvalidInput)',
          'Error(WasmVm, InvalidAction)',
        ].sort(),
      );
    });

    it('distinguishing two contract error codes needs string surgery, not a value comparison', () => {
      const addr = deploy(ERR);

      const eek = L.simulate(invokeHostFn(addr, 'err_eek', []), source);
      const divide = L.simulate(invokeHostFn(addr, 'divide', [u32(0)]), source);

      expect(eek.ok).toBe(false);
      expect(divide.ok).toBe(false);

      // The ONLY thing the harness hands back is a formatted Rust Debug string.
      expect(typeof eek.error).toBe('string');
      expect(eek.error!.startsWith('HostError: Error(')).toBe(true);

      // Multi-line: line 0 is the error, the rest is a human-readable event log
      // that embeds contract-controlled text (function names, arguments, messages).
      expect(eek.error!.split('\n').length).toBeGreaterThan(2);
      expect(eek.error).toContain('Event log (newest first):');

      // A contract-defined error and a wasm trap are only told apart by parsing.
      expect(fmt(parseHostError(eek.error, 'err_eek'))).toBe('Error(Contract, #12345)');
      expect(fmt(parseHostError(divide.error, 'divide'))).toBe('Error(WasmVm, InvalidAction)');

      // The naive assertion an application test would actually write is unsound:
      // the event log repeats the error, so a substring match on a *different*
      // error's text can still hit. Anchoring to the first line is mandatory.
      expect(eek.error!.indexOf('Error(Contract, #12345)')).toBeLessThan(
        eek.error!.lastIndexOf('Error(Contract, #12345)'),
      );
    });

    it('the same logical failure has two incompatible string shapes', () => {
      const addr = deploy(LOADGEN);

      // Enforcing mode: returned.
      const cheap = L.simulate(
        invokeHostFn(addr, 'do_cpu_only_work', [u32(1_000), u32(0), u32(0)]),
        source,
      );
      const sent = L.send(
        invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
        source,
        cheap.resourcesXdr,
        cheap.authXdr,
        [],
      );
      expect(sent.ok).toBe(false);
      expect(sent.error!.startsWith('HostError: ')).toBe(true);
      expect(sent.error).toContain('Event log (newest first):');

      // Recording mode, the SAME logical failure: thrown, differently prefixed,
      // and with the event log replaced by "DebugInfo not available".
      let thrown = '';
      try {
        L.simulate(invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]), source);
      } catch (e) {
        thrown = (e as Error).message;
      }
      expect(thrown.startsWith('host: HostError: ')).toBe(true);
      expect(thrown).toContain('DebugInfo not available');
      expect(thrown).not.toContain('Event log');

      // Both carry the same Error(Type, Code), so a test CAN assert on the code --
      // but only with a matcher that tolerates the "host: " prefix and the absence
      // of the event log. Nothing in the harness provides that matcher.
      expect(fmt(parseHostError(sent.error, 'returned'))).toBe(
        fmt(parseHostError(thrown, 'thrown')),
      );

      // A third shape: simulateAndSend() wraps a RETURNED failure in its own
      // message (src/index.ts:179) but lets a THROWN one through untouched, so
      // the same helper produces "simulation failed: HostError: ..." for one
      // class of error and "host: HostError: ..." for another.
      const errAddr = deploy(ERR, 11);
      let wrapped = '';
      try {
        L.simulateAndSend(invokeHostFn(errAddr, 'err_eek', []), source);
      } catch (e) {
        wrapped = (e as Error).message;
      }
      expect(wrapped.startsWith('simulation failed: HostError: ')).toBe(true);
      expect(HOST_ERROR_RE.test(wrapped)).toBe(false);

      let passthrough = '';
      try {
        L.simulateAndSend(
          invokeHostFn(addr, 'do_cpu_only_work', [u32(3_000_000), u32(0), u32(0)]),
          source,
        );
      } catch (e) {
        passthrough = (e as Error).message;
      }
      expect(passthrough.startsWith('host: HostError: ')).toBe(true);
    });

    it('GAP: diagnostic events are computed by the host and dropped before reaching JS', () => {
      // e2e_invoke.rs fills `diagnostic_events` on every failure path, and upstream
      // asserts on it (e2e_tests.rs:925, :963, :1073 `diagnostic_events.len() >= 1`).
      // crates/host-wasm/src/lib.rs:499 declares `let mut diagnostics = Vec::new();`
      // passes it to the host, and never serialises it into SendResult. Real
      // stellar-core returns these in the transaction meta and stellar-rpc exposes
      // them as `diagnosticEventsXdr`, which is where the SDK reads a *typed*
      // xdr.ScError out of the `error` topic. Without them there is no typed error
      // anywhere in this harness.
      const addr = deploy(ERR);
      const hostFn = invokeHostFn(addr, 'err_eek', []);
      const sim = L.simulate(hostFn, source);
      expect(sim.ok).toBe(false);

      expect(Object.keys(sim)).toContain('diagnosticEventsXdr');
    });
  });

  // =========================================================================
  // 6. Malformed input.
  // =========================================================================
  describe('malformed input', () => {
    it('invalid wasm bytes on upload are WasmVm/InvalidAction, on both paths', () => {
      // e2e_tests.rs:987 test_wasm_upload_failure_using_simulation uses [0u8; 1000].
      const junk = new Uint8Array(1000);
      const hostFn = uploadWasmHostFn(junk);

      const sim = L.simulate(hostFn, source);
      expect(fmt(returnedError(sim, 'junk upload, recording'))).toBe('Error(WasmVm, InvalidAction)');

      // The enforcing path with the footprint recording produced.
      const sent = L.send(hostFn, source, sim.resourcesXdr, sim.authXdr, []);
      expect(fmt(returnedError(sent, 'junk upload, enforcing'))).toBe(
        'Error(WasmVm, InvalidAction)',
      );
    });

    it('a truncated wasm header is WasmVm/InvalidAction, not a panic', () => {
      const truncated = ADD_I32.slice(0, 4); // just "\0asm"
      const sim = L.simulate(uploadWasmHostFn(truncated), source);
      expect(fmt(returnedError(sim, 'truncated wasm'))).toBe('Error(WasmVm, InvalidAction)');
    });

    it('a wasm with a clobbered magic number is WasmVm/InvalidAction', () => {
      const corrupted = Uint8Array.from(ADD_I32);
      corrupted[1] ^= 0xff; // "\0asm" -> "\0<garbage>sm"
      const sim = L.simulate(uploadWasmHostFn(corrupted), source);
      expect(fmt(returnedError(sim, 'clobbered magic'))).toBe('Error(WasmVm, InvalidAction)');
    });

    it('an over-deep ScVal argument is Value/InvalidInput', () => {
      // DEFAULT_HOST_DEPTH_LIMIT = 100 (budget/limits.rs:41).
      const addr = deploy(CONTRACT_STORAGE);
      let deep: xdr.ScVal = xdr.ScVal.scvU32(1);
      for (let i = 0; i < 200; i++) deep = xdr.ScVal.scvVec([deep]);

      const err = thrownError(
        () => L.simulate(invokeHostFn(addr, 'put_persistent', [deep, u64(1n)]), source),
        'deep ScVal',
      );
      expect(fmt(err)).toBe('Error(Value, InvalidInput)');
    });

    it('malformed XDR is a raw JsError, distinguishable from a HostError', () => {
      // Not a fidelity problem in itself -- stellar-core would never let malformed
      // XDR reach the host -- but a harness user has to know these are a different
      // species of failure with no Error(Type, Code) in them at all.
      const hostFn = uploadWasmHostFn(ADD_I32);

      const notBase64 = () => L.send(hostFn, source, '!!!not-xdr!!!', [], []);
      expect(notBase64).toThrow();
      expect(() => notBase64()).toThrow(/base64 decode/);

      // Valid base64, wrong XDR type entirely.
      const wrongType = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: accountIdFromPublicKey(kp.publicKey()) }),
      ).toXDR('base64');
      expect(() => L.send(hostFn, source, wrongType, [], [])).toThrow(/xdr:/);

      // None of these carry a host error code.
      let msg = '';
      try {
        L.send(hostFn, source, wrongType, [], []);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(HOST_ERROR_RE.test(msg)).toBe(false);
    });

    it('an oversized junk upload is rejected as WasmVm/InvalidAction, not by a size limit', () => {
      // DEFAULT_XDR_RW_LIMITS.len is 32 MiB (budget/limits.rs:31); 200 KB of zeros
      // is well inside it, so the rejection comes from the wasm parser.
      const sim = L.simulate(uploadWasmHostFn(new Uint8Array(200_000)), source);
      expect(fmt(returnedError(sim, '200KB junk'))).toBe('Error(WasmVm, InvalidAction)');
    });
  });
});
