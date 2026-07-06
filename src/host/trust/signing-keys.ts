// Baked-in Ed25519 trust anchors for artifact signatures. This is the ONLY
// authenticity root the fortress trusts for downloaded artifacts (self-update
// binary, embedded-PG bundle, pgvector native lib, future hub modules). It is
// compiled INTO the binary and is NEVER fetched, overridden by config, or
// sourced from the network — a same-origin `.sha256` proves integrity, but only
// a signature made by one of these keys proves authenticity.
//
// `publicKey` is the base64url encoding of the raw 32-byte Ed25519 public key
// (the JWK `x` parameter), so it feeds `importJWK({kty:"OKP",crv:"Ed25519",x})`
// directly (see src/gateway/capability-token.ts for the same pattern).

import { importJWK } from "jose";

import type { KeyProof } from "../../protocol";

export interface TrustedSigningKey {
  /** Stable id recorded in each signature sidecar; selects which anchor verifies. */
  keyid: string;
  /** base64url raw 32-byte Ed25519 public key (JWK `x`). */
  publicKey: string;
}

// TODO(prod-key): this is a DEV key — generate a production keypair, store the
// private JWK as the FORTRESS_SIGNING_KEY CI secret, replace the entry below,
// and rotate. Ship N+1 keys for a rotation window (verify against both the
// outgoing and incoming key so a mid-rotation release is never rejected).
export const TRUSTED_SIGNING_KEYS: readonly TrustedSigningKey[] = [
  { keyid: "hxf-dev-2026-07", publicKey: "2MkypwQYWd8sFrN2hvhWzkf4gf6wg8KFB50Njy_l5Os" },
];

// The let.ai ROOT trust anchor for org signing-key pushes (H-2). Distinct from
// TRUSTED_SIGNING_KEYS (artifact authenticity): this key signs the KeyProof that
// authenticates a `${orgId}|${signingPublicKey}|${notBefore}` binding, so a hub
// can no longer silently swap the per-org key the gateway verifies tokens with.
// TODO(prod-key): DEV let.ai root key — replace with the production root public key
// (private = workbench LETAI_FORTRESS_ROOT_SIGNING_KEY secret).
export const LETAI_ROOT_KEYS: readonly TrustedSigningKey[] = [
  { keyid: "letai-root-dev-2026-07", publicKey: "KSjNxrdnHOqj2k-Ij179B55ZK_Uu5G0jpBXx-3SacEQ" },
];

// WebCrypto's verify() wants a concrete ArrayBuffer view, not the generic
// ArrayBufferLike a plain Uint8Array/Buffer carries — copy into a fresh buffer.
function toView(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out;
}

/** Verify a root-signed org signing-key push proof (H-2). The cloud signs
 *  `${orgId}|${signingPublicKey}|${notBefore}` with the let.ai root private key;
 *  the fortress verifies that signature against a root PUBLIC key compiled into
 *  its binary. Returns true only on a valid proof; never throws (a malformed or
 *  wrong-key proof is simply `false`, so the caller keeps the existing pin). */
export async function verifyKeyProof(
  orgId: string,
  signingPublicKey: string,
  proof: KeyProof,
  rootKeys: readonly TrustedSigningKey[] = LETAI_ROOT_KEYS,
): Promise<boolean> {
  if (!proof || proof.alg !== "Ed25519-root") return false;
  if (typeof proof.notBefore !== "string" || typeof proof.sig !== "string") return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = toView(Buffer.from(proof.sig, "base64url"));
  } catch {
    return false;
  }
  const message = toView(new TextEncoder().encode(`${orgId}|${signingPublicKey}|${proof.notBefore}`));
  for (const rk of rootKeys) {
    try {
      const key = (await importJWK({ kty: "OKP", crv: "Ed25519", x: rk.publicKey }, "EdDSA")) as CryptoKey;
      if (await crypto.subtle.verify("Ed25519", key, sig, message)) return true;
    } catch {
      // Try the next root key.
    }
  }
  return false;
}
