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
