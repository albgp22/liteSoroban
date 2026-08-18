/**
 * ROUND-2 ADVERSARIAL RE-TEST of the round-1 auto-restore fix
 * (crates/host-wasm/src/lib.rs, `send`: restored_live_until =
 *  ledger_seq + MIN_PERSISTENT_ENTRY_TTL - 1).
 *
 * The Rust half is right, and matches
 *   InvokeHostFunctionOpFrame.cpp:559-561
 *     restoredLiveUntilLedger = ledgerSeq + minPersistentTTL - 1
 *
 * But the fix is only reachable through `Ledger.send(..., restoredIndices)`.
 * The TRANSACTION path never supplies those indices:
 *
 *   src/classic.ts:469-475
 *     const sent = ledger.send(hostFn, invokerId..., auth..., []);   // <- []
 *
 * On the real network the indices are carried IN THE ENVELOPE, as
 * `SorobanTransactionData.ext.resourceExt.archivedSorobanEntries`
 * (InvokeHostFunctionOpFrame.cpp:1344-1362, TransactionFrame.cpp:950-990).
 * The harness parses `sorobanData` for the resource fee and the resources but
 * drops that field on the floor, so no transaction — and therefore nothing that
 * goes through `sendTransaction`, `LiteStellar.sendTransaction` or the fake RPC
 * `sendTransaction` — can ever auto-restore an archived entry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr, Keypair, Networks, StrKey, nativeToScVal, scValToNative, hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { accountIdFromPublicKey, BASE_FEE } from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const NETWORK_ID = sha256(Networks.TESTNET);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');
const plain = (pk: string) => xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
const RESOURCE_FEE = 5_000_000n;
const MIN_PERSISTENT_ENTRY_TTL = 100_000;

const persistentKey = (c: xdr.ScAddress, k: string) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: c,
      key: sym(k),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');

function envelopeFor(
  kp: Keypair,
  seqNum: bigint,
  hostFn: xdr.HostFunction,
  resources: xdr.SorobanResources,
  archived: number[] | null,
): string {
  const ext = archived
    ? new xdr.SorobanTransactionDataExt(
        1,
        new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archived }),
      )
    : new xdr.SorobanTransactionDataExt(0);
  const raw = new xdr.Transaction({
    sourceAccount: plain(kp.publicKey()),
    fee: Number(RESOURCE_FEE + BigInt(BASE_FEE)),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(seqNum)),
    cond: xdr.Preconditions.precondNone(),
    memo: xdr.Memo.memoNone(),
    operations: [
      new xdr.Operation({
        sourceAccount: null,
        body: xdr.OperationBody.invokeHostFunction(
          new xdr.InvokeHostFunctionOp({ hostFunction: hostFn, auth: [] }),
        ),
      }),
    ],
    ext: new xdr.TransactionExt(
      1,
      new xdr.SorobanTransactionData({ ext, resources, resourceFee: new xdr.Int64(RESOURCE_FEE) }),
    ),
  });
  const h = sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
    }).toXDR(),
  );
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: raw, signatures: [kp.signDecorated(h)] }),
  ).toXDR('base64');
}

describe('ROUND 2 — auto-restore through the envelope path', () => {
  let L: Ledger;
  let a: Keypair;
  let addr: xdr.ScAddress;

  beforeEach(() => {
    L = new Ledger();
    a = Keypair.random();
    L.fund(a.publicKey());
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(
      createContractHostFn(accB64(a.publicKey()), wasmHash),
      accB64(a.publicKey()),
    );
    addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  });

  it('HOLDS: the raw send() path auto-restores with the right live_until', () => {
    const put = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(42n)]);
    const s0 = L.simulate(put, accB64(a.publicKey()));
    expect(L.send(put, accB64(a.publicKey()), s0.resourcesXdr, s0.authXdr, s0.restoredRwEntryIndices).ok).toBe(true);

    L.advanceLedgers(150_000);
    const seq = L.ledgerSeq;

    const get = invokeHostFn(addr, 'get_persistent', [sym('k')]);
    const sim = L.simulate(get, accB64(a.publicKey()));
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBe(3);

    const sent = L.send(get, accB64(a.publicKey()), sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    expect(sent.ok, sent.error).toBe(true);
    expect(L.getEntryTtl(persistentKey(addr, 'k'))).toBe(seq + MIN_PERSISTENT_ENTRY_TTL - 1);
  });

  it('DEFECT: the same restore is impossible through sendTransaction(), even when the envelope declares archivedSorobanEntries', () => {
    const put = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(42n)]);
    const s0 = L.simulate(put, accB64(a.publicKey()));
    L.send(put, accB64(a.publicKey()), s0.resourcesXdr, s0.authXdr, s0.restoredRwEntryIndices);

    L.advanceLedgers(150_000);

    const get = invokeHostFn(addr, 'get_persistent', [sym('k')]);
    const sim = L.simulate(get, accB64(a.publicKey()));
    expect(sim.ok, sim.error).toBe(true);
    expect(sim.restoredRwEntryIndices.length).toBe(3);

    const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    // Exactly what a protocol-23+ client submits: the read-write footprint
    // indices of the archived entries, ascending.
    const archived = [...sim.restoredRwEntryIndices].sort((x, y) => x - y);
    const env = envelopeFor(a, 1n, get, resources, archived);

    // Sanity: the field really is on the wire.
    const roundTrip = xdr.TransactionEnvelope.fromXDR(env, 'base64').v1().tx().ext().sorobanData();
    expect(roundTrip.ext().switch()).toBe(1);
    expect(roundTrip.ext().resourceExt().archivedSorobanEntries()).toEqual(archived);

    const out = L.sendTransaction(env);
    expect(out.code, `harness said ${out.code}: ${out.error}`).toBe('txSUCCESS');
    expect(scValToNative(xdr.ScVal.fromXDR(out.returnValueXdr!, 'base64'))).toBe(42n);
  });

  it('CONTEXT: the failure mode is a host-level error, and fix #11 keeps it non-throwing', () => {
    // Fix 11 (Rust `send` catching a top-level Err) is what turns this into an
    // observable {ok:false} rather than a thrown JsError.
    const put = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(42n)]);
    const s0 = L.simulate(put, accB64(a.publicKey()));
    L.send(put, accB64(a.publicKey()), s0.resourcesXdr, s0.authXdr, s0.restoredRwEntryIndices);
    L.advanceLedgers(150_000);

    const get = invokeHostFn(addr, 'get_persistent', [sym('k')]);
    const sim = L.simulate(get, accB64(a.publicKey()));

    let sent: any;
    expect(() => {
      // restored indices deliberately dropped — the same thing classic.ts does.
      sent = L.send(get, accB64(a.publicKey()), sim.resourcesXdr, sim.authXdr, []);
    }).not.toThrow();
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Storage|InternalError|ttl|live/i);
  });
});
