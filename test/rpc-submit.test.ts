/**
 * The rpc.Server facade and the LiteStellar object it hangs off must agree.
 *
 * `svm.sendTransaction()` and `svm.rpcServer().sendTransaction()` are two doors
 * into the same ledger. The validation switches (`withSigverify`,
 * `withSequenceCheck`, `withFeeCharging`) are set on the LiteStellar, so the
 * second door has to be handed them, or "test your app unchanged against
 * rpcServer()" quietly tests something else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { LiteStellar, XLM, sc } from '../src/litestellar.js';

const ADD_I32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/add_i32.wasm', import.meta.url))),
);

/**
 * An UNSIGNED add(2, 3) envelope, simulated and assembled by the rpc.Server
 * itself, plus the wallet that would have to sign it. `seqSkew` moves its
 * sequence number away from account-seq + 1.
 */
async function unsignedAdd(svm: LiteStellar, seqSkew = 0n) {
  const alice = svm.airdrop(1000n * XLM, { thresholds: [1, 1, 1, 1] });
  const contract = svm.deployContract(ADD_I32, { as: alice });
  const server = svm.rpcServer();
  const source = new Account(alice.publicKey, String(alice.sequence() + seqSkew));
  const tx = new TransactionBuilder(source, {
    fee: '1000000',
    networkPassphrase: svm.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contract.contractId,
        function: 'add',
        args: [sc.i32(2), sc.i32(3)],
      }),
    )
    .setTimeout(300)
    .build();
  return { alice, server, prepared: await server.prepareTransaction(tx) };
}

const errorCode = (sent: { errorResult?: { result(): { switch(): { name: string } } } }) =>
  sent.errorResult?.result().switch().name;

describe('rpcServer() honours the validation switches', () => {
  it('control: by default an unsigned envelope is rejected', async () => {
    const { server, prepared } = await unsignedAdd(new LiteStellar());
    const sent = await server.sendTransaction(prepared);
    expect(sent.status).toBe('ERROR');
    expect(errorCode(sent)).toBe('txBadAuth');
  });

  it('withSigverify(false) lets the unsigned envelope through', async () => {
    const { server, prepared } = await unsignedAdd(new LiteStellar().withSigverify(false));
    expect((await server.sendTransaction(prepared)).status).toBe('PENDING');
  });

  it('withSequenceCheck(false) accepts a wrong sequence number; the default rejects it', async () => {
    const strict = await unsignedAdd(new LiteStellar().withSigverify(false), 40n);
    const rejected = await strict.server.sendTransaction(strict.prepared);
    expect(rejected.status).toBe('ERROR');
    expect(errorCode(rejected)).toBe('txBadSeq');

    const lax = await unsignedAdd(new LiteStellar().withSigverify(false).withSequenceCheck(false), 40n);
    expect((await lax.server.sendTransaction(lax.prepared)).status).toBe('PENDING');
  });

  it('withFeeCharging(false) stops the debit; the default takes it', async () => {
    const charged = await unsignedAdd(new LiteStellar().withSigverify(false));
    const before = charged.alice.balance();
    await charged.server.sendTransaction(charged.prepared);
    expect(charged.alice.balance()).toBeLessThan(before);

    const free = await unsignedAdd(new LiteStellar().withSigverify(false).withFeeCharging(false));
    const freeBefore = free.alice.balance();
    await free.server.sendTransaction(free.prepared);
    expect(free.alice.balance()).toBe(freeBefore);
  });
});

describe('requestAirdrop', () => {
  it('funds a new account and returns its sequence', async () => {
    const svm = new LiteStellar();
    const fresh = Keypair.random().publicKey();
    const account = await svm.rpcServer().requestAirdrop(fresh);
    expect(account.accountId()).toBe(fresh);
    expect(account.sequenceNumber()).toBe('0');
  });

  it('refuses an account that already exists, as friendbot does, and leaves it untouched', async () => {
    const svm = new LiteStellar();
    const cosigner = Keypair.random();
    const alice = svm.airdrop(1000n * XLM, {
      thresholds: [1, 1, 2, 2],
      signers: [{ key: cosigner.publicKey(), weight: 1 }],
    });
    const balance = alice.balance();
    const server = svm.rpcServer();

    await expect(server.requestAirdrop(alice.publicKey)).rejects.toMatchObject({
      response: { status: 400 },
    });

    // Funding it anyway used to rebuild the entry: sequence 0, signers gone.
    const account = svm.getAccount(alice.publicKey)!;
    expect(account.thresholds()).toEqual(Buffer.from([1, 1, 2, 2]));
    expect(account.signers()).toHaveLength(1);
    expect(alice.balance()).toBe(balance);
  });
});
