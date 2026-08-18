// A newcomer's realistic app test, written from README.md + GUIDE.md only.
//
// Scenario: a wallet backend.
//   1. deploy a smart account through the factory (address predicted first)
//   2. fund it with a token
//   3. move value out of it, authorized by the account's passkey
//
// Every stop where the docs were insufficient is marked  // DOC-GAP N.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LiteStellar, sc } from '../src/litestellar.js';
import { createP256Signer, smartAccountSecp256r1, type P256Signer } from '../src/auth.js';

// DOC-GAP 1: GUIDE.md writes `svm.deployContract(ADD_I32_WASM)` / `FACTORY_WASM`
// / `SMART_ACCOUNT` but never says what those identifiers are or where the
// fixtures live. Guessed: a Buffer read off disk, fixtures under test/fixtures/.
const FACTORY_WASM = readFileSync(new URL('./fixtures/contract_factory.wasm', import.meta.url));
const SMART_ACCOUNT_WASM = readFileSync(new URL('./fixtures/smart_account_current.wasm', import.meta.url));

// DOC-GAP 2: GUIDE.md's factory + passkey snippets both call `signerFor(passkey)`
// / `adminSigner`, which is defined NOWHERE in the docs and is not exported by
// src/auth.ts. The nearest real export, `secp256r1SignerKey`, builds a
// `SignerKey`, NOT the `Signer` the constructor wants — using it fails.
// Recovering the real shape needed the contract's Rust source:
//   Signer::Secp256r1(Secp256r1Signer { public_key }, SignerRole::Admin)
function adminPasskeySigner(p: P256Signer) {
  return sc.vec([
    sc.sym('Secp256r1'),
    sc.map([{ key: sc.sym('public_key'), val: sc.bytes(p.publicKey) }]),
    sc.vec([sc.sym('Admin')]),
  ]);
}

describe('wallet backend: factory -> smart account -> fund -> move value', () => {
  let svm: LiteStellar;

  beforeEach(() => {
    svm = new LiteStellar();
  });

  it('deploys a smart account through the factory at the predicted address', () => {
    const deployer = svm.airdrop();
    const factory = svm.deployContract(FACTORY_WASM, { as: deployer });
    const wasmHash = svm.addContract(SMART_ACCOUNT_WASM);

    const passkey = createP256Signer();
    const salt = Buffer.alloc(32, 7);
    const ctorArgs = sc.vec([sc.vec([adminPasskeySigner(passkey)]), sc.vec([])]);

    const predicted = factory.view('get_deployed_address', [
      sc.bytes(salt),
      sc.bytes(Buffer.from(wasmHash, 'base64')),
      ctorArgs,
    ]);

    const args = sc.map([
      { key: sc.sym('constructor_args'), val: ctorArgs },
      { key: sc.sym('salt'), val: sc.bytes(salt) },
      { key: sc.sym('wasm_hash'), val: sc.bytes(Buffer.from(wasmHash, 'base64')) },
    ]);

    const deployed = factory.invoke('deploy', [args]);
    expect(deployed.toString()).toBe(predicted.toString());
  });

  it('funds the smart account with a token and moves value out with the passkey', () => {
    const deployer = svm.airdrop();
    const merchant = svm.airdrop();
    const factory = svm.deployContract(FACTORY_WASM, { as: deployer });
    const wasmHash = svm.addContract(SMART_ACCOUNT_WASM);

    const passkey = createP256Signer();
    const salt = Buffer.alloc(32, 9);
    const ctorArgs = sc.vec([sc.vec([adminPasskeySigner(passkey)]), sc.vec([])]);

    const deployed = factory.invoke('deploy', [
      sc.map([
        { key: sc.sym('constructor_args'), val: ctorArgs },
        { key: sc.sym('salt'), val: sc.bytes(salt) },
        { key: sc.sym('wasm_hash'), val: sc.bytes(Buffer.from(wasmHash, 'base64')) },
      ]),
    ]);
    const account = svm.contractAt(deployed.toString());

    // ---- fund it ---------------------------------------------------------
    const usdc = svm.deployToken({ code: 'USDC' });
    // DOC-GAP 3: GUIDE.md only ever shows `usdc.mint(alice, ...)` with a Wallet.
    // A Contract is NOT accepted — the signature is `Wallet | xdr.ScAddress`,
    // so you must reach for `.address`. Passing the Contract compiles under
    // `npm test` (no typecheck is wired) and dies at runtime with a 4 KB
    // js-xdr dump that includes the payer's SECRET SEED.
    usdc.mint(account.address, 1_000n);
    expect(usdc.balanceOf(account.address)).toBe(1_000n);

    // ---- move value out, authorized by the passkey -----------------------
    // DOC-GAP 5: GUIDE says "mint and transfer create one [trustline] for a
    // wallet recipient automatically" — but that is only true of the fixture
    // `Token.transfer`. Going through the SAC directly (which you must, to pass
    // signAuth) you get `Error(Contract, #13)` and the thrown message stops
    // there. The actionable text ("trustline entry is missing for account
    // G...") is only in `HostFailure.raw`, which vitest does not print.
    usdc.trust(merchant);
    const token = svm.contractAt(usdc.contractId);
    token.invoke(
      'transfer',
      // DOC-GAP 4: GUIDE.md lists `address` among the `sc` helpers with no
      // signature. It takes `Wallet | Contract | xdr.ScAddress` and NOT a
      // `C...` strkey — even though `contractAt()` and `adoptAccount()` both
      // take strkey strings. Passing one throws a bare JS TypeError:
      //   "Cannot use 'in' operator to search for 'address' in CDNXE5..."
      // Note the union here (Wallet|Contract|ScAddress) is not the same union
      // `mint`/`balanceOf` accept (Wallet|ScAddress). Same library, same
      // concept, two different accepted types.
      [sc.address(account), merchant.scAddress, sc.i128(250n)],
      { signAuth: smartAccountSecp256r1(passkey) },
    );

    expect(usdc.balanceOf(account.address)).toBe(750n);
    expect(usdc.balanceOf(merchant)).toBe(250n);
  });
});
