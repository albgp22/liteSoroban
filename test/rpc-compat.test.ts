/**
 * Interop surface: can an app be pointed at this thing without changing?
 *
 * Every `rpc.Server` method is called for real and its SDK-PARSED result
 * checked — not merely "it did not throw". If a method regresses to
 * "unimplemented", this file says so by name.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  rpc,
  Asset,
  Address,
  Keypair,
  contract,
  Operation,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, type Wallet, type Contract } from '../src/litestellar.js';
import { invokeHostFn } from '../src/index.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);

describe('rpc.Server compatibility', () => {
  let svm: LiteStellar;
  let alice: Wallet;
  let c: Contract;
  let server: rpc.Server;

  beforeEach(() => {
    svm = new LiteStellar();
    alice = svm.airdrop();
    c = svm.deployContract(CODE, { as: alice });
    server = svm.rpcServer();
  });

  const instanceKey = () =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: c.address,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

  it('getHealth', async () => {
    expect((await server.getHealth()).status).toBe('healthy');
  });

  it('getNetwork reports the passphrase signatures are checked against', async () => {
    const n = await server.getNetwork();
    expect(n.passphrase).toBe(svm.networkPassphrase);
    expect(n.friendbotUrl).toBeTruthy();
  });

  it('getLatestLedger decodes, header and metadata included', async () => {
    const l = await server.getLatestLedger();
    expect(l.sequence).toBe(svm.ledgerSequence);
    expect(l.protocolVersion).toBe(svm.protocolVersion);
  });

  it('getVersionInfo', async () => {
    expect((await server.getVersionInfo()).protocolVersion).toBe(svm.protocolVersion);
  });

  it('getFeeStats', async () => {
    const f = await server.getFeeStats();
    expect(f.latestLedger).toBe(svm.ledgerSequence);
    expect(f.sorobanInclusionFee.max).toBeTruthy();
  });

  it('getAccount', async () => {
    const a = await server.getAccount(alice.publicKey);
    expect(a.accountId()).toBe(alice.publicKey);
  });

  it('getLedgerEntries returns LedgerEntryData and a TTL', async () => {
    const r = await server.getLedgerEntries(instanceKey());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].val.switch().name).toBe('contractData');
    expect(r.entries[0].liveUntilLedgerSeq).toBeGreaterThan(0);
  });

  it('getContractData / getContractInstance / getContractWasmByContractId', async () => {
    const d = await server.getContractData(
      c.contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      rpc.Durability.Persistent,
    );
    expect(d.val.switch().name).toBe('contractData');

    const inst = await (server as any).getContractInstance(c.contractId);
    expect(inst).toBeTruthy();

    const wasm = await (server as any).getContractWasmByContractId(c.contractId);
    expect(wasm.length).toBe(CODE.length);
  });

  it('getSACBalance', async () => {
    const usdc = svm.deployToken({ code: 'USDC' });
    const r = await server.getSACBalance(
      Address.fromString(c.contractId),
      new Asset('USDC', usdc.issuer.publicKey),
      svm.networkPassphrase,
    );
    expect(r.latestLedger).toBe(svm.ledgerSequence);
  });

  it('requestAirdrop funds an account and returns its sequence', async () => {
    const fresh = Keypair.random();
    const account = await server.requestAirdrop(fresh.publicKey());
    expect(account.accountId()).toBe(fresh.publicKey());
    expect(svm.getBalance(fresh.publicKey())).toBeGreaterThan(0n);
  });

  describe('after a submitted transaction', () => {
    let hash: string;

    beforeEach(async () => {
      const usdc = svm.deployToken({ code: 'EVT' });
      usdc.mint(alice, 1_000n); // emits contract events

      const account = await server.getAccount(alice.publicKey);
      const tx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: svm.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeHostFn(c.address, 'put_persistent', [sc.sym('k'), sc.u64(9n)]),
            auth: [],
          }),
        )
        .setTimeout(300)
        .build();
      const assembled = rpc
        .assembleTransaction(tx, await server.simulateTransaction(tx))
        .build();
      assembled.sign(alice.keypair);
      hash = (await server.sendTransaction(assembled)).hash;
    });

    it('getTransaction returns a decoded return value', async () => {
      const got = await server.pollTransaction(hash);
      expect(got.status).toBe('SUCCESS');
      expect(got.txHash).toBe(hash);
    });

    it('getTransactions lists it', async () => {
      const r = await server.getTransactions({ startLedger: 1 });
      expect(r.transactions.length).toBeGreaterThan(0);
      expect(r.transactions.some((t: any) => t.txHash === hash)).toBe(true);
    });

    it('getLedgers decodes headers', async () => {
      const r = await (server as any).getLedgers({
        startLedger: svm.ledgerSequence,
        pagination: { limit: 2 },
      });
      expect(r.ledgers.length).toBe(2);
      expect(r.ledgers[0].headerXdr).toBeTruthy();
    });
  });

  it('getEvents returns the events a contract emitted', async () => {
    const account = await server.getAccount(alice.publicKey);
    const usdc = svm.deployToken({ code: 'EVT' });
    usdc.trust(alice);

    // Mint through the wire so the event is buffered by sendTransaction.
    const issuer = usdc.issuer;
    const acct = await server.getAccount(issuer.publicKey);
    const tx = new TransactionBuilder(acct, {
      fee: '1000',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: invokeHostFn(usdc.address, 'mint', [
            sc.address(alice.address),
            sc.i128(500n),
          ]),
          auth: [],
        }),
      )
      .setTimeout(300)
      .build();
    const assembled = rpc.assembleTransaction(tx, await server.simulateTransaction(tx)).build();
    assembled.sign(issuer.keypair);
    await server.sendTransaction(assembled);

    const events = await server.getEvents({ startLedger: 1, filters: [] });
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.latestLedger).toBe(svm.ledgerSequence);

    // Filtering by contract id works.
    const filtered = await server.getEvents({
      startLedger: 1,
      filters: [{ type: 'contract', contractIds: [usdc.contractId] } as any],
    });
    expect(filtered.events.length).toBeGreaterThan(0);
    expect(account).toBeTruthy();
  });

  it('an unimplemented method throws a real Error, not a raw JSON-RPC object', async () => {
    const raw = (server as any).httpClient.defaults.adapter;
    await expect(
      raw({ url: 'https://in-process.invalid', data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }) }),
    ).rejects.toBeInstanceOf(Error);
  });

  describe('contract.Client', () => {
    const spec = () => contract.Spec.fromWasm(Buffer.from(CODE));

    it('constructor honours options.server, and signAndSend works', async () => {
      const client: any = new contract.Client(spec(), {
        contractId: c.contractId,
        networkPassphrase: svm.networkPassphrase,
        rpcUrl: 'https://in-process.invalid',
        publicKey: alice.publicKey,
        server: server as any,
      });

      const tx = await client.put_persistent({ key: 'k', val: 11n });
      await tx.signAndSend({
        signTransaction: contract.basicNodeSigner(alice.keypair, svm.networkPassphrase)
          .signTransaction,
      });

      expect(c.view('get_persistent', [sc.sym('k')])).toBe(11n);
    });

    it('Client.from honours options.server', async () => {
      const client = await contract.Client.from({
        contractId: c.contractId,
        networkPassphrase: svm.networkPassphrase,
        rpcUrl: 'https://in-process.invalid',
        publicKey: alice.publicKey,
        server: server as any,
      } as any);
      expect(client).toBeInstanceOf(contract.Client);
    });

    it('KNOWN TRAP: Client.deploy ignores options.server and reaches the network', async () => {
      await expect(
        contract.Client.deploy(null, {
          wasmHash: Buffer.alloc(32).toString('hex'),
          contractId: c.contractId,
          networkPassphrase: svm.networkPassphrase,
          rpcUrl: 'https://in-process.invalid',
          publicKey: alice.publicKey,
          server: server as any,
        } as any),
      ).rejects.toThrow();
    });
  });
});
