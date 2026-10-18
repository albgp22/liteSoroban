/**
 * simulateTransaction's `resourceConfig.instructionLeeway` (the SDK's
 * `cpuInstructions`), checked against a real stellar-rpc.
 *
 * stellar-rpc pads the recorded instruction count with soroban-simulation's
 * default adjustment, max(raw + additive, floor(raw * 1.04)), after raising the
 * additive part from 50_000 to the caller's leeway (stellar-rpc v29.0.1,
 * lib/preflight/src/shared.rs; soroban-simulation 29.0.2, resources.rs).
 *
 * NODE below is what a local stellar/quickstart network (stellar-core 29.0.0,
 * stellar-rpc 29.0.1, protocol 29) returned for add(2, 3), and the error
 * responses are its answers verbatim. The harness, metering with that node's
 * cost table, returned the same absolute numbers; here the default table is
 * used, so the test compares deltas, which do not depend on calibration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { LiteStellar, sc } from '../src/litestellar.js';

const ADD_I32 = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/add_i32.wasm', import.meta.url))),
);

const NODE_BASE = 325_616; // leeway 0
const NODE: Record<number, number> = {
  1: 325_616,
  49_999: 325_616,
  50_000: 325_616,
  50_001: 325_617,
  100_000: 375_616,
  1_000_000: 1_275_616,
  20_000_000: 20_275_616,
  4_294_967_295: 4_294_967_295, // saturates at u32::MAX
};

function setup() {
  const svm = new LiteStellar();
  const c = svm.deployContract(ADD_I32);
  const server = svm.rpcServer();
  const tx = new TransactionBuilder(new Account(svm.payer.publicKey, '1'), {
    fee: '1000000',
    networkPassphrase: svm.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: c.contractId,
        function: 'add',
        args: [sc.i32(2), sc.i32(3)],
      }),
    )
    .setTimeout(300)
    .build();
  const instructions = async (leeway?: number) => {
    const sim: any = await server.simulateTransaction(
      tx,
      leeway === undefined ? undefined : { cpuInstructions: leeway },
    );
    return sim.transactionData.build().resources.instructions as number;
  };
  // Raw JSON-RPC, to see the exact response shape stellar-rpc sends.
  const raw = (instructionLeeway: number) =>
    (server as any).httpClient.defaults.adapter({
      url: 'https://in-process.invalid',
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: { transaction: tx.toXdr(), resourceConfig: { instructionLeeway } },
      }),
    }).then((r: any) => r.data);
  return { instructions, raw };
}

describe('simulateTransaction: instructionLeeway', () => {
  it('no resourceConfig is the same as leeway 0, as in stellar-rpc', async () => {
    const { instructions } = setup();
    expect(await instructions()).toBe(await instructions(0));
  });

  it('raises the padding to max(50_000, leeway), delta for delta with the node', async () => {
    const { instructions } = setup();
    const base = await instructions(0);
    for (const [leeway, node] of Object.entries(NODE)) {
      const got = await instructions(Number(leeway));
      if (node === 4_294_967_295) {
        expect(got, `leeway ${leeway}`).toBe(node);
      } else {
        expect(got - base, `leeway ${leeway}`).toBe(node - NODE_BASE);
      }
    }
  });

  it('a leeway past u32 fails the simulation with the node\'s message', async () => {
    const { raw } = setup();
    const body = await raw(4_294_967_296);
    expect(body.result.error).toBe('number too large to fit in target type');
  });

  it('a negative or fractional leeway is a JSON-RPC invalid-params error, as Go decodes it', async () => {
    const { raw } = setup();
    for (const bad of [-1, 1.5]) {
      const body = await raw(bad);
      expect(body.result).toBeUndefined();
      expect(body.error).toEqual({
        code: -32602,
        message: 'invalid parameters',
        data:
          `json: cannot unmarshal number ${bad} into Go struct field ` +
          'ResourceConfig.resourceConfig.instructionLeeway of type uint64',
      });
    }
  });
});
