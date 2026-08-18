/**
 * ROUND-2 ADVERSARIAL RE-TEST of the round-1 "operation source is the Soroban
 * invoker" fix (src/classic.ts:384-390, :417-426).
 *
 * Ground truth:
 *   InvokeHostFunctionOpFrame.cpp:693,706 -- `toCxxBuf(mOpFrame.getSourceID())`
 *     is what reaches the host as the invoker.
 *   OperationFrame.cpp:203-207,:217-232 -- the OPERATION source is checked
 *     against ITS OWN threshold (MEDIUM for InvokeHostFunction).
 *   TransactionFrame.cpp:530-539 (checkAllTransactionSignatures) -- and,
 *     SEPARATELY, the TRANSACTION source is checked against ITS thresholds[LOW].
 *     Both checks run; core requires both to pass.
 *
 * The round-1 fix replaced the tx-source MEDIUM check with an op-source MEDIUM
 * check. It did not ADD the op-source check alongside the tx-source one, so the
 * transaction source is now never authenticated at all when the operation names
 * its own source.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  xdr,
  Keypair,
  Networks,
  StrKey,
  Asset,
  Address,
  nativeToScVal,
  hash as sha256,
} from '@stellar/stellar-sdk';
import { Ledger, createContractHostFn, invokeHostFn } from '../../src/index.js';
import { accountIdFromPublicKey, loadAccount, BASE_FEE } from '../../src/classic.js';

const CODE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/contract_data.wasm', import.meta.url))),
);
const NET = Networks.TESTNET;
const NETWORK_ID = sha256(NET);
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const accB64 = (pk: string) => accountIdFromPublicKey(pk).toXDR('base64');
const plain = (pk: string) => xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(pk));
const RESOURCE_FEE = 2_000_000n;

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
const signWith = (raw: xdr.Transaction, kps: Keypair[]) =>
  envelope(raw, kps.map((k) => k.signDecorated(txHash(raw))));

function build(
  txSource: string,
  seqNum: bigint,
  hostFn: xdr.HostFunction,
  resources: xdr.SorobanResources,
  opSource?: string,
  auth: xdr.SorobanAuthorizationEntry[] = [],
): xdr.Transaction {
  return new xdr.Transaction({
    sourceAccount: plain(txSource),
    fee: Number(RESOURCE_FEE + BigInt(BASE_FEE)),
    seqNum: new xdr.SequenceNumber(new xdr.Int64(seqNum)),
    cond: xdr.Preconditions.precondNone(),
    memo: xdr.Memo.memoNone(),
    operations: [
      new xdr.Operation({
        sourceAccount: opSource ? plain(opSource) : null,
        body: xdr.OperationBody.invokeHostFunction(
          new xdr.InvokeHostFunctionOp({ hostFunction: hostFn, auth }),
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

describe('ROUND 2 — operation source as the Soroban invoker', () => {
  let L: Ledger;

  beforeEach(() => {
    L = new Ledger();
  });

  it('HOLDS: the OP source, not the tx source, reaches the host as the invoker', () => {
    // A SAC `mint` is authorized by the ISSUER as the transaction source
    // account (source-account credentials carry no signature). If the harness
    // handed the host the TX source, the mint would fail authorization.
    const issuer = Keypair.random();
    const payer = Keypair.random();
    const holder = Keypair.random();
    L.fund(issuer.publicKey());
    L.fund(payer.publicKey());
    L.fund(holder.publicKey());

    // Deploy the SAC (as the issuer, plain host-function path).
    const asset = new Asset('TST', issuer.publicKey());
    const sacFn = xdr.HostFunction.hostFunctionTypeCreateContract(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(asset.toXDRObject()),
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      }),
    );
    const d = L.simulateAndSend(sacFn, accB64(issuer.publicKey()));
    expect(d.sent.ok, d.sent.error).toBe(true);

    // A trustline for the holder, poked straight in.
    const tlAsset = xdr.TrustLineAsset.assetTypeCreditAlphanum4(
      new xdr.AlphaNum4({
        assetCode: Buffer.concat([Buffer.from('TST', 'ascii'), Buffer.alloc(4)], 4),
        issuer: accountIdFromPublicKey(issuer.publicKey()),
      }),
    );
    L.putEntry(
      new xdr.LedgerEntry({
        lastModifiedLedgerSeq: L.ledgerSeq,
        data: xdr.LedgerEntryData.trustline(
          new xdr.TrustLineEntry({
            accountId: accountIdFromPublicKey(holder.publicKey()),
            asset: tlAsset,
            balance: new xdr.Int64(0n),
            limit: new xdr.Int64(9_223_372_036_854_775_807n),
            flags: xdr.TrustLineFlags.authorizedFlag().value,
            ext: new xdr.TrustLineEntryExt(0),
          }),
        ),
        ext: new xdr.LedgerEntryExt(0),
      }).toXDR('base64'),
    );

    const sacAddr = Address.fromString(asset.contractId(L.networkPassphrase)).toScAddress();
    const mintFn = invokeHostFn(sacAddr, 'mint', [
      xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(accountIdFromPublicKey(holder.publicKey()))),
      i128(1_000n),
    ]);
    // Simulate AS THE ISSUER, so the recorded auth is source-account credentials
    // naming the issuer — exactly what a real client would submit.
    const sim = L.simulate(mintFn, accB64(issuer.publicKey()));
    expect(sim.ok, sim.error).toBe(true);
    const resources = xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64');
    const auth = sim.authXdr.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64'));

    // tx source = payer (pays the fee, bumps its seq), op source = issuer.
    const raw = build(
      payer.publicKey(),
      BigInt(loadAccount(L, accountIdFromPublicKey(payer.publicKey()))!.seqNum().toString()) + 1n,
      mintFn,
      resources,
      issuer.publicKey(),
      auth,
    );
    const out = L.sendTransaction(signWith(raw, [payer, issuer]));
    expect(out.code, `${out.code} / ${out.error ?? out.detail}`).toBe('txSUCCESS');

    // And the classic side-effects went to the TX source, as core does.
    expect(loadAccount(L, accountIdFromPublicKey(payer.publicKey()))!.seqNum().toString()).toBe('1');
    expect(loadAccount(L, accountIdFromPublicKey(issuer.publicKey()))!.seqNum().toString()).toBe('0');
  });

  it('HOLDS: the op source is checked against ITS OWN medium threshold', () => {
    const a = Keypair.random();
    const other = Keypair.random();
    L.fund(a.publicKey());
    L.fund(other.publicKey(), { thresholds: [1, 1, 5, 5] });
    const { hostFn, resources } = fixture(L);
    const raw = build(a.publicKey(), 1n, hostFn, resources, other.publicKey());
    const out = L.sendTransaction(signWith(raw, [a, other]));
    // core: opBAD_AUTH -> txFAILED. The harness says txBAD_AUTH. Either way it
    // is rejected, which is what this assertion pins.
    expect(out.ok).toBe(false);
    expect(['txFAILED', 'txBAD_AUTH']).toContain(out.code);
  });

  it('HOLDS: a nonexistent op source is rejected', () => {
    const a = Keypair.random();
    const ghost = Keypair.random();
    L.fund(a.publicKey());
    const { hostFn, resources } = fixture(L);
    const raw = build(a.publicKey(), 1n, hostFn, resources, ghost.publicKey());
    const out = L.sendTransaction(signWith(raw, [a]));
    expect(out.ok).toBe(false);
  });

  it('DEFECT: the TRANSACTION source is never authenticated once the op names a source', () => {
    // core runs BOTH checks:
    //   checkAllTransactionSignatures(txSource, thresholds[THRESHOLD_LOW])
    //   OperationFrame::checkSignature(opSource, MEDIUM)
    // The harness runs only the second. `victim` pays the fee and has its
    // sequence number consumed without ever signing anything.
    const victim = Keypair.random();
    const attacker = Keypair.random();
    L.fund(victim.publicKey(), { thresholds: [1, 1, 1, 1] });
    L.fund(attacker.publicKey(), { thresholds: [1, 1, 1, 1] });

    const balanceBefore = BigInt(
      loadAccount(L, accountIdFromPublicKey(victim.publicKey()))!.balance().toString(),
    );

    const { hostFn, resources } = fixture(L);
    const raw = build(victim.publicKey(), 1n, hostFn, resources, attacker.publicKey());
    // Signed ONLY by the attacker (the op source). The victim's LOW threshold
    // of 1 is not met by anything.
    const out = L.sendTransaction(signWith(raw, [attacker]));

    // Corollary, checked FIRST so it is visible even though the code assertion
    // below is the headline: the fee and the sequence number of the account
    // that signed nothing were both consumed.
    const balanceAfter = BigInt(
      loadAccount(L, accountIdFromPublicKey(victim.publicKey()))!.balance().toString(),
    );
    const seqAfter = loadAccount(L, accountIdFromPublicKey(victim.publicKey()))!.seqNum().toString();
    console.log(
      `[r2] tx-source-LOW gap: code=${out.code} victimDebited=${balanceBefore - balanceAfter} victimSeq=${seqAfter}`,
    );

    expect(out.code, `harness said ${out.code}`).toBe('txBAD_AUTH');
    expect(balanceAfter, 'the unsigning tx source must not be charged').toBe(balanceBefore);
  });

  it('CONTEXT: the op-source threshold failure uses the wrong result code', () => {
    // Live protocol-27 node (standalone, verified by running): the same
    // envelope comes back status=ERROR, txFailed, operation code opBadAuth,
    // and the tx source sequence number is NOT consumed. The harness rejects
    // it too, but reports it as a TRANSACTION-level txBAD_AUTH.
    const a = Keypair.random();
    const other = Keypair.random();
    L.fund(a.publicKey());
    L.fund(other.publicKey(), { thresholds: [1, 1, 5, 5] });
    const { hostFn, resources } = fixture(L);
    const raw = build(a.publicKey(), 1n, hostFn, resources, other.publicKey());
    const out = L.sendTransaction(signWith(raw, [a, other]));
    console.log(`[r2] op-source MEDIUM failure: harness code=${out.code}, core=txFAILED/opBadAuth`);
    expect(out.code).toBe('txFAILED');
  });
});

/** Deploy contract_data and produce a matching host function + resources. */
function fixture(L: Ledger) {
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
  return { hostFn, resources: xdr.SorobanResources.fromXDR(sim.resourcesXdr, 'base64') };
}
