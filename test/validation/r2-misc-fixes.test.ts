/**
 * ROUND-2 ADVERSARIAL RE-TEST of round-1 fixes 3, 4, 7, 8, 9, 10.
 *
 * Ground truth cited per test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr, Keypair, Networks, StrKey, Asset, nativeToScVal, hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { LiteStellar, XLM } from '../../src/litestellar.js';
import { accountIdFromPublicKey, loadAccount, availableBalance, BASE_FEE, BASE_RESERVE } from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const NETWORK_ID = sha256(Networks.TESTNET);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');
const plain = (pk: string) => xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
const RESOURCE_FEE = 2_000_000n;

function scaffold(L: Ledger) {
  const deployer = Keypair.random();
  L.fund(deployer.publicKey());
  const wasmHash = L.seedWasm(CODE);
  const { sent } = L.simulateAndSend(
    createContractHostFn(accB64(deployer.publicKey()), wasmHash),
    accB64(deployer.publicKey()),
  );
  const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  const hostFn = invokeHostFn(addr, 'put_persistent', [sym('k'), u64(1n)]);
  const sim = L.simulate(hostFn, accB64(deployer.publicKey()));
  return { addr, hostFn, resources: xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64') };
}

function rawFor(kp: Keypair, seqNum: bigint, hostFn: xdr.HostFunction, resources: xdr.SorobanResources) {
  return new xdr.Transaction({
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
      new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(0),
        resources,
        resourceFee: new xdr.Int64(RESOURCE_FEE),
      }),
    ),
  });
}
const txHash = (raw: xdr.Transaction) =>
  sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
    }).toXDR(),
  );
const signed = (raw: xdr.Transaction, kps: Keypair[]) =>
  xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: raw, signatures: kps.map((k) => k.signDecorated(txHash(raw))) }),
  ).toXDR('base64');

function feeBump(feeSource: Keypair, fee: bigint, innerB64: string, kps: Keypair[]): string {
  const innerV1 = xdr.TransactionEnvelope.fromXDR(innerB64, 'base64').v1();
  const fbTx = new xdr.FeeBumpTransaction({
    feeSource: plain(feeSource.publicKey()),
    fee: new xdr.Int64(fee),
    innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(innerV1),
    ext: new xdr.FeeBumpTransactionExt(0),
  });
  const h = sha256(
    new xdr.TransactionSignaturePayload({
      networkId: NETWORK_ID,
      taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(fbTx),
    }).toXDR(),
  );
  return xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({ tx: fbTx, signatures: kps.map((k) => k.signDecorated(h)) }),
  ).toXDR('base64');
}

// ===========================================================================
describe('ROUND 2 — fix 3: seqNum == ledgerSeq << 32', () => {
  it('HOLDS: rejected on the plain path', () => {
    const L = new Ledger();
    const { hostFn, resources } = scaffold(L);
    const start = BigInt(L.ledgerSeq) << 32n;
    const a = Keypair.random();
    L.fund(a.publicKey(), { seqNum: start - 1n });
    expect(L.sendTransaction(signed(rawFor(a, start, hostFn, resources), [a])).code).toBe('txBAD_SEQ');
  });

  it('HOLDS: still rejected with sequenceCheck turned OFF', () => {
    const svm = new LiteStellar().withSequenceCheck(false);
    const { hostFn, resources } = scaffold(svm.ledger);
    const start = BigInt(svm.ledgerSequence) << 32n;
    const a = Keypair.random();
    svm.ledger.fund(a.publicKey(), { seqNum: 0n });
    expect(svm.sendTransaction(signed(rawFor(a, start, hostFn, resources), [a])).code).toBe('txBAD_SEQ');
  });

  it('HOLDS: still rejected inside a fee bump', () => {
    const L = new Ledger();
    const { hostFn, resources } = scaffold(L);
    const start = BigInt(L.ledgerSeq) << 32n;
    const a = Keypair.random();
    const payer = Keypair.random();
    L.fund(a.publicKey(), { seqNum: start - 1n });
    L.fund(payer.publicKey());
    const inner = signed(rawFor(a, start, hostFn, resources), [a]);
    const out = L.sendTransaction(feeBump(payer, RESOURCE_FEE + 200n, inner, [payer]));
    expect(out.innerCode).toBe('txBAD_SEQ');
  });
});

// ===========================================================================
describe('ROUND 2 — fix 4: fee bump fee source checked against LOW', () => {
  // FeeBumpTransactionFrame.cpp:257-268:
  //   checkSignature(feeSource, feeSource.thresholds[THRESHOLD_LOW])
  let L: Ledger;
  let hostFn: xdr.HostFunction;
  let resources: xdr.SorobanResources;
  let inner: Keypair;

  beforeEach(() => {
    L = new Ledger();
    ({ hostFn, resources } = scaffold(L));
    inner = Keypair.random();
    L.fund(inner.publicKey());
  });

  it('HOLDS: a fee bump signed below the fee source LOW threshold is txBAD_AUTH', () => {
    const payer = Keypair.random();
    L.fund(payer.publicKey(), { thresholds: [1, 5, 0, 0] }); // master 1 < low 5
    const innerEnv = signed(rawFor(inner, 1n, hostFn, resources), [inner]);
    const out = L.sendTransaction(feeBump(payer, RESOURCE_FEE + 200n, innerEnv, [payer]));
    expect(out.code).toBe('txBAD_AUTH');
  });

  it('HOLDS: LOW is used, not MEDIUM — low 0 / medium 5 still passes', () => {
    const payer = Keypair.random();
    L.fund(payer.publicKey(), { thresholds: [1, 0, 5, 5] }); // master 1 >= low 0
    const innerEnv = signed(rawFor(inner, 1n, hostFn, resources), [inner]);
    const out = L.sendTransaction(feeBump(payer, RESOURCE_FEE + 200n, innerEnv, [payer]));
    expect(out.code, out.detail).toBe('txFEE_BUMP_INNER_SUCCESS');
  });

  it('HOLDS: an unsigned fee bump is rejected even at LOW 0', () => {
    const payer = Keypair.random();
    L.fund(payer.publicKey(), { thresholds: [1, 0, 0, 0] });
    const innerEnv = signed(rawFor(inner, 1n, hostFn, resources), [inner]);
    const out = L.sendTransaction(feeBump(payer, RESOURCE_FEE + 200n, innerEnv, []));
    expect(out.code).toBe('txBAD_AUTH');
  });
});

// ===========================================================================
describe('ROUND 2 — fix 7: snapshot/restore covers the clock and the PRNG', () => {
  it('HOLDS: ledgerSeq, timestamp and the auth nonce all roll back', () => {
    const L = new Ledger();
    const { addr } = scaffold(L);
    const src = accB64(Keypair.random().publicKey());

    const seq0 = L.ledgerSeq;
    const ts0 = L.timestamp;
    const snap = L.snapshot();

    L.advanceLedgers(1234);
    L.setTimestamp(ts0 + 999_999);
    // burn PRNG draws
    for (let i = 0; i < 5; i++) L.simulate(invokeHostFn(addr, 'get_persistent', [sym('nope')]), src);

    expect(L.ledgerSeq).toBe(seq0 + 1234);
    expect(L.timestamp).toBe(ts0 + 999_999);

    L.restore(snap);
    expect(L.ledgerSeq).toBe(seq0);
    expect(L.timestamp).toBe(ts0);
  });

  it('HOLDS: the recording-auth nonce sequence is byte-identical after a restore', () => {
    // A non-source-account auth is required for a nonce to appear at all.
    const L = new Ledger();
    const wasmHash = L.seedWasm(
      new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/auth_test_contract.wasm', import.meta.url)))),
    );
    const dep = Keypair.random();
    L.fund(dep.publicKey());
    const { sent } = L.simulateAndSend(createContractHostFn(accB64(dep.publicKey()), wasmHash), accB64(dep.publicKey()));
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();

    const other = Keypair.random();
    L.fund(other.publicKey());
    const fn = invokeHostFn(addr, 'add_with_auth', [
      xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(accountIdFromPublicKey(other.publicKey()))),
      nativeToScVal(2, { type: 'u32' }),
      nativeToScVal(3, { type: 'u32' }),
    ]);

    const snap = L.snapshot();
    const before = L.simulate(fn, accB64(dep.publicKey())).authXdr;
    L.restore(snap);
    const after = L.simulate(fn, accB64(dep.publicKey())).authXdr;
    expect(after).toEqual(before);
  });
});

// ===========================================================================
describe('ROUND 2 — fix 8: isWallet() and contract recipients', () => {
  it('HOLDS: mint and transfer to a CONTRACT address work', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const c = svm.deployContract(CODE, { as: alice });
    const token = svm.deployToken({ code: 'TST' });

    expect(() => token.mint(c.address, 1_000n)).not.toThrow();
    expect(token.balanceOf(c.address)).toBe(1_000n);

    // ...and no trustline was fabricated for the contract, nor a sub-entry.
    const acct = svm.getAccount(token.issuer.publicKey)!;
    expect(acct.numSubEntries()).toBe(0);

    token.mint(alice, 500n);
    token.transfer(alice, c.address, 200n);
    expect(token.balanceOf(c.address)).toBe(1_200n);
    expect(token.balanceOf(alice)).toBe(300n);
  });

  it('HOLDS: xdr.ScAddress really lacks the two probed properties', () => {
    const contractAddr = xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32, 3));
    const accountAddr = xdr.ScAddress.scAddressTypeAccount(
      accountIdFromPublicKey(Keypair.random().publicKey()),
    );
    for (const a of [contractAddr, accountAddr]) {
      expect('address' in (a as any)).toBe(false);
      expect('accountIdB64' in (a as any)).toBe(false);
      // the old, broken probe would have returned true for BOTH arms:
      expect('accountId' in (a as any)).toBe(true);
    }
  });
});

// ===========================================================================
describe('ROUND 2 — fix 9: establishTrustline and numSubEntries', () => {
  it('HOLDS: a trustline raises numSubEntries and the minimum balance', () => {
    const svm = new LiteStellar();
    const holder = svm.airdrop(100n * XLM);
    const token = svm.deployToken({ code: 'TST' });

    const before = svm.getAccount(holder.publicKey)!;
    expect(before.numSubEntries()).toBe(0);
    const availBefore = availableBalance(before);

    svm.trust(holder, token.asset);

    const after = svm.getAccount(holder.publicKey)!;
    expect(after.numSubEntries()).toBe(1);
    expect(availableBalance(after)).toBe(availBefore - BigInt(BASE_RESERVE));
  });

  it('DEFECT: LiteStellar.trust() is not idempotent — it double-counts numSubEntries', () => {
    // core's ChangeTrustOpFrame increments numSubEntries only when it CREATES
    // the trustline (ChangeTrustOpFrame.cpp: addNumEntries on the create path).
    // `Token.trust()` guards with establishTrustlineIfMissing; the public
    // `LiteStellar.trust()` calls establishTrustline directly, so every repeat
    // call invents another base reserve of locked balance.
    const svm = new LiteStellar();
    const holder = svm.airdrop(100n * XLM);
    const token = svm.deployToken({ code: 'TST' });

    svm.trust(holder, token.asset);
    svm.trust(holder, token.asset);
    svm.trust(holder, token.asset);

    expect(svm.getAccount(holder.publicKey)!.numSubEntries()).toBe(1);
  });

  it('DEFECT (corollary): the phantom sub-entries lock real balance', () => {
    const svm = new LiteStellar();
    const holder = svm.airdrop(100n * XLM);
    const token = svm.deployToken({ code: 'TST' });
    svm.trust(holder, token.asset);
    const oneTrustline = availableBalance(svm.getAccount(holder.publicKey)!);
    for (let i = 0; i < 10; i++) svm.trust(holder, token.asset);
    expect(availableBalance(svm.getAccount(holder.publicKey)!)).toBe(oneTrustline);
  });
});

// ===========================================================================
describe('ROUND 2 — fix 6: expired TEMPORARY entries skipped from host inputs', () => {
  // crates/host-wasm/src/lib.rs `send`:
  //   if is_temporary(key) && live_until.map_or(false, |t| t < self.ledger_seq) { continue; }
  // Boundary from soroban-env-host-27.0.1/src/storage.rs:660 — live_until >= seq is LIVE.
  const tempKey = (c: xdr.ScAddress, k: string) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: c,
        key: sym(k),
        durability: xdr.ContractDataDurability.temporary(),
      }),
    ).toXDR('base64');

  function callTx(L: Ledger, addr: xdr.ScAddress, fn: string, args: xdr.ScVal[], src: string) {
    const h = invokeHostFn(addr, fn, args);
    const sim = L.simulate(h, src);
    expect(sim.ok, `${fn} sim: ${sim.error}`).toBe(true);
    const sent = L.send(h, src, sim.resourcesXdr, sim.authXdr, sim.restoredRwEntryIndices);
    return { sim, sent };
  }

  it('HOLDS: an expired temporary key in the ENFORCING footprint no longer poisons send()', () => {
    const L = new Ledger();
    const dep = Keypair.random();
    L.fund(dep.publicKey());
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(
      createContractHostFn(accB64(dep.publicKey()), wasmHash),
      accB64(dep.publicKey()),
    );
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
    const src = accB64(dep.publicKey());

    callTx(L, addr, 'put_temporary', [sym('t'), u64(7n)], src);
    expect(L.getEntryTtl(tempKey(addr, 't'))).toBe(L.ledgerSeq + 16 - 1);

    // Exactly at live_until: still LIVE, must be handed to the host.
    L.advanceLedgers(15);
    const live = callTx(L, addr, 'has_temporary', [sym('t')], src);
    expect(live.sent.ok, live.sent.error).toBe(true);

    // One ledger past: DEAD, must be dropped from the host inputs.
    L.advanceLedgers(1);
    const dead = callTx(L, addr, 'has_temporary', [sym('t')], src);
    expect(dead.sent.ok, `expired temp entry poisoned send: ${dead.sent.error}`).toBe(true);
  });
});

// ===========================================================================
describe('ROUND 2 — fix 10: getNetwork', () => {
  it('HOLDS: getNetwork returns the passphrase signatures are validated against', async () => {
    for (const pass of [Networks.TESTNET, Networks.PUBLIC, 'Standalone Network ; February 2017']) {
      const svm = new LiteStellar({ networkPassphrase: pass });
      const server = svm.rpcServer();
      const net = await server.getNetwork();
      expect(net.passphrase).toBe(pass);

      // and that passphrase really is the one the classic layer checks against
      const { hostFn, resources } = scaffold(svm.ledger);
      const a = Keypair.random();
      svm.ledger.fund(a.publicKey(), { thresholds: [1, 1, 1, 1] });
      const raw = rawFor(a, 1n, hostFn, resources);
      const h = sha256(
        new xdr.TransactionSignaturePayload({
          networkId: sha256(net.passphrase),
          taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(raw),
        }).toXDR(),
      );
      const env = xdr.TransactionEnvelope.envelopeTypeTx(
        new xdr.TransactionV1Envelope({ tx: raw, signatures: [a.signDecorated(h)] }),
      ).toXDR('base64');
      expect(svm.sendTransaction(env).code, `passphrase ${pass}`).toBe('txSUCCESS');
    }
  });
});
