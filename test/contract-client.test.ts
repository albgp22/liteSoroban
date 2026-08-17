import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, rpc, contract, Keypair, Networks, Address } from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn } from '../src/index.js';
import { attachInProcessRpc } from '../src/fake-rpc.js';
import { accountIdFromPublicKey } from '../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/contract_data.wasm', import.meta.url))),
);
const RPC_URL = 'https://in-process.invalid';

describe('contract.Client against the in-process ledger', () => {
  let L: Ledger;
  let server: rpc.Server;
  let kp: Keypair;
  let contractId: string;
  let spec: contract.Spec;

  beforeEach(async () => {
    L = new Ledger();
    kp = Keypair.random();
    L.fund(kp.publicKey());

    server = new rpc.Server(RPC_URL);
    attachInProcessRpc(server, L);

    const sourceB64 = accountIdFromPublicKey(kp.publicKey()).toXDR('base64');
    const wasmHash = L.seedWasm(CODE);
    const { sent } = L.simulateAndSend(createContractHostFn(sourceB64, wasmHash), sourceB64);
    const addr = xdr.ScVal.fromXDR(sent.returnValueXdr!, 'base64').address();
    contractId = Address.fromScAddress(addr).toString();

    spec = await contract.Spec.fromWasm(Buffer.from(CODE));
  });

  function client(): contract.Client {
    return new contract.Client(spec, {
      contractId,
      networkPassphrase: Networks.TESTNET,
      rpcUrl: RPC_URL,
      publicKey: kp.publicKey(),
      // The DI seam. Honoured by the constructor (client.js:45) and by
      // Client.from / Client.fromWasmHash (client.js:135, :198).
      server: server as any,
    });
  }

  it('exposes the contract methods from the wasm spec', () => {
    const names = spec.funcs().map((f) => f.name().toString());
    expect(names).toContain('put_persistent');
    expect(names).toContain('get_persistent');
  });

  it('simulates a call through the injected server with zero network', async () => {
    const c = client() as any;
    const tx = await c.put_persistent({ key: 'ctr', val: 7n });
    expect(tx).toBeInstanceOf(contract.AssembledTransaction);
    expect(tx.simulation).toBeDefined();
  });

  it('signAndSend runs the whole client path end to end', async () => {
    const c = client() as any;
    const tx = await c.put_persistent({ key: 'ctr', val: 7n });

    const sent = await tx.signAndSend({
      signTransaction: contract.basicNodeSigner(kp, Networks.TESTNET).signTransaction,
    });
    expect(sent.getTransactionResponse?.status ?? sent.sendTransactionResponse?.status).toBeTruthy();

    // Read it back through a fresh client — the write really landed.
    const reader = client() as any;
    const readTx = await reader.get_persistent({ key: 'ctr' });
    expect(readTx.result).toBe(7n);
  });

  it('DOCUMENTS THE TRAP: Client.deploy ignores options.server and hits the network', async () => {
    // client.js:36-38 builds `new RpcServer(rpcUrl, serverOpts)` in a private
    // helper and never consults options.server. Against an unresolvable URL
    // this must fail — if this test ever starts passing, the leak was fixed
    // upstream and the workaround below can be dropped.
    await expect(
      contract.Client.deploy(null, {
        wasmHash: Buffer.alloc(32).toString('hex'),
        contractId,
        networkPassphrase: Networks.TESTNET,
        rpcUrl: RPC_URL,
        publicKey: kp.publicKey(),
        server: server as any,
      } as any),
    ).rejects.toThrow();
  });
});
