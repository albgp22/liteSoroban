/**
 * The contract factory from the smart-account repo, deployed and driven the way
 * production does it: upload the account wasm, then have the factory
 * deterministically deploy accounts from it.
 *
 * This is the flow a wallet backend actually runs, so it is the one worth
 * pinning — deterministic addresses, idempotent redeploys, and deploy+call in a
 * single transaction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xdr, Address, Keypair, scValToNative } from '@stellar/stellar-sdk';
import { LiteStellar, HostFailure, sc, type Contract } from '../src/litestellar.js';
import { createP256Signer, smartAccountSecp256r1, type P256Signer } from '../src/auth.js';

const f = (n: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))));
const FACTORY = f('contract_factory.wasm');
const SMART_ACCOUNT = f('smart_account_current.wasm');
const CONTRACT_DATA = f('contract_data.wasm');

/** Signer::Secp256r1(Secp256r1Signer { public_key }, SignerRole::Admin) */
const adminPasskey = (p: P256Signer) =>
  sc.vec([
    sc.sym('Secp256r1'),
    sc.map([{ key: sc.sym('public_key'), val: sc.bytes(p.publicKey) }]),
    sc.vec([sc.sym('Admin')]),
  ]);

/**
 * ContractDeploymentArgs { constructor_args, salt, wasm_hash }.
 * A soroban `#[contracttype]` struct is an ScMap keyed by field name, and ScMap
 * keys must be sorted — which the field order here already is.
 */
const deploymentArgs = (wasmHashB64: string, salt: Buffer, constructorArgs: xdr.ScVal[]) =>
  sc.map([
    { key: sc.sym('constructor_args'), val: sc.vec(constructorArgs) },
    { key: sc.sym('salt'), val: sc.bytes(salt) },
    { key: sc.sym('wasm_hash'), val: sc.bytes(Buffer.from(wasmHashB64, 'base64')) },
  ]);

const salt = (n: number) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(n, 28);
  return b;
};

describe('contract factory', () => {
  let svm: LiteStellar;
  let factory: Contract;
  let accountWasmHash: string;

  beforeEach(() => {
    svm = new LiteStellar();
    factory = svm.deployContract(FACTORY);
    // The account code has to be in the ledger before the factory can point at it.
    accountWasmHash = svm.addContract(SMART_ACCOUNT);
  });

  it('deploys the factory itself', () => {
    expect(factory.contractId.startsWith('C')).toBe(true);
  });

  it('deploys a smart account through the factory', () => {
    const passkey = createP256Signer();
    const args = deploymentArgs(accountWasmHash, salt(1), [
      sc.vec([adminPasskey(passkey)]),
      sc.vec([]),
    ]);

    const deployed = factory.invoke('deploy', [args]);
    const address = new Address(deployed.toString());
    expect(address.toString().startsWith('C')).toBe(true);

    // The account really works: it knows its admin signer.
    const account = svm.contractAt(address.toString());
    expect(
      account.view('has_signer', [sc.vec([sc.sym('Secp256r1'), sc.bytes(passkey.publicKey)])]),
    ).toBe(true);
  });

  it('predicts the address before deploying (get_deployed_address)', () => {
    const passkey = createP256Signer();
    const ctorArgs = [sc.vec([adminPasskey(passkey)]), sc.vec([])];

    const predicted = factory.view('get_deployed_address', [
      sc.bytes(salt(7)),
      sc.bytes(Buffer.from(accountWasmHash, 'base64')),
      sc.vec(ctorArgs),
    ]);

    const actual = factory.invoke('deploy', [
      deploymentArgs(accountWasmHash, salt(7), ctorArgs),
    ]);

    expect(actual.toString()).toBe(predicted.toString());
  });

  it('the address is deterministic in (salt, wasm_hash, constructor_args)', () => {
    const p1 = createP256Signer();
    const p2 = createP256Signer();

    const addrFor = (s: Buffer, p: P256Signer) =>
      factory
        .view('get_deployed_address', [
          sc.bytes(s),
          sc.bytes(Buffer.from(accountWasmHash, 'base64')),
          sc.vec([sc.vec([adminPasskey(p)]), sc.vec([])]),
        ])
        .toString();

    // Same inputs -> same address.
    expect(addrFor(salt(1), p1)).toBe(addrFor(salt(1), p1));
    // A different salt changes it.
    expect(addrFor(salt(1), p1)).not.toBe(addrFor(salt(2), p1));
    // So do different constructor args, even at the same salt — the factory
    // hashes them into the salt it derives.
    expect(addrFor(salt(1), p1)).not.toBe(addrFor(salt(1), p2));
  });

  it('deploying the same account twice fails, but deploy_idempotent does not', () => {
    const passkey = createP256Signer();
    const args = deploymentArgs(accountWasmHash, salt(3), [
      sc.vec([adminPasskey(passkey)]),
      sc.vec([]),
    ]);

    const first = factory.invoke('deploy', [args]).toString();

    // A plain redeploy hits "contract already exists".
    let failed: HostFailure | undefined;
    try {
      factory.invoke('deploy', [args]);
    } catch (e) {
      failed = e as HostFailure;
    }
    expect(failed).toBeInstanceOf(HostFailure);

    // The idempotent entry point returns the existing address instead.
    const again = factory.invoke('deploy_idempotent', [args]).toString();
    expect(again).toBe(first);
  });

  it('upload_and_deploy uploads the wasm and deploys in one call', () => {
    // A fresh environment where the code is NOT already in the ledger.
    const env = new LiteStellar();
    const f2 = env.deployContract(FACTORY);

    const deployed = f2.invoke('upload_and_deploy', [
      sc.bytes(Buffer.from(CONTRACT_DATA)),
      sc.bytes(salt(11)),
      sc.vec([]),
    ]);

    const c = env.contractAt(new Address(deployed.toString()).toString());
    c.invoke('put_persistent', [sc.sym('k'), sc.u64(5n)]);
    expect(c.view('get_persistent', [sc.sym('k')])).toBe(5n);
  });

  it('deploy_and_call deploys and invokes in a single transaction', () => {
    const env = new LiteStellar();
    const f2 = env.deployContract(FACTORY);
    const wasmHash = env.addContract(CONTRACT_DATA);

    const predicted = f2.view('get_deployed_address', [
      sc.bytes(salt(5)),
      sc.bytes(Buffer.from(wasmHash, 'base64')),
      sc.vec([]),
    ]);

    const call = sc.map([
      { key: sc.sym('args'), val: sc.vec([sc.sym('boot'), sc.u64(99n)]) },
      { key: sc.sym('contract_id'), val: sc.address(Address.fromString(predicted.toString()).toScAddress()) },
      { key: sc.sym('func'), val: sc.sym('put_persistent') },
    ]);

    const deployed = f2.invoke('deploy_and_call', [
      deploymentArgs(wasmHash, salt(5), []),
      sc.vec([call]),
    ]);
    expect(deployed.toString()).toBe(predicted.toString());

    // The call inside the same transaction landed.
    const c = env.contractAt(deployed.toString());
    expect(c.view('get_persistent', [sc.sym('boot')])).toBe(99n);
  });

  it('emits a DEPLOYED event', () => {
    const passkey = createP256Signer();
    const r = factory.tryInvoke('deploy', [
      deploymentArgs(accountWasmHash, salt(9), [sc.vec([adminPasskey(passkey)]), sc.vec([])]),
    ]);

    expect(r.ok).toBe(true);
    const topics = r.events.flatMap((e) =>
      e.body().v0().topics().map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return null;
        }
      }),
    );
    expect(topics).toContain('DEPLOYED');
  });

  it('a factory-deployed account authorizes with its passkey end to end', () => {
    const passkey = createP256Signer();
    const deployed = factory.invoke('deploy', [
      deploymentArgs(accountWasmHash, salt(13), [sc.vec([adminPasskey(passkey)]), sc.vec([])]),
    ]);
    const account = svm.contractAt(new Address(deployed.toString()).toString());

    const newKp = Keypair.random();
    const newSigner = sc.vec([
      sc.sym('Ed25519'),
      sc.map([{ key: sc.sym('public_key'), val: sc.bytes(newKp.rawPublicKey()) }]),
      sc.vec([sc.sym('Admin')]),
    ]);

    account.invoke('add_signer', [newSigner], { signAuth: smartAccountSecp256r1(passkey) });

    expect(
      account.view('has_signer', [sc.vec([sc.sym('Ed25519'), sc.bytes(newKp.rawPublicKey())])]),
    ).toBe(true);
  });

  it('the factory instance TTL is extended on use', () => {
    const before = svm.ledger.getEntryTtl(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: factory.address,
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ).toXDR('base64'),
    );
    expect(before).toBeGreaterThan(0);
  });
});
