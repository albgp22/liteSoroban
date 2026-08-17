/**
 * Signing Soroban authorization entries for CUSTOM ACCOUNTS.
 *
 * Simulation records auth entries but never runs `__check_auth`; the enforcing
 * path does. So a contract that authorizes through a custom account will
 * simulate green and fail on submit until its auth entries carry a real proof.
 * Producing that proof is client-side logic, and this is where it gets tested.
 *
 * The heavy lifting is the SDK's own `authorizeEntry`, which builds the
 * `HashIDPreimage::SorobanAuthorization` preimage (network id, nonce,
 * signatureExpirationLedger, invocation) and hashes it. v16.2.0 accepts a signer
 * callback returning `{ signatureScVal }` (base/auth.js:40-42), which is the
 * escape hatch custom accounts need — the default path assumes a raw ed25519
 * signature over the payload and verifies it against the entry's address.
 */
import { xdr, authorizeEntry, Keypair } from '@stellar/stellar-sdk';
import type { Ledger } from './index.js';

/**
 * Turns the 32-byte authorization payload into whatever `__check_auth` expects.
 * May be async — P-256 signers often are.
 */
export type AuthProofBuilder = (payload: Buffer) => xdr.ScVal | Promise<xdr.ScVal>;

export interface SignAuthOptions {
  sign: AuthProofBuilder;
  /** Defaults to 100 ledgers ahead of the current one. */
  validUntilLedgerSeq?: number;
}

/**
 * Sign every address-credential entry in a simulation's recorded auth.
 * Source-account credentials are returned untouched (authorizeEntry no-ops).
 */
export async function signAuthEntries(
  ledger: Ledger,
  authXdr: string[],
  opts: SignAuthOptions,
): Promise<string[]> {
  const validUntil = opts.validUntilLedgerSeq ?? ledger.ledgerSeq + 100;
  const signed: string[] = [];
  for (const b64 of authXdr) {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64');
    const result = await authorizeEntry(
      entry,
      async (_preimage: xdr.HashIdPreimage, payload: Buffer) => ({
        signatureScVal: await opts.sign(payload),
      }),
      validUntil,
      ledger.networkPassphrase,
    );
    signed.push(result.toXDR('base64'));
  }
  return signed;
}

// ---------------------------------------------------------------------------
// Crossmint/stellar-smart-account proof format
// ---------------------------------------------------------------------------
//
//   SignatureProofs(pub Map<SignerKey, SignerProof>)   // tuple struct, field "0"
//   enum SignerKey   { Ed25519(BytesN<32>), Secp256r1(BytesN<65>), ... }
//   enum SignerProof { Ed25519(BytesN<64>), Secp256r1(BytesN<64>), ... }
//
// soroban-sdk encodes a unit-or-tuple `#[contracttype]` enum as
// ScVal::Vec([Symbol(case), ...fields]) and a tuple struct as ScVal::Vec of its
// fields, which is why SignatureProofs wraps the map in a one-element vec.

export function ed25519SignerKey(publicKey: Buffer | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Ed25519'),
    xdr.ScVal.scvBytes(Buffer.from(publicKey)),
  ]);
}

export function ed25519SignerProof(signature: Buffer | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Ed25519'),
    xdr.ScVal.scvBytes(Buffer.from(signature)),
  ]);
}

/**
 * Wrap signer→proof pairs as `SignatureProofs`.
 *
 * ScMap keys MUST be in ascending order; the host rejects an unsorted map with
 * `Error(Object, InvalidInput)`. For same-shaped keys the host's ScVal ordering
 * agrees with a lexicographic comparison of the encoded key.
 */
export function signatureProofs(entries: { key: xdr.ScVal; proof: xdr.ScVal }[]): xdr.ScVal {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(a.key.toXDR(), b.key.toXDR()),
  );
  const map = xdr.ScVal.scvMap(
    sorted.map((e) => new xdr.ScMapEntry({ key: e.key, val: e.proof })),
  );
  return xdr.ScVal.scvVec([map]);
}

/**
 * The full custom-account round trip, which is what an app must actually do:
 *
 *   1. simulate            -> recorded auth entries (no __check_auth run)
 *   2. sign those entries  -> a proof __check_auth will accept
 *   3. RE-simulate under enforcing auth -> footprint that covers what
 *                                          __check_auth reads
 *   4. send                -> applies
 *
 * Skipping step 3 fails with `Error(Storage, ExceededLimit)` and
 * "trying to access contract data key outside of the footprint", because the
 * first simulation never entered __check_auth and so never saw its reads.
 */
export async function authorizeAndSend(
  ledger: Ledger,
  hostFn: xdr.HostFunction,
  sourceB64: string,
  opts: SignAuthOptions,
) {
  const recorded = ledger.simulate(hostFn, sourceB64);
  if (!recorded.ok) throw new Error(`simulation failed: ${recorded.error}`);

  const signedAuth = await signAuthEntries(ledger, recorded.authXdr, opts);

  const enforced = ledger.simulateWithAuth(hostFn, sourceB64, signedAuth);
  if (!enforced.ok) throw new Error(`enforcing simulation failed: ${enforced.error}`);

  const sent = ledger.send(
    hostFn,
    sourceB64,
    enforced.resourcesXdr,
    signedAuth,
    enforced.restoredRwEntryIndices,
  );
  return { recorded, enforced, signedAuth, sent };
}

/** A single-ed25519-signer proof builder for the smart account. */
export function smartAccountEd25519(kp: Keypair): AuthProofBuilder {
  return (payload) =>
    signatureProofs([
      { key: ed25519SignerKey(kp.rawPublicKey()), proof: ed25519SignerProof(kp.sign(payload)) },
    ]);
}

// ---------------------------------------------------------------------------
// secp256r1 (P-256) — the passkey path
// ---------------------------------------------------------------------------
//
// The contract verifies with `env.crypto().secp256r1_verify(public_key,
// signature_payload, signature)`, and the host's secp256r1_verify takes the
// payload as a PREHASH (`verify_prehash`). So the signature must be ECDSA over
// the 32 payload bytes themselves — NOT over sha256(payload). WebCrypto cannot
// express that (its ECDSA always hashes first), which is why this uses noble.
//
// The host also REJECTS high-S signatures outright:
//   soroban-env-host/src/crypto/mod.rs:185
//   "ECDSA signature 's' part is not normalized to low form"
// noble's `sign` returns low-S by default, so nothing extra is needed — but any
// other signer (WebCrypto, a real authenticator) must be normalized.

export interface P256Signer {
  /** SEC1 uncompressed, 65 bytes (0x04 || X || Y) — matches BytesN<65>. */
  publicKey: Buffer;
  /** ECDSA over the payload treated as a prehash; 64 bytes r||s, low-S. */
  sign(payload: Buffer): Buffer;
}

/** Generate a P-256 keypair standing in for a passkey. */
export function createP256Signer(): P256Signer {
  // Lazy require so the dependency is only needed by tests that use P-256.
  const { p256 } = require('@noble/curves/nist.js');
  const secretKey = p256.utils.randomSecretKey();
  return {
    publicKey: Buffer.from(p256.getPublicKey(secretKey, false)),
    sign: (payload) => Buffer.from(p256.sign(payload, secretKey, { prehash: false })),
  };
}

/** SignerKey::Secp256r1(BytesN<65>) — the public key itself. */
export function secp256r1SignerKey(publicKey: Buffer | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Secp256r1'),
    xdr.ScVal.scvBytes(Buffer.from(publicKey)),
  ]);
}

/** SignerProof::Secp256r1(BytesN<64>) — a raw ECDSA signature. */
export function secp256r1SignerProof(signature: Buffer | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Secp256r1'),
    xdr.ScVal.scvBytes(Buffer.from(signature)),
  ]);
}

/** A single-passkey proof builder for the smart account. */
export function smartAccountSecp256r1(signer: P256Signer): AuthProofBuilder {
  return (payload) =>
    signatureProofs([
      {
        key: secp256r1SignerKey(signer.publicKey),
        proof: secp256r1SignerProof(signer.sign(payload)),
      },
    ]);
}

/** Mixed ed25519 + P-256 signers proving the same payload. */
export function smartAccountMixed(
  ed: Keypair[],
  p256Signers: P256Signer[],
): AuthProofBuilder {
  return (payload) =>
    signatureProofs([
      ...ed.map((kp) => ({
        key: ed25519SignerKey(kp.rawPublicKey()),
        proof: ed25519SignerProof(kp.sign(payload)),
      })),
      ...p256Signers.map((s) => ({
        key: secp256r1SignerKey(s.publicKey),
        proof: secp256r1SignerProof(s.sign(payload)),
      })),
    ]);
}

/** Multiple signers proving the same payload (multisig at the account level). */
export function smartAccountMultiEd25519(kps: Keypair[]): AuthProofBuilder {
  return (payload) =>
    signatureProofs(
      kps.map((kp) => ({
        key: ed25519SignerKey(kp.rawPublicKey()),
        proof: ed25519SignerProof(kp.sign(payload)),
      })),
    );
}
