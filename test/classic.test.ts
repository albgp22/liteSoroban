import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Memo,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../src/index.js';
import { attachInProcessRpc } from '../src/fake-rpc.js';
import { accountIdFromPublicKey, loadAccount } from '../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');

function build(account: any, func: xdr.HostFunction, fee = '1000') {
  return new TransactionBuilder(account, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(300)
    .build();
}

describe('classic layer: envelopes, sequence numbers, signatures, fees', () => {
  let L: Ledger;
  let server: rpc.Server;
  let kp: Keypair;
  let addr: xdr.ScAddress;

  beforeEach(() => {
    L = new Ledger();
    kp = Keypair.random();
    L.fund(kp.publicKey());

    server = new rpc.Server('https://in-process.invalid');
    attachInProcessRpc(server, L);

    // Deploy once, out of band, through the raw ledger API.
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(createContractHostFn(accB64(kp.publicKey()), wasmHash), accB64(kp.publicKey()));
    addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
  });

  it('runs the full submit-then-poll cycle through rpc.Server', async () => {
    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('ctr'), u64(42n)]));

    const sim = await server.simulateTransaction(tx);
    expect(rpc.Api.isSimulationSuccess(sim)).toBe(true);

    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(kp);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('PENDING');

    const got = await server.pollTransaction(sent.hash);
    expect(got.status).toBe('SUCCESS');

    // The value really landed in the ledger.
    const read = L.simulate(invokeHostFn(addr, 'get_persistent', [sym('ctr')]), accB64(kp.publicKey()));
    expect(scValToNative(xdr.ScVal.fromXDR(read.returnValueXdr!, 'base64'))).toBe(42n);
  });

  it('consumes the sequence number and charges the fee', async () => {
    const before = loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!;
    expect(before.seqNum().toString()).toBe('0');
    const balanceBefore = BigInt(before.balance().toString());

    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(kp);
    await server.sendTransaction(assembled);

    const after = loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!;
    expect(after.seqNum().toString()).toBe('1');
    expect(BigInt(after.balance().toString())).toBeLessThan(balanceBefore);
    expect(balanceBefore - BigInt(after.balance().toString())).toBe(BigInt(assembled.fee));
  });

  it('rejects a replayed sequence number with txBAD_SEQ', async () => {
    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(kp);

    const first = await server.sendTransaction(assembled);
    expect(first.status).toBe('PENDING');

    // Same envelope again: the sequence number is already consumed.
    const replay = await server.sendTransaction(assembled);
    expect(replay.status).toBe('ERROR');
    const err = xdr.TransactionResult.fromXDR(replay.errorResult!.toXDR());
    expect(err.result().switch().name).toBe('txBadSeq');
  });

  // A freshly created account has thresholds [1,0,0,0], so getNeededThreshold
  // (OperationFrame.cpp:57) returns 0 for MEDIUM. It is tempting to conclude an
  // unsigned transaction is therefore fine. It is NOT: for an ed25519-only
  // account, weight in SignatureChecker::checkSignature accumulates only inside
  // the loop over the transaction's signatures, so an unsigned transaction falls
  // through to `return false` whatever the threshold. Threshold 0 means "any one
  // valid signer suffices". Core pins it in
  // TxEnvelopeTests.cpp SECTION("no signature").
  it('an unsigned transaction is rejected even when the medium threshold is 0', async () => {
    expect(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.thresholds()[2]).toBe(0);

    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    // deliberately not signed
    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txBadAuth');
  });

  it('rejects an unsigned transaction with txBAD_AUTH once thresholds are raised', async () => {
    const strict = Keypair.random();
    L.fund(strict.publicKey(), { thresholds: [1, 1, 1, 1] });

    const account = await server.getAccount(strict.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    // deliberately not signed

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txBadAuth');
  });

  it('rejects a signature from the wrong key', async () => {
    const strict = Keypair.random();
    L.fund(strict.publicKey(), { thresholds: [1, 1, 1, 1] });

    const account = await server.getAccount(strict.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(Keypair.random());

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txBadAuth');
  });

  it('honours multisig weights against the medium threshold', async () => {
    const co = Keypair.random();
    const multi = Keypair.random();
    // master weight 1, medium threshold 2, extra signer weight 1 => needs both.
    L.fund(multi.publicKey(), {
      thresholds: [1, 1, 2, 3],
      signers: [{ key: co.publicKey(), weight: 1 }],
    });

    const account = await server.getAccount(multi.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('m'), u64(9n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();

    // Weight 1 clears the tx source's LOW threshold (1) but not the operation's
    // MEDIUM (2). Core reports that as opBAD_AUTH inside txFAILED — an APPLIED
    // transaction that failed, so it is PENDING at submit and FAILED on poll,
    // with the fee charged and the sequence consumed.
    assembled.sign(multi);
    const under = await server.sendTransaction(assembled);
    expect(under.status).toBe('PENDING');
    expect((await server.pollTransaction(under.hash)).status).toBe('FAILED');

    // The sequence was consumed by the failed attempt, so rebuild at the new one.
    const account2 = await server.getAccount(multi.publicKey());
    const tx2 = build(account2, invokeHostFn(addr, 'put_persistent', [sym('m'), u64(9n)]));
    const assembled2 = rpc.assembleTransaction(tx2, await server.simulateTransaction(tx2)).build();
    assembled2.sign(multi);
    assembled2.sign(co); // now weight 2 >= 2
    const okSent = await server.sendTransaction(assembled2);
    expect(okSent.status).toBe('PENDING');
    expect((await server.pollTransaction(okSent.hash)).status).toBe('SUCCESS');
  });

  it('enforces timebounds', async () => {
    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('t'), u64(1n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(kp);

    // Jump the ledger clock past maxTime.
    L.setTimestamp(BigInt(assembled.timeBounds!.maxTime) + 1n);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txTooLate');
  });

  it('rejects a memo on a Soroban transaction (P25+)', async () => {
    const account = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: '1000', networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(addr, 'put_persistent', [sym('a'), u64(1n)]),
          auth: [],
        }),
      )
      .addMemo(Memo.text('hello'))
      .setTimeout(300)
      .build();

    const sim = await server.simulateTransaction(tx);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(kp);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txSorobanInvalid');
  });

  // REGRESSION (round 2). stellar-core authenticates BOTH the transaction source
  // (checkAllTransactionSignatures, THRESHOLD_LOW) and the operation source
  // (OperationFrame::checkSignature, MEDIUM). An earlier version of this harness
  // implemented only the second, so a transaction whose source signed NOTHING was
  // applied — fee charged, sequence consumed — whenever the operation named its
  // own source. A live protocol-27 node returns txBadAuth for that envelope.
  it('REGRESSION: the transaction source must sign even when the operation names its own', async () => {
    const victim = Keypair.random();
    const operator = Keypair.random();
    L.fund(victim.publicKey(), { thresholds: [1, 1, 1, 1] });
    L.fund(operator.publicKey(), { thresholds: [1, 1, 1, 1] });

    const account = await server.getAccount(victim.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(addr, 'put_persistent', [sym('x'), u64(1n)]),
          auth: [],
          source: operator.publicKey(), // operation names its own source
        }),
      )
      .setTimeout(300)
      .build();
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(operator); // ONLY the operation source signs

    const balBefore = loadAccount(L, accountIdFromPublicKey(victim.publicKey()))!.balance().toString();

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('ERROR');
    expect(sent.errorResult!.result().switch().name).toBe('txBadAuth');

    // ...and nothing was taken from the account that never signed.
    const after = loadAccount(L, accountIdFromPublicKey(victim.publicKey()))!;
    expect(after.balance().toString()).toBe(balBefore);
    expect(after.seqNum().toString()).toBe('0');
  });

  it('an operation source that DOES sign, alongside the tx source, succeeds', async () => {
    const owner = Keypair.random();
    L.fund(owner.publicKey(), { thresholds: [1, 1, 1, 1] });

    const account = await server.getAccount(owner.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(addr, 'put_persistent', [sym('y'), u64(2n)]),
          auth: [],
          source: owner.publicKey(),
        }),
      )
      .setTimeout(300)
      .build();
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(owner);

    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe('PENDING');
    expect((await server.pollTransaction(sent.hash)).status).toBe('SUCCESS');
  });

  it('supports fee bumps: a different account pays', async () => {
    const sponsor = Keypair.random();
    L.fund(sponsor.publicKey());

    const account = await server.getAccount(kp.publicKey());
    const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym('fb'), u64(5n)]));
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(kp);

    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsor,
      String(BigInt(assembled.fee) * 2n),
      assembled,
      Networks.TESTNET,
    );
    bump.sign(sponsor);

    const sponsorBefore = BigInt(loadAccount(L, accountIdFromPublicKey(sponsor.publicKey()))!.balance().toString());
    const senderBefore = BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.balance().toString());

    const sent = await server.sendTransaction(bump);
    expect(sent.status).toBe('PENDING');
    const got = await server.pollTransaction(sent.hash);
    expect(got.status).toBe('SUCCESS');

    // The sponsor paid; the sender did not.
    const sponsorAfter = BigInt(loadAccount(L, accountIdFromPublicKey(sponsor.publicKey()))!.balance().toString());
    const senderAfter = BigInt(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.balance().toString());
    expect(sponsorAfter).toBeLessThan(sponsorBefore);
    expect(senderAfter).toBe(senderBefore);
    // ...and the inner transaction still consumed the sender's sequence number.
    expect(loadAccount(L, accountIdFromPublicKey(kp.publicKey()))!.seqNum().toString()).toBe('1');
  });

  it('CHANNEL ACCOUNTS: N sources submit concurrently without seqnum contention', async () => {
    const N = 8;
    const channels = Array.from({ length: N }, () => Keypair.random());
    channels.forEach((c) => L.fund(c.publicKey()));

    const envelopes = await Promise.all(
      channels.map(async (c, i) => {
        const account = await server.getAccount(c.publicKey());
        const tx = build(account, invokeHostFn(addr, 'put_persistent', [sym(`k${i}`), u64(BigInt(i))]));
        const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
        assembled.sign(c);
        return assembled;
      }),
    );

    const results = await Promise.all(envelopes.map((e) => server.sendTransaction(e)));
    expect(results.every((r) => r.status === 'PENDING')).toBe(true);

    const polled = await Promise.all(results.map((r) => server.pollTransaction(r.hash)));
    expect(polled.every((p) => p.status === 'SUCCESS')).toBe(true);

    // Every channel advanced exactly once, and every write landed.
    for (const c of channels) {
      expect(loadAccount(L, accountIdFromPublicKey(c.publicKey()))!.seqNum().toString()).toBe('1');
    }
    for (let i = 0; i < N; i++) {
      const read = L.simulate(invokeHostFn(addr, 'get_persistent', [sym(`k${i}`)]), accB64(kp.publicKey()));
      expect(scValToNative(xdr.ScVal.fromXDR(read.returnValueXdr!, 'base64'))).toBe(BigInt(i));
    }
  });
});
