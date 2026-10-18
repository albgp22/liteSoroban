/**
 * The enforcing path hands the host a module cache, as stellar-core does.
 *
 * Without one, every applied invocation re-parses its Wasm at the full
 * `VmInstantiation` price while recording mode charges the cached price to its
 * shadow budget, so the applied count came out 70-190% above the recorded one
 * (and +220% on a custom account's `__check_auth`). Measured against a live
 * protocol-29 node the applied count now matches `core_metrics` to within 0.1%.
 *
 * These assertions are RATIOS of applied to recorded CPU, not absolute counts:
 * a ratio does not move when the host's cost model does, and the no-cache
 * defect was a ratio of 1.7-2.9. A live node's ratio is 0.99-1.00.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, nativeToScVal, Keypair } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../src/index.js';
import { authorizeAndSend, smartAccountEd25519 } from '../src/auth.js';
import { PROTOCOL_27_COST_PARAMS } from '../src/cost-params.js';

const fixture = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const CONTRACT_DATA = fixture('contract_data.wasm');
const INVOKE_CONTRACT = fixture('invoke_contract.wasm');
const SMART = fixture('smart_account.wasm');

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i32 = (n: number) => nativeToScVal(n, { type: 'i32' });

/** applied / recorded. 1.0 means the enforcing pass cost what the simulation said. */
const ratio = (sim: { instructions: number }, sent: { cpuInsns: bigint }) =>
  Number(sent.cpuInsns) / sim.instructions;

describe('the enforcing path has a module cache', () => {
  let L: Ledger;
  let source: string;

  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
  });

  function deploy(code: Uint8Array, salt: number, ctor: xdr.ScVal[] = []) {
    const hash = L.seedWasm(code);
    const hf = createContractHostFn(source, hash, Buffer.alloc(32, salt), ctor);
    const sim = L.simulate(hf, source);
    expect(sim.ok, `deploy simulation: ${sim.error}`).toBe(true);
    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `deploy: ${sent.error}`).toBe(true);
    return {
      addr: xdr.expectUnionVariant(xdr.ScVal.fromXdr(sent.returnValueXdr!, 'base64'), 'scvAddress').address,
      hash,
      deployRatio: ratio(sim, sent),
    };
  }

  function call(addr: xdr.ScAddress, fn: string, args: xdr.ScVal[]) {
    const hf = invokeHostFn(addr, fn, args);
    const sim = L.simulate(hf, source);
    expect(sim.ok, `${fn} simulation: ${sim.error}`).toBe(true);
    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    return { sim, sent, hf };
  }

  it('an applied deploy and invocation cost what their simulation recorded', () => {
    const { addr, deployRatio } = deploy(CONTRACT_DATA, 1);
    expect(deployRatio).toBeGreaterThan(0.97);
    expect(deployRatio).toBeLessThan(1.03);

    const put = call(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const get = call(addr, 'get_persistent', [sym('k')]);
    expect(put.sent.ok, put.sent.error).toBe(true);
    for (const { sim, sent } of [put, get]) {
      expect(ratio(sim, sent)).toBeGreaterThan(0.97);
      expect(ratio(sim, sent)).toBeLessThan(1.03);
    }
  });

  it('holds across a cross-contract call, where two modules are instantiated', () => {
    const a = deploy(INVOKE_CONTRACT, 2).addr;
    const b = deploy(INVOKE_CONTRACT, 3).addr;
    const { sim, sent } = call(a, 'add_with', [i32(3), i32(4), xdr.ScVal.scvAddress(b)]);
    expect(sent.ok, sent.error).toBe(true);
    expect(ratio(sim, sent)).toBeGreaterThan(0.97);
    expect(ratio(sim, sent)).toBeLessThan(1.03);
  });

  it('holds for a custom account: __check_auth was +220% without the cache', async () => {
    const admin = Keypair.random();
    const signer = (k: Keypair) =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Ed25519'),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('public_key'),
            val: xdr.ScVal.scvBytes(k.rawPublicKey()),
          }),
        ]),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Admin')]),
      ]);
    const account = deploy(SMART, 4, [xdr.ScVal.scvVec([signer(admin)]), xdr.ScVal.scvVec([])]).addr;
    const hf = invokeHostFn(account, 'add_signer', [signer(Keypair.random())]);
    const { enforced, sent } = await authorizeAndSend(L, hf, source, {
      sign: smartAccountEd25519(admin),
    });
    expect(sent.ok, sent.error).toBe(true);
    expect(ratio(enforced, sent)).toBeGreaterThan(0.97);
    expect(ratio(enforced, sent)).toBeLessThan(1.03);
  });

  it('a second call reuses the parsed module instead of paying to parse again', () => {
    const { addr } = deploy(CONTRACT_DATA, 5);
    expect(call(addr, 'put_persistent', [sym('k'), u64(1n)]).sent.ok).toBe(true);
    const first = call(addr, 'get_persistent', [sym('k')]);
    const second = call(addr, 'get_persistent', [sym('k')]);
    expect(first.sent.ok, first.sent.error).toBe(true);
    expect(Number(second.sent.cpuInsns)).toBe(Number(first.sent.cpuInsns));
  });

  describe('archival', () => {
    it('code a transaction restores is billed its full parse, not served from the cache', () => {
      const { addr } = deploy(CONTRACT_DATA, 6);
      const warm = call(addr, 'put_persistent', [sym('k'), u64(1n)]);
      expect(warm.sent.ok, warm.sent.error).toBe(true);

      // past the TTL of the instance, the code and the data entry
      L.advanceLedgers(150_000);
      const restoring = call(addr, 'get_persistent', [sym('k')]);
      expect(restoring.sim.restoredRwEntryIndices.length).toBe(3);
      expect(restoring.sent.ok, restoring.sent.error).toBe(true);

      // The cache held this module from the warm call. If the restore had left it
      // in, the applied count would sit ~0.8M below the recorded one; the node
      // cannot have cached an archived entry, so it parses during execution.
      expect(ratio(restoring.sim, restoring.sent)).toBeGreaterThan(0.97);
      expect(ratio(restoring.sim, restoring.sent)).toBeLessThan(1.03);
      expect(Number(restoring.sent.cpuInsns)).toBeGreaterThan(2 * Number(warm.sent.cpuInsns));

      // ...and the next call finds the module cached again.
      const after = call(addr, 'get_persistent', [sym('k')]);
      expect(after.sim.restoredRwEntryIndices).toEqual([]);
      expect(Number(after.sent.cpuInsns)).toBeLessThan(0.5 * Number(restoring.sent.cpuInsns));
    });
  });

  describe('the cache is not ledger state', () => {
    it('code removed from the ledger is not resurrected from the cache', () => {
      const { addr, hash } = deploy(CONTRACT_DATA, 7);
      const { sent: warm } = call(addr, 'put_persistent', [sym('k'), u64(1n)]);
      expect(warm.ok, warm.error).toBe(true); // the module is now cached

      const hf = invokeHostFn(addr, 'get_persistent', [sym('k')]);
      const sim = L.simulate(hf, source);
      expect(sim.ok, sim.error).toBe(true);

      const codeKey = xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, 'base64') }),
      ).toXdr('base64');
      expect(L.removeEntry(codeKey)).toBe(true);

      const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
      expect(sent.ok).toBe(false);
      expect(sent.error).toMatch(/Storage/);
    });

    it('snapshot() and restore() round-trip through a cached contract', () => {
      const before = L.snapshot();
      const { addr } = deploy(CONTRACT_DATA, 8);
      expect(call(addr, 'put_persistent', [sym('k'), u64(1n)]).sent.ok).toBe(true);

      L.restore(before);
      expect(L.entryCount()).toBe(1);

      // Same bytes, same salt, same address: a redeploy must work and cost the same.
      const again = deploy(CONTRACT_DATA, 8);
      expect(again.addr.toXdr('base64')).toBe(addr.toXdr('base64'));
      expect(again.deployRatio).toBeGreaterThan(0.97);
      expect(again.deployRatio).toBeLessThan(1.03);
      const { sent } = call(again.addr, 'put_persistent', [sym('k'), u64(2n)]);
      expect(sent.ok, sent.error).toBe(true);
    });

    it('contract code the host cannot parse is left out of the cache and fails in the host', () => {
      const { addr } = deploy(CONTRACT_DATA, 9);
      const hf = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
      const sim = L.simulate(hf, source);
      expect(sim.ok, sim.error).toBe(true);

      // A second ledger with the same state, except that the contract's code is not
      // a Wasm module. It starts with an empty cache, so `send` has to try to
      // parse it. (seedWasm validates, hence the copy; a real network cannot hold
      // such an entry either.)
      const garbage = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xff]);
      const L2 = new Ledger();
      for (const key of L.allKeys()) {
        let entry = xdr.LedgerEntry.fromXdr(L.getEntry(key)!, 'base64');
        if (entry.data.type === 'contractCode') {
          const code = entry.data.contractCode;
          entry = new xdr.LedgerEntry({
            lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
            data: xdr.LedgerEntryData.contractCode(
              new xdr.ContractCodeEntry({ ext: xdr.ContractCodeEntryExt.v0(), hash: code.hash, code: garbage }),
            ),
            ext: entry.ext,
          });
        }
        L2.putEntry(entry.toXdr('base64'), L.getEntryTtl(key));
      }

      // The parse of these bytes is not in the declared count, which was recorded
      // for the valid code; leave the count unenforced so the host's own error
      // is the one reported.
      L2.enforceDeclaredResources(false);
      let sent: ReturnType<Ledger['send']> | undefined;
      expect(() => {
        sent = L2.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
      }).not.toThrow();
      expect(sent!.ok).toBe(false);
      expect(sent!.error).toMatch(/WasmVm/);
    });
  });
});

describe('the declared instruction count is enforced by default', () => {
  // With no module cache the enforcing pass cost 1.7-2.9x what was recorded, so
  // enforcing the declared (recorded + 4%) count failed every deploy with
  // Error(Budget, ExceededLimit) and the harness shipped with it off.
  let L: Ledger;
  let source: string;
  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
  });

  const withInstructions = (resourcesXdr: string, n: number) => {
    const r = xdr.SorobanResources.fromXdr(resourcesXdr, 'base64');
    return new xdr.SorobanResources({ ...r, instructions: n }).toXdr('base64');
  };

  function deployData() {
    const hf = createContractHostFn(source, L.seedWasm(CONTRACT_DATA), Buffer.alloc(32, 1));
    const sim = L.simulate(hf, source);
    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, `deploy under the declared count: ${sent.error}`).toBe(true);
    return {
      sim, sent,
      addr: xdr.expectUnionVariant(xdr.ScVal.fromXdr(sent.returnValueXdr!, 'base64'), 'scvAddress').address,
    };
  }

  it('deploys and invocations fit under the count they declared', () => {
    const deployed = deployData();
    const hf = invokeHostFn(deployed.addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim = L.simulate(hf, source);
    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    for (const { sim: s, sent: r } of [deployed, { sim, sent }]) {
      expect(Number(r.cpuInsns)).toBeLessThan(s.adjustedInstructions);
    }
  });

  it('a transaction that under-declares fails with Budget and commits nothing', () => {
    const { addr } = deployData();
    const hf = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim = L.simulate(hf, source);
    const tiny = withInstructions(sim.resourcesXdr, 1_000);

    const before = L.stateHash();
    const sent = L.send(hf, source, tiny, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('Budget');
    expect(L.stateHash()).toBe(before);

    // the same bytes go through once the declared count is not enforced
    L.enforceDeclaredResources(false);
    const lenient = L.send(hf, source, tiny, sim.authXdr, sim.restoredRwEntryIndices);
    expect(lenient.ok, lenient.error).toBe(true);
  });

  it('the configured cpuLimit still bounds send when the declared count is larger', () => {
    const { addr } = deployData();
    const hf = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
    const sim = L.simulate(hf, source);
    expect(sim.adjustedInstructions).toBeGreaterThan(10_000);

    L.setCostParams(
      PROTOCOL_27_COST_PARAMS.cpuInstructions,
      PROTOCOL_27_COST_PARAMS.memoryBytes,
      10_000n,
      41_943_040n,
    );
    const sent = L.send(hf, source, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('Budget');
  });
});
