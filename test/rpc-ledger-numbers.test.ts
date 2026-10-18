/**
 * Ledger numbers through rpc.Server, the way a node reports them.
 *
 * stellar-rpc 29.0.1 reports the last closed ledger as latest
 * (get_latest_ledger.go; send_transaction.go reads LastLedger before it
 * submits) and preflights in it (simulate_transaction.go, `LedgerSeq:
 * latestLedger`). stellar-core validates a submission against the next ledger
 * and applies it there (TransactionQueue: last closed + 1). In the harness that
 * next ledger is `svm.ledgerSequence`, so the facade reports
 * `ledgerSequence - 1` as latest.
 *
 * Checked on a local protocol-29 node (stellar/quickstart: stellar-core 29.0.0,
 * stellar-rpc 29.0.1) through rpc.Server on 2026-10-18, against the harness:
 * sendTransaction's latestLedger was `latest` and getTransaction().ledger was
 * `latest + 1`. An auth entry expiring at `latest - 1` failed simulation. One
 * expiring at `latest` simulated clean and then FAILED on apply. One expiring
 * at `latest + 1` applied. getLedgers past `latest` was refused with the error
 * below. The node and the harness agreed on each.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { LiteStellar } from '../src/litestellar.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

function world() {
  const svm = new LiteStellar();
  const server = svm.rpcServer();
  const contract = svm.deployContract(fixture('auth_test_contract.wasm'));
  const account = () => {
    const k = Keypair.random();
    svm.ledger.fund(k.publicKey(), { balance: 10_000n * 10_000_000n });
    return k;
  };
  const latest = async () => (await server.getLatestLedger()).sequence;
  /** `do_auth(signer, 1)` from `source`: needs `signer`'s address authorization. */
  const doAuth = async (source: Keypair, signer: Keypair, auth: xdr.SorobanAuthorizationEntry[] = []) => {
    const acct = await server.getAccount(source.publicKey());
    return new TransactionBuilder(new Account(source.publicKey(), acct.sequenceNumber()), {
      fee: '1000000',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contract.contractId,
          function: 'do_auth',
          args: [new Address(signer.publicKey()).toScVal(), nativeToScVal(1, { type: 'u32' })],
          auth,
        }),
      )
      .setTimeout(0)
      .build();
  };
  /** The signer's entry from a recording simulation, signed to expire at `expiration`. */
  const signedEntry = async (source: Keypair, signer: Keypair, expiration: number) => {
    const recorded = await server.simulateTransaction(await doAuth(source, signer));
    if (!rpc.Api.isSimulationSuccess(recorded)) throw new Error(recorded.error);
    return authorizeEntry(recorded.result!.auth[0], signer, expiration, svm.networkPassphrase);
  };
  return { svm, server, account, latest, doAuth, signedEntry };
}

describe('rpc.Server reports the last closed ledger as latest', () => {
  it('a submission applies in latest + 1, which is latest once it closes', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const latest = await w.latest();
    expect(latest).toBe(w.svm.ledgerSequence - 1);

    const entry = await w.signedEntry(a, b, latest + 100);
    const tx = await w.server.prepareTransaction(await w.doAuth(a, b, [entry]));
    tx.sign(a);
    const sent = await w.server.sendTransaction(tx);
    expect([sent.status, sent.latestLedger]).toEqual(['PENDING', latest]);

    const got = await w.server.getTransaction(sent.hash);
    expect(got.status).toBe('SUCCESS');
    expect([got.ledger, got.latestLedger]).toEqual([latest + 1, latest + 1]);
    expect(await w.latest()).toBe(latest + 1);
    const listed = await w.server.getTransactions({ startLedger: latest + 1 });
    expect(listed.transactions.map((t) => [t.txHash, t.ledger])).toEqual([[sent.hash, latest + 1]]);
  });

  it('a rejected submission reports the latest ledger and leaves it alone', async () => {
    const w = world();
    const a = w.account();
    const latest = await w.latest();
    const tx = await w.server.prepareTransaction(await w.doAuth(a, a));
    // unsigned: txBAD_AUTH at submission
    const sent = await w.server.sendTransaction(tx);
    expect([sent.status, sent.latestLedger]).toEqual(['ERROR', latest]);
    expect(await w.latest()).toBe(latest);
  });
});

describe('simulateTransaction runs in the latest ledger, a submission in the next', () => {
  it('an auth entry expiring at latest - 1 has expired in simulation', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const entry = await w.signedEntry(a, b, (await w.latest()) - 1);
    const sim = await w.server.simulateTransaction(await w.doAuth(a, b, [entry]));
    expect(rpc.Api.isSimulationError(sim) && sim.error).toMatch(/expired/i);
  });

  it('one expiring at latest simulates clean, then fails on apply in latest + 1', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const latest = await w.latest();
    const entry = await w.signedEntry(a, b, latest);
    const sim = await w.server.simulateTransaction(await w.doAuth(a, b, [entry]));
    expect(rpc.Api.isSimulationSuccess(sim)).toBe(true);

    const tx = rpc.assembleTransaction(await w.doAuth(a, b, [entry]), sim).build();
    tx.sign(a);
    const sent = await w.server.sendTransaction(tx);
    expect(sent.status).toBe('PENDING');
    const got = await w.server.getTransaction(sent.hash);
    expect([got.status, got.ledger]).toEqual(['FAILED', latest + 1]);
  });

  it('one expiring at latest + 1 applies', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const latest = await w.latest();
    const entry = await w.signedEntry(a, b, latest + 1);
    const tx = await w.server.prepareTransaction(await w.doAuth(a, b, [entry]));
    tx.sign(a);
    const got = await w.server.getTransaction((await w.server.sendTransaction(tx)).hash);
    expect([got.status, got.ledger]).toEqual(['SUCCESS', latest + 1]);
  });
});

describe('getLedgers serves closed ledgers only', () => {
  it('a page stops at latest, and the cursor is the last ledger returned', async () => {
    const w = world();
    const latest = await w.latest();
    const r = await (w.server as any).getLedgers({ startLedger: latest - 1, pagination: { limit: 5 } });
    expect(r.ledgers.map((l: any) => l.sequence)).toEqual([latest - 1, latest]);
    expect([r.latestLedger, r.cursor]).toEqual([latest, String(latest)]);
  });

  it('a start past latest is refused, as stellar-rpc words it', async () => {
    const w = world();
    const latest = await w.latest();
    await expect((w.server as any).getLedgers({ startLedger: latest + 1 })).rejects.toMatchObject({
      code: -32600,
      message: `start ledger (${latest + 1}) must be between the oldest ledger: 1 and the latest ledger: ${latest} for this rpc instance`,
    });
  });
});
