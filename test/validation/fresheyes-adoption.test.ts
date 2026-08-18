/**
 * FRESH-EYES ADOPTION TRIAL — a wallet backend.
 *
 * Written by an engineer evaluating this harness for a production Soroban app,
 * following README.md and GUIDE.md only. The app is ordinary: deploy a smart
 * account for a user through a factory, fund it with a token, move value out of
 * it under a passkey.
 *
 * The facade path works and is genuinely good (test 0 below is the control:
 * `__check_auth` really runs, and an attacker's key really is rejected).
 *
 * The DOCUMENTED alternative path — GUIDE.md "Testing your app unchanged",
 * `svm.rpcServer()` — does not work for this app, and the reason is not listed
 * under README.md "Known gaps", whose RPC section says "the surface is
 * complete" and names only two remaining items.
 *
 * Every expectation below was verified against the live protocol-27 node at
 * http://localhost:8000/rpc (stellar-rpc 27.1.1 / captive-core 27.1.0) and
 * against the pinned host source, NOT against what this harness returns.
 *
 * Lives in test/validation/ because these are red by design, like the rest of
 * this directory. `npm test` stays green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TransactionBuilder, Operation, Asset, Address, xdr, rpc, nativeToScVal,
} from '@stellar/stellar-sdk';
import { LiteStellar, sc, signAuthEntriesSync } from '../../src/litestellar.js';
import { createP256Signer, smartAccountSecp256r1, type P256Signer } from '../../src/auth.js';

const FACTORY_WASM = readFileSync('test/fixtures/contract_factory.wasm');
const SMART_ACCOUNT_WASM = readFileSync('test/fixtures/smart_account_current.wasm');
const CONTRACT_DATA = readFileSync('test/fixtures/contract_data.wasm');

/**
 * GUIDE.md's passkey and factory snippets both call `signerFor(passkey)` and
 * never define it — it exists only as a local const inside test/guide.test.ts.
 * Reproduced here because a reader cannot obtain it from the documentation.
 */
const signerFor = (p: P256Signer) =>
  sc.vec([
    sc.sym('Secp256r1'),
    sc.map([{ key: sc.sym('public_key'), val: sc.bytes(p.publicKey) }]),
    sc.vec([sc.sym('Admin')]),
  ]);

/** The wallet backend's world: a relayer, a merchant, a passkey smart account holding USDC. */
function wallet() {
  const svm = new LiteStellar();
  const relayer = svm.airdrop();
  const merchant = svm.airdrop();

  const factory = svm.deployContract(FACTORY_WASM, { as: relayer });
  const wasmHash = svm.addContract(SMART_ACCOUNT_WASM);
  const passkey = createP256Signer();
  const ctorArgs = sc.vec([sc.vec([signerFor(passkey)]), sc.vec([])]);
  const deployed = factory.invoke('deploy', [
    sc.map([
      { key: sc.sym('constructor_args'), val: ctorArgs },
      { key: sc.sym('salt'), val: sc.bytes(Buffer.alloc(32, 7)) },
      { key: sc.sym('wasm_hash'), val: sc.bytes(Buffer.from(wasmHash, 'base64')) },
    ]),
  ]);
  const account = svm.contractAt(deployed.toString());

  const usdc = svm.deployToken({ code: 'USDC' });
  usdc.mint(account.address, 1_000_0000000n);
  usdc.trust(merchant);

  const transferArgs = () => [
    sc.address(account),
    sc.address(merchant),
    sc.i128(250_0000000n),
  ];
  const transferFn = () =>
    xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(usdc.contractId).toScAddress(),
        functionName: 'transfer',
        args: transferArgs(),
      }),
    );

  return { svm, relayer, merchant, account, usdc, passkey, transferArgs, transferFn };
}

// ---------------------------------------------------------------------------
// 0. CONTROL — the facade path. This is GREEN, and it is genuinely impressive.
// ---------------------------------------------------------------------------

describe('control: the facade path really does enforce __check_auth', () => {
  it('the passkey moves value; an attacker key does not', () => {
    const w = wallet();
    const token = w.svm.contractAt(w.usdc.contractId);

    const good = token.tryInvoke('transfer', w.transferArgs(), {
      signAuth: smartAccountSecp256r1(w.passkey),
    });
    expect(good.ok, 'the real passkey should authorize the transfer').toBe(true);
    expect(w.usdc.balanceOf(w.merchant)).toBe(250_0000000n);

    const w2 = wallet();
    const token2 = w2.svm.contractAt(w2.usdc.contractId);
    const attacker = token2.tryInvoke('transfer', w2.transferArgs(), {
      signAuth: smartAccountSecp256r1(createP256Signer()),
    });
    expect(attacker.ok, 'an attacker key must NOT authorize the transfer').toBe(false);
    expect(attacker.error!.is('Auth', 'InvalidAction')).toBe(true);
    expect(w2.usdc.balanceOf(w2.merchant)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 1. simulateTransaction discards auth entries the transaction already carries.
// ---------------------------------------------------------------------------

describe('rpc facade: simulateTransaction and supplied auth entries', () => {
  /**
   * GROUND TRUTH, run against the live protocol-27 node:
   *
   *   transfer(A -> B) over the native SAC, with ONE auth entry supplied whose
   *   credentials are `sorobanCredentialsAddress` for A and whose signature is
   *   64 zero bytes.
   *
   *   live stellar-rpc 27.1.1  ->  SIMULATION FAILS
   *       HostError: Error(Auth, InvalidAction)
   *       "failed account authentication with error", G..., Error(Crypto, InvalidInput)
   *
   * That is enforcing auth. The pinned host exposes exactly this mode:
   * soroban-env-host-27.0.1/src/e2e_invoke.rs:639-646
   *     pub enum RecordingInvocationAuthMode {
   *         /// Use enforcing auth and pass the signed authorization entries to be used.
   *         Enforcing(Vec<SorobanAuthorizationEntry>),
   *         Recording(RecordingInvocationAuthParams),
   *     }
   * and at :751 returns those entries unchanged instead of re-recording.
   *
   * src/fake-rpc.ts `case 'simulateTransaction'` reads
   * `op.body().invokeHostFunctionOp().hostFunction()` and never reads `.auth()`,
   * so it always calls `ledger.simulate(...)` — recording mode. The harness owns
   * a correct `ledger.simulateWithAuth()` (GUIDE.md documents it under "Dropping
   * to the low level"); the RPC adapter simply never calls it.
   */
  it('runs ENFORCING auth when the transaction carries auth entries', async () => {
    const svm = new LiteStellar();
    const A = svm.airdrop();
    const B = svm.airdrop();
    svm.nativeToken();
    const server = svm.rpcServer();
    const sacId = Asset.native().contractId(svm.networkPassphrase);

    const args = () => [
      Address.fromString(A.publicKey).toScVal(),
      Address.fromString(B.publicKey).toScVal(),
      nativeToScVal(1000n, { type: 'i128' }),
    ];
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(sacId).toScAddress(),
        functionName: 'transfer',
        args: args(),
      }),
    );

    const bogus = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(A.publicKey).toScAddress(),
          nonce: xdr.Int64.fromString('123456789'),
          signatureExpirationLedger: 999999,
          signature: xdr.ScVal.scvVec([
            xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('public_key'),
                val: xdr.ScVal.scvBytes(A.keypair.rawPublicKey()),
              }),
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('signature'),
                val: xdr.ScVal.scvBytes(Buffer.alloc(64, 0)),
              }),
            ]),
          ]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(sacId).toScAddress(),
            functionName: 'transfer',
            args: args(),
          }),
        ),
        subInvocations: [],
      }),
    });

    const tx = new TransactionBuilder(await server.getAccount(A.publicKey), {
      fee: '1000000',
      networkPassphrase: svm.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: [bogus] }))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);

    expect(
      rpc.Api.isSimulationError(sim),
      'A transaction carrying an auth entry with a 64-zero-byte signature must ' +
        'fail simulation, as the live protocol-27 node does with ' +
        'Error(Auth, InvalidAction). This harness discards the supplied entry, ' +
        're-records in recording mode, and returns a green simulation with ' +
        'sorobanCredentialsSourceAccount. src/fake-rpc.ts never reads op.auth().',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The consequence: the documented four-step round trip is impossible
//    through rpc.Server, so a passkey wallet cannot be tested "unchanged".
// ---------------------------------------------------------------------------

describe('rpc facade: the four-step custom-account round trip', () => {
  /**
   * README.md spells the round trip out:
   *
   *   1. simulate                         -> recorded auth entries
   *   2. sign those entries
   *   3. simulate WITH the signed entries -> footprint covering __check_auth's reads
   *   4. send
   *
   *   "Skip 3 -> Error(Storage, ExceededLimit) and 'trying to access contract
   *    data key outside of the footprint'"
   *
   * Step 3 cannot be performed through `svm.rpcServer()`: simulateTransaction
   * throws the signed entries away (test 1), so the footprint it returns is the
   * recording one. Measured on this exact transfer:
   *
   *   ledger.simulate()          footprint  readOnly = 3
   *   ledger.simulateWithAuth()  footprint  readOnly = 5
   *
   * The two missing read-only keys are the smart account's instance and its
   * Secp256r1 signer entry, which __check_auth reads. Sending with the ro=3
   * footprint traps exactly as README predicts.
   */
  it('lets a backend simulate -> sign -> re-simulate -> send a passkey transfer', async () => {
    const w = wallet();
    const server = w.svm.rpcServer();

    const build = async (auth: xdr.SorobanAuthorizationEntry[]) =>
      new TransactionBuilder(await server.getAccount(w.relayer.publicKey), {
        fee: '5000000',
        networkPassphrase: w.svm.networkPassphrase,
      })
        .addOperation(Operation.invokeHostFunction({ func: w.transferFn(), auth }))
        .setTimeout(300)
        .build();

    // step 1
    const sim1 = await server.simulateTransaction(await build([]));
    expect(rpc.Api.isSimulationError(sim1), 'step 1 should simulate cleanly').toBe(false);
    const recorded = (sim1 as rpc.Api.SimulateTransactionSuccessResponse).result!.auth;
    expect(recorded.length).toBe(1);

    // step 2 — sign with the passkey
    const signed = signAuthEntriesSync(
      recorded.map((e) => e.toXDR('base64')),
      {
        sign: smartAccountSecp256r1(w.passkey) as (p: Buffer) => xdr.ScVal,
        networkPassphrase: w.svm.networkPassphrase,
        validUntilLedgerSeq: w.svm.ledgerSequence + 100,
      },
    ).map((b) => xdr.SorobanAuthorizationEntry.fromXDR(b, 'base64'));

    // step 3 — re-simulate WITH the signed entries
    const tx3 = await build(signed);
    const sim3 = await server.simulateTransaction(tx3);
    expect(rpc.Api.isSimulationError(sim3), 'step 3 should simulate cleanly').toBe(false);

    const back = (sim3 as rpc.Api.SimulateTransactionSuccessResponse).result!.auth;
    expect(
      back[0].credentials().address().signature().switch().name,
      'step 3 must return the SIGNED entries back (the live node does); this ' +
        'harness returns them with the signature stripped to scvVoid, proving ' +
        'it re-recorded instead of enforcing',
    ).not.toBe('scvVoid');

    // step 4 — assemble, sign the envelope, send
    const assembled = rpc.assembleTransaction(tx3, sim3).build();
    assembled.sign(w.relayer.keypair);
    const sent = await server.sendTransaction(assembled);
    const got = await server.pollTransaction(sent.hash);

    expect(
      got.status,
      'the identical transfer succeeds through Contract.invoke({ signAuth }) but ' +
        'FAILS here with invokeHostFunctionTrapped / Error(Storage, ExceededLimit), ' +
        'because step 3 handed back the recording footprint (readOnly = 3) rather ' +
        'than the enforcing one (readOnly = 5)',
    ).toBe('SUCCESS');
    expect(w.usdc.balanceOf(w.merchant)).toBe(250_0000000n);
  });
});

// ---------------------------------------------------------------------------
// 3. When it fails, the RPC facade tells you nothing.
// ---------------------------------------------------------------------------

describe('rpc facade: diagnostics on a failed transaction', () => {
  /**
   * GROUND TRUTH, live protocol-27 node: submit a native-SAC transfer of 10^18
   * stroops using a footprint simulated for a 1000-stroop transfer. It fails at
   * apply, and `getTransaction` returns:
   *
   *   raw result keys: [..., 'resultMetaXdr', 'diagnosticEventsXdr', 'events', ...]
   *   raw diagnosticEventsXdr length: 22
   *
   * The harness's getTransaction response has no diagnosticEventsXdr key at all,
   * so a backend developer whose transaction failed gets the string "FAILED" and
   * nothing else. The information exists — `Contract.tryInvoke().error.raw`
   * prints it beautifully — it is just not plumbed through the RPC adapter.
   */
  it('exposes diagnosticEventsXdr, as the live node does', async () => {
    const w = wallet();
    const server = w.svm.rpcServer();

    const build = async (auth: xdr.SorobanAuthorizationEntry[]) =>
      new TransactionBuilder(await server.getAccount(w.relayer.publicKey), {
        fee: '5000000',
        networkPassphrase: w.svm.networkPassphrase,
      })
        .addOperation(Operation.invokeHostFunction({ func: w.transferFn(), auth }))
        .setTimeout(300)
        .build();

    const sim = await server.simulateTransaction(await build([]));
    const assembled = rpc.assembleTransaction(await build([]), sim).build();
    assembled.sign(w.relayer.keypair);
    const sent = await server.sendTransaction(assembled);
    const got = await server.pollTransaction(sent.hash);

    expect(got.status, 'precondition: this transfer must fail').toBe('FAILED');
    expect(
      'diagnosticEventsXdr' in got,
      'the live node returns 22 diagnostic events for a failed transaction; ' +
        'this response has no diagnosticEventsXdr field at all, so the only ' +
        'thing a backend learns is the word FAILED',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The two documented submission paths disagree about what a transaction costs.
// ---------------------------------------------------------------------------

describe('the facade path and the envelope path disagree on fees and sequence', () => {
  /**
   * Measured, same contract, same operation, same wallet:
   *
   *   Contract.invoke(..., { as: alice })   seq 0 -> 0    balance unchanged
   *   rpc.Server send/poll                  seq 0 -> 1    balance -1,202,908 stroops
   *
   * README.md lists `.withFeeCharging(false)  // don't debit fees` under
   * "Escape hatches" directly beneath `new LiteStellar()`, with no note that it
   * governs only the envelope path. On the facade path — the one GUIDE.md calls
   * "the 90% path" — it is a no-op, because no fee is ever charged there.
   *
   * Consequence for a wallet backend: `svm.airdrop(0n)` produces a wallet with a
   * zero XLM balance that can still deploy contracts and invoke them forever. A
   * test asserting "the relayer runs out of XLM and submission fails" passes
   * green while asserting nothing.
   */
  it('debits a fee and consumes a sequence number on the facade path', () => {
    const svm = new LiteStellar();
    const alice = svm.airdrop();
    const c = svm.deployContract(CONTRACT_DATA, { as: alice });

    const seqBefore = alice.sequence();
    const balBefore = alice.balance();
    for (let i = 0; i < 5; i++) {
      c.invoke('put_persistent', [sc.sym('k'), sc.u64(BigInt(i))], { as: alice });
    }

    expect(alice.sequence(), 'five invocations should consume five sequence numbers')
      .toBe(seqBefore + 5n);
    expect(alice.balance(), 'five invocations should cost something').toBeLessThan(balBefore);
  });

  it('makes withFeeCharging(false) observable on the facade path', () => {
    const run = (svm: LiteStellar) => {
      const w = svm.airdrop();
      const c = svm.deployContract(CONTRACT_DATA, { as: w });
      c.invoke('put_persistent', [sc.sym('k'), sc.u64(1n)], { as: w });
      return w.balance();
    };
    const charged = run(new LiteStellar());
    const free = run(new LiteStellar().withFeeCharging(false));

    expect(
      charged,
      'withFeeCharging(false) is documented as an escape hatch on the LiteStellar ' +
        'constructor, but the facade path never charges a fee either way, so the ' +
        'switch changes nothing',
    ).toBeLessThan(free);
  });

  it('does not let a wallet with zero XLM submit forever', () => {
    const svm = new LiteStellar();
    const broke = svm.airdrop(0n);
    const c = svm.deployContract(CONTRACT_DATA);

    expect(broke.balance()).toBe(0n);
    const r = c.tryInvoke('put_persistent', [sc.sym('k'), sc.u64(1n)], { as: broke });
    expect(
      r.ok,
      'a source account holding zero XLM cannot pay any fee and cannot even meet ' +
        'the base reserve; on a real network this is txINSUFFICIENT_BALANCE',
    ).toBe(false);
  });
});
