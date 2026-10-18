/**
 * CAP-71 credentials through rpc.Server: what `useUpgradedAuth` records.
 *
 * SDK 17 sends `useUpgradedAuth: true` with every simulateTransaction and
 * prepareTransaction unless told otherwise (rpc/server.js). stellar-rpc passes
 * it to preflight (simulate_transaction.go), which hands it to the host as
 * `RecordingInvocationAuthMode::recording(disable_non_root_auth,
 * use_upgraded_auth)` (lib/preflight/src/shared.rs and lib.rs, v29.0.1), so a
 * recording simulation returns SOROBAN_CREDENTIALS_ADDRESS_V2 entries instead of
 * legacy Address ones. The request field is a plain Go bool (go-stellar-sdk
 * v0.7.2 protocols/rpc/simulate_transaction.go): omitted and null mean false.
 *
 * Checked on a local protocol-29 node (stellar/quickstart: stellar-core 29.0.0,
 * stellar-rpc 29.0.1) on 2026-10-18, with auth_test_contract `do_auth` and a
 * signer that is not the source, against the harness:
 *   SDK default, true       -> sorobanCredentialsAddressV2
 *   false, omitted, null    -> sorobanCredentialsAddress
 *   "true", 1, {}, [true]   -> -32602 "invalid parameters", Go's unmarshal error
 * Legacy and V2 recorded the same footprint and the same resources (534,979
 * instructions on each side), and an entry of each address arm (legacy, V2,
 * WithDelegates) signed with signAuthEntriesSync applied. The node and the
 * harness agreed on each.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { LiteStellar, signAuthEntriesSync } from '../src/litestellar.js';
import { invokeHostFn } from '../src/index.js';

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
  const doAuthArgs = (signer: Keypair) => [
    new Address(signer.publicKey()).toScVal(),
    nativeToScVal(1, { type: 'u32' }),
  ];
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
          args: doAuthArgs(signer),
          auth,
        }),
      )
      .setTimeout(0)
      .build();
  };
  /** Raw JSON-RPC to the facade, for request shapes the SDK cannot send. */
  const rawSimulate = async (extra: Record<string, unknown>, source: Keypair, signer: Keypair) => {
    const transaction = (await doAuth(source, signer)).toXdr();
    const res = await (server as any).httpClient.defaults.adapter({
      url: 'https://in-process.invalid',
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: { transaction, ...extra } }),
    });
    return res.data;
  };
  return { svm, server, contract, account, doAuth, doAuthArgs, rawSimulate };
}

const arms = (sim: rpc.Api.SimulateTransactionResponse) => {
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(sim.error);
  return sim.result!.auth.map((e) => e.credentials.type);
};
const rawArms = (body: any): string[] =>
  body.result.results[0].auth.map((a: string) => xdr.SorobanAuthorizationEntry.fromXdr(a, 'base64').credentials.type);

/** The ScVal an ed25519 account's auth entry carries: vec[map{public_key, signature}]. */
const accountSignature = (kp: Keypair) => (payload: Buffer) =>
  xdr.ScVal.scvVec([
    nativeToScVal(
      { public_key: StrKey.decodeEd25519PublicKey(kp.publicKey()), signature: kp.sign(payload) },
      { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
    ),
  ]);

describe('simulateTransaction records the credentials useUpgradedAuth asks for', () => {
  it('SDK 17 asks for V2 by default, and gets it', async () => {
    const w = world();
    const [a, b] = [w.account(), Keypair.random()];
    expect(arms(await w.server.simulateTransaction(await w.doAuth(a, b)))).toEqual([
      'sorobanCredentialsAddressV2',
    ]);
    expect(arms(await w.server.simulateTransaction(await w.doAuth(a, b), undefined, undefined, true))).toEqual([
      'sorobanCredentialsAddressV2',
    ]);
  });

  it('useUpgradedAuth false records legacy Address credentials', async () => {
    const w = world();
    const sim = await w.server.simulateTransaction(await w.doAuth(w.account(), Keypair.random()), undefined, undefined, false);
    expect(arms(sim)).toEqual(['sorobanCredentialsAddress']);
  });

  it('omitted or null, the request records legacy Address credentials, as a node defaults a Go bool', async () => {
    const w = world();
    const a = w.account();
    expect(rawArms(await w.rawSimulate({}, a, Keypair.random()))).toEqual(['sorobanCredentialsAddress']);
    expect(rawArms(await w.rawSimulate({ useUpgradedAuth: null }, a, Keypair.random()))).toEqual([
      'sorobanCredentialsAddress',
    ]);
  });

  it.each([
    ['string', 'true'],
    ['number', 1],
    ['object', {}],
    ['array', [true]],
  ])('a %s is refused before simulation, with the error a node returns', async (jsonType, value) => {
    const w = world();
    const body = await w.rawSimulate({ useUpgradedAuth: value }, w.account(), Keypair.random());
    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({
      code: -32602,
      message: 'invalid parameters',
      data: `json: cannot unmarshal ${jsonType} into Go struct field SimulateTransactionRequest.useUpgradedAuth of type bool`,
    });
  });

  it('only the arm changes: same invocation, address, footprint and resources', async () => {
    const w = world();
    const [a, b] = [w.account(), Keypair.random()];
    const legacy = await w.server.simulateTransaction(await w.doAuth(a, b), undefined, undefined, false);
    const v2 = await w.server.simulateTransaction(await w.doAuth(a, b), undefined, undefined, true);
    if (!rpc.Api.isSimulationSuccess(legacy) || !rpc.Api.isSimulationSuccess(v2)) throw new Error('simulation failed');

    const [l] = legacy.result!.auth;
    const [v] = v2.result!.auth;
    const lc = xdr.expectUnionVariant(l.credentials, 'sorobanCredentialsAddress').address;
    const vc = xdr.expectUnionVariant(v.credentials, 'sorobanCredentialsAddressV2').addressV2;
    expect(v.rootInvocation.toXdr('base64')).toBe(l.rootInvocation.toXdr('base64'));
    expect(vc.address.toXdr('base64')).toBe(lc.address.toXdr('base64'));
    expect([vc.signatureExpirationLedger, vc.signature.type]).toEqual([0, 'scvVoid']);

    // The nonce is fresh per simulation, and it is in the read-write footprint.
    const lr = legacy.transactionData.build().resources;
    const vr = v2.transactionData.build().resources;
    expect([vr.instructions, vr.diskReadBytes, vr.writeBytes]).toEqual([lr.instructions, lr.diskReadBytes, lr.writeBytes]);
    expect(vr.footprint.readOnly.map((k) => k.toXdr('base64'))).toEqual(lr.footprint.readOnly.map((k) => k.toXdr('base64')));
    const nonceKey = (k: xdr.LedgerKey) => xdr.expectUnionVariant(k, 'contractData').contractData.key.type;
    expect(vr.footprint.readWrite.map(nonceKey)).toEqual(['scvLedgerKeyNonce']);
    expect(lr.footprint.readWrite.map(nonceKey)).toEqual(['scvLedgerKeyNonce']);
    expect(v2.minResourceFee).toBe(legacy.minResourceFee);
  });

  it('an envelope that carries auth simulates in enforcing mode and returns it unchanged, whatever the flag', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const recorded = await w.server.simulateTransaction(await w.doAuth(a, b), undefined, undefined, false);
    if (!rpc.Api.isSimulationSuccess(recorded)) throw new Error(recorded.error);
    const latest = (await w.server.getLatestLedger()).sequence;
    const signed = await authorizeEntry(recorded.result!.auth[0], b, latest + 100, w.svm.networkPassphrase);

    const sim = await w.server.simulateTransaction(await w.doAuth(a, b, [signed]), undefined, undefined, true);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(sim.error);
    expect(sim.result!.auth.map((e) => e.toXdr('base64'))).toEqual([signed.toXdr('base64')]);
  });
});

describe('the SDK round trip with V2 entries', () => {
  it('simulate (V2) -> authorizeEntry -> prepareTransaction -> send applies', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const recorded = await w.server.simulateTransaction(await w.doAuth(a, b));
    if (!rpc.Api.isSimulationSuccess(recorded)) throw new Error(recorded.error);
    const latest = (await w.server.getLatestLedger()).sequence;
    const signed = await authorizeEntry(recorded.result!.auth[0], b, latest + 100, w.svm.networkPassphrase);
    expect(signed.credentials.type).toBe('sorobanCredentialsAddressV2');

    const tx = await w.server.prepareTransaction(await w.doAuth(a, b, [signed]));
    tx.sign(a);
    const got = await w.server.getTransaction((await w.server.sendTransaction(tx)).hash);
    expect(got.status).toBe('SUCCESS');
  });
});

describe('signAuthEntriesSync signs every address arm as the SDK does', () => {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(Buffer.alloc(32, 3))),
        functionName: 'go',
        args: [],
      }),
    ),
    subInvocations: [],
  });
  const kp = Keypair.random();
  const addrCreds = () =>
    new xdr.SorobanAddressCredentials({
      address: new Address(kp.publicKey()).toScAddress(),
      nonce: 7n,
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    });
  const SIG = xdr.ScVal.scvBytes(Buffer.alloc(4, 1));
  // A delegate that already carries its own signature, which signing the
  // top-level credentials must leave alone (applyExpirationAndSignature).
  const delegate = new xdr.SorobanDelegateSignature({
    address: new Address(Keypair.random().publicKey()).toScAddress(),
    signature: xdr.ScVal.scvBytes(Buffer.alloc(4, 9)),
    nestedDelegates: [],
  });

  it.each([
    ['sorobanCredentialsAddress', () => xdr.SorobanCredentials.sorobanCredentialsAddress(addrCreds())],
    ['sorobanCredentialsAddressV2', () => xdr.SorobanCredentials.sorobanCredentialsAddressV2(addrCreds())],
    [
      'sorobanCredentialsAddressWithDelegates',
      () =>
        xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
          new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials: addrCreds(), delegates: [delegate] }),
        ),
    ],
  ] as const)('%s: the signed entry is byte-identical to authorizeEntry\'s', async (arm, credentials) => {
    const entry = new xdr.SorobanAuthorizationEntry({ rootInvocation: invocation, credentials: credentials() });
    const sdk = await authorizeEntry(entry, async () => ({ signatureScVal: SIG }), 12345, Networks.TESTNET);
    const [ours] = signAuthEntriesSync([entry.toXdr('base64')], {
      sign: () => SIG,
      networkPassphrase: Networks.TESTNET,
      validUntilLedgerSeq: 12345,
    });
    expect(xdr.SorobanAuthorizationEntry.fromXdr(ours, 'base64').credentials.type).toBe(arm);
    expect(ours).toBe(sdk.toXdr('base64'));
  });

  it('a V2 entry the facade recorded, signed with it, applies', async () => {
    const w = world();
    const [a, b] = [w.account(), w.account()];
    const recorded = await w.server.simulateTransaction(await w.doAuth(a, b));
    if (!rpc.Api.isSimulationSuccess(recorded)) throw new Error(recorded.error);
    const latest = (await w.server.getLatestLedger()).sequence;
    const signed = signAuthEntriesSync(
      recorded.result!.auth.map((e) => e.toXdr('base64')),
      { sign: accountSignature(b), networkPassphrase: w.svm.networkPassphrase, validUntilLedgerSeq: latest + 100 },
    ).map((e) => xdr.SorobanAuthorizationEntry.fromXdr(e, 'base64'));
    expect(signed.map((e) => e.credentials.type)).toEqual(['sorobanCredentialsAddressV2']);

    const tx = await w.server.prepareTransaction(await w.doAuth(a, b, signed));
    tx.sign(a);
    const got = await w.server.getTransaction((await w.server.sendTransaction(tx)).hash);
    expect(got.status).toBe('SUCCESS');
  });
});

describe("LiteStellar's direct path records legacy Address credentials", () => {
  // Not an RPC request, so there is no client default to follow: it records
  // what a node records when the flag is absent. Both arms apply alike.
  it('by default, and V2 when Ledger.simulate is asked for it', () => {
    const w = world();
    const source = w.svm.airdrop();
    const fn = invokeHostFn(w.contract.address, 'do_auth', w.doAuthArgs(Keypair.random()));
    const arm = (authXdr: string[]) => authXdr.map((e) => xdr.SorobanAuthorizationEntry.fromXdr(e, 'base64').credentials.type);
    expect(arm(w.svm.ledger.simulate(fn, source.accountIdB64).authXdr)).toEqual(['sorobanCredentialsAddress']);
    expect(arm(w.svm.ledger.simulate(fn, source.accountIdB64, undefined, undefined, true).authXdr)).toEqual([
      'sorobanCredentialsAddressV2',
    ]);
  });
});
