/**
 * ROUND-2 ADVERSARIAL RE-TEST of the round-1 signature fix.
 *
 * Round 1 rewrote `checkSignature` in src/classic.ts, with this claim in its
 * doc comment:
 *
 *   "every `return true` in core sits INSIDE the loop over the transaction's
 *    signatures"
 *
 * Ground truth, core-src/src/transactions/SignatureChecker.cpp:70-85, is that
 * the PRE_AUTH_TX loop is a SEPARATE loop over the account's SIGNERS, run
 * BEFORE `verifyAll`, and it can `return true` with zero signatures present:
 *
 *   for (auto const& signerKey : signers[SIGNER_KEY_TYPE_PRE_AUTH_TX])
 *       if (signerKey.key.preAuthTx() == mContentsHash) {
 *           totalWeight += w;
 *           if (totalWeight >= neededWeight) return true;   // <- no signature
 *       }
 *
 * The port `continue`s past every non-ed25519 signer, so a PRE_AUTH_TX signer
 * contributes nothing and a legitimately pre-authorized transaction is rejected
 * with txBAD_AUTH.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import {
  accountIdFromPublicKey,
  loadAccount,
  storeAccount,
  checkSignature,
  BASE_FEE,
} from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const NET = Networks.TESTNET;
const NETWORK_ID = sha256(NET);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');
const plain = (pk: string) => xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
const RESOURCE_FEE = 500_000n;

function txHash(raw: xdr.Transaction): Buffer {
  return sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
    }).toXDR(),
  );
}
const envelope = (raw: xdr.Transaction, sigs: xdr.DecoratedSignature[]) =>
  xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: raw, signatures: sigs }),
  ).toXDR('base64');

describe('ROUND 2 — checkSignature port vs SignatureChecker.cpp', () => {
  let L: Ledger;
  let addr: xdr.ScAddress;
  let RESOURCES: xdr.SorobanResources;

  const hostFn = () => invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);

  const rawTx = (source: string, seqNum: bigint, opSource?: string) =>
    new xdr.Transaction({
      sourceAccount: plain(source),
      fee: Number(RESOURCE_FEE + BigInt(BASE_FEE)),
      seqNum: new xdr.SequenceNumber(new xdr.Int64(seqNum)),
      cond: xdr.Preconditions.precondNone(),
      memo: xdr.Memo.memoNone(),
      operations: [
        new xdr.Operation({
          sourceAccount: opSource ? plain(opSource) : null,
          body: xdr.OperationBody.invokeHostFunction(
            new xdr.InvokeHostFunctionOp({ hostFunction: hostFn(), auth: [] }),
          ),
        }),
      ],
      ext: new xdr.TransactionExt(
        1,
        new xdr.SorobanTransactionData({
          ext: new xdr.SorobanTransactionDataExt(0),
          resources: RESOURCES,
          resourceFee: new xdr.Int64(RESOURCE_FEE),
        }),
      ),
    });

  beforeEach(() => {
    L = new Ledger();
    const deployer = Keypair.random();
    L.fund(deployer.publicKey());
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(
      createContractHostFn(accB64(deployer.publicKey()), wasmHash),
      accB64(deployer.publicKey()),
    );
    addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
    const sim = L.simulate(hostFn(), accB64(deployer.publicKey()));
    RESOURCES = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
  });

  // -- the part that DID hold ------------------------------------------------

  it('HOLDS: a completely unsigned transaction is rejected even at threshold 0', () => {
    const a = Keypair.random();
    L.fund(a.publicKey()); // thresholds [1,0,0,0]
    const out = L.sendTransaction(envelope(rawTx((a.publicKey()), 1n), []));
    expect(out.code).toBe('txBAD_AUTH');
  });

  it('HOLDS: checkSignature() returns false for an empty signature list at neededWeight 0', () => {
    const a = Keypair.random();
    L.fund(a.publicKey());
    const acct = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
    expect(checkSignature(acct, [], Buffer.alloc(32), 0)).toBe(false);
  });

  // -- the part that did NOT ------------------------------------------------

  it('DEFECT: a PRE_AUTH_TX signer contributes no weight, so a pre-authorized tx is rejected', () => {
    // stellar-core: SignatureChecker.cpp:70-85. The preAuthTx signer whose key
    // equals the transaction's contents hash is worth its full weight, WITHOUT
    // any decorated signature. This is the whole mechanism behind
    // "pre-authorized transactions" (SetOptions with a preAuthTx signer).
    const a = Keypair.random();
    // master weight 0 -> the master key is not a signer at all; the ONLY way to
    // authorize is the pre-auth signer.
    L.fund(a.publicKey(), { thresholds: [0, 1, 1, 1] });

    const raw = rawTx((a.publicKey()), 1n);
    const contentsHash = txHash(raw);

    // Install the pre-auth signer by rewriting the AccountEntry directly.
    const acct = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
    acct.signers([
      new xdr.Signer({
        key: xdr.SignerKey.signerKeyTypePreAuthTx(contentsHash),
        weight: 1,
      }),
    ]);
    storeAccount(L, acct);

    // Sanity: the signer really is in the ledger, keyed by this exact hash.
    const reread = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
    expect(reread.signers()).toHaveLength(1);
    expect(reread.signers()[0].key().switch().name).toBe('signerKeyTypePreAuthTx');
    expect(Buffer.from(reread.signers()[0].key().preAuthTx()).equals(contentsHash)).toBe(true);

    // core: totalWeight 1 >= neededWeight 1 -> return true, tx applies.
    const out = L.sendTransaction(envelope(raw, []));
    expect(out.code, `harness said ${out.code} / ${out.detail}`).toBe('txSUCCESS');
  });

  it('DEFECT: a HASH_X signer contributes no weight either (verifyAll group 1 is unported)', () => {
    // SignatureChecker.cpp:120-124 runs verifyAll over SIGNER_KEY_TYPE_HASH_X
    // BEFORE the ed25519 group, and totalWeight is shared across the groups.
    const a = Keypair.random();
    L.fund(a.publicKey(), { thresholds: [0, 1, 1, 1] });

    const preimage = Buffer.alloc(32, 9);
    const x = sha256(preimage);
    const acct = loadAccount(L, accountIdFromPublicKey(a.publicKey()))!;
    acct.signers([
      new xdr.Signer({ key: xdr.SignerKey.signerKeyTypeHashX(x), weight: 1 }),
    ]);
    storeAccount(L, acct);

    const raw = rawTx((a.publicKey()), 1n);
    // SignatureUtils::verifyHashX: hint = last 4 bytes of sha256(preimage),
    // signature = the preimage itself.
    const sig = new xdr.DecoratedSignature({
      hint: x.subarray(28),
      signature: preimage,
    });
    const out = L.sendTransaction(envelope(raw, [sig]));
    expect(out.code, `harness said ${out.code} / ${out.detail}`).toBe('txSUCCESS');
  });

  it('DEFECT: master weight 0 is treated as a weight-0 SIGNER, not as "not a signer"', () => {
    // TransactionFrame.cpp:456-461 -- `if (acc.thresholds[0])` gates pushing the
    // master key into the signer vector at all. With masterWeight 0 the master
    // signature matches NOTHING, verifyAll returns false, and checkSignature
    // returns false. The port always pushes the master candidate with weight 0,
    // so the match succeeds, total stays 0, and `0 >= 0` returns TRUE.
    const a = Keypair.random();
    const co = Keypair.random();
    L.fund(a.publicKey(), {
      thresholds: [0, 0, 0, 0],
      signers: [{ key: co.publicKey(), weight: 1 }],
    });

    const raw = rawTx((a.publicKey()), 1n);
    const out = L.sendTransaction(envelope(raw, [a.signDecorated(txHash(raw))]));
    // core: the weight-0 master key is not a signer -> txBAD_AUTH.
    expect(out.code, `harness said ${out.code}`).toBe('txBAD_AUTH');
  });

  it('CONTEXT: weight clamping to UINT8_MAX is unreachable, so its absence is harmless', () => {
    // thresholds[] is a 4-BYTE array, so neededWeight <= 255 always. A single
    // signer whose weight core clamps to 255 still satisfies any threshold, so
    // the clamp can never change an accept/reject decision.
    const a = Keypair.random();
    const co = Keypair.random();
    L.fund(a.publicKey(), {
      thresholds: [0, 255, 255, 255],
      signers: [{ key: co.publicKey(), weight: 100_000 }],
    });
    const raw = rawTx((a.publicKey()), 1n);
    const out = L.sendTransaction(envelope(raw, [co.signDecorated(txHash(raw))]));
    expect(out.code).toBe('txSUCCESS'); // clamped 255 >= 255 in core too
  });
});
