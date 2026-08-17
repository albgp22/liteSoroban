import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import {
  Ledger,
  HOST_PROTOCOL,
  createContractHostFn,
  invokeHostFn,
} from '../src/index.js';

const CONTRACT_DATA = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });

/** Deploy contract_data.wasm and return its ScAddress. */
function deploy(L: Ledger, source: string): xdr.ScAddress {
  const wasmHash = L.seedWasm(CONTRACT_DATA);
  const { sent } = L.simulateAndSend(createContractHostFn(source, wasmHash), source);
  expect(sent.ok, `deploy failed: ${sent.error}`).toBe(true);
  return xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
}

describe('in-process Soroban ledger (wasm host)', () => {
  let L: Ledger;
  let source: string;

  beforeEach(() => {
    L = new Ledger();
    source = L.fundAccount(1);
  });

  it('reports the protocol it actually implements', () => {
    expect(HOST_PROTOCOL).toBe(27);
    expect(L.protocolVersion).toBe(27);
    // A harness pinned to the wrong protocol must refuse to start.
    expect(() => new Ledger({ protocolVersion: 28 })).toThrow(/protocol 27/);
  });

  it('req 5: seeds a funded account with no network', () => {
    expect(L.entryCount()).toBe(1);
    const account = xdr.AccountId.fromXDR(source, 'base64');
    expect(account.switch().name).toBe('publicKeyTypeEd25519');
  });

  it('req 3: deploys a contract and invokes it', () => {
    const addr = deploy(L, source);
    expect(addr.switch().name).toBe('scAddressTypeContract');

    const { sim, sent } = L.simulateAndSend(
      invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(42n)]),
      source,
    );
    expect(sent.ok, sent.error).toBe(true);
    // Simulation produced a real footprint, not a fabricated one.
    expect(sim.readWriteKeys.length).toBeGreaterThan(0);
    expect(sim.instructions).toBeGreaterThan(0);
  });

  it('req 1+2: state written by send() is visible to a LATER simulate()', () => {
    const addr = deploy(L, source);

    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(42n)]), source);

    // A completely separate transaction, reading through the snapshot source.
    const read = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('ctr')]), source);
    expect(read.ok, read.error).toBe(true);
    expect(scValToNative(xdr.ScVal.fromXDR(read.returnValueXdr!, 'base64'))).toBe(42n);
  });

  it('req 1: overwriting state through a second transaction works', () => {
    const addr = deploy(L, source);
    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(1n)]), source);
    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(999n)]), source);

    const read = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('ctr')]), source);
    expect(scValToNative(xdr.ScVal.fromXDR(read.returnValueXdr!, 'base64'))).toBe(999n);
  });

  it('the apply path ENFORCES the footprint (not just records it)', () => {
    const addr = deploy(L, source);
    const hostFn = invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(7n)]);
    const sim = L.simulate(hostFn, source);
    expect(sim.ok).toBe(true);

    // Strip the footprint that simulation computed. Enforcing mode must refuse.
    const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    resources.footprint(new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }));

    let succeeded = false;
    try {
      const sent = L.send(hostFn, source, resources.toXDR('base64'), sim.authXdr, []);
      succeeded = sent.ok;
    } catch {
      succeeded = false;
    }
    expect(succeeded, 'empty footprint must not be accepted by the enforcing path').toBe(false);
  });

  it('req 4: snapshot/restore rolls the whole ledger back', () => {
    const addr = deploy(L, source);
    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(1n)]), source);

    const snap = L.snapshot();
    const before = L.entryCount();

    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('other'), u64(5n)]), source);
    expect(L.entryCount()).toBeGreaterThan(before);

    L.restore(snap);
    expect(L.entryCount()).toBe(before);

    // The rolled-back key is gone...
    const gone = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('other')]), source);
    expect(gone.ok).toBe(false);
    // ...and the surviving one still reads.
    const kept = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('ctr')]), source);
    expect(scValToNative(xdr.ScVal.fromXDR(kept.returnValueXdr!, 'base64'))).toBe(1n);
  });

  it('req 4: each test starts from a clean ledger', () => {
    // beforeEach built a fresh Ledger; nothing from earlier tests survives.
    expect(L.entryCount()).toBe(1);
  });

  it('contract errors surface as failures without killing the instance', () => {
    const addr = deploy(L, source);
    const missing = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('nope')]), source);
    expect(missing.ok).toBe(false);

    // The very same Ledger keeps working afterwards.
    L.simulateAndSend(invokeHostFn(addr, 'put_persistent', [sym('ok'), u64(3n)]), source);
    const after = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('ok')]), source);
    expect(scValToNative(xdr.ScVal.fromXDR(after.returnValueXdr!, 'base64'))).toBe(3n);
  });
});
