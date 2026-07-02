import { importJWK, jwtVerify } from "jose";

export interface CapabilityClaims {
  org: string;
  project?: string;
  repo: string;
  deviceId?: string;
  sub?: string;
  /** Target fortress org id the cloud bound the token to (anti cross-org replay). */
  aud?: string;
}

/** Verify an EdDSA capability JWT against a base64url raw Ed25519 public key.
 *  Throws on a bad signature, a missing/expired `exp`, missing required claims,
 *  or an `aud` that names a different org than `expectedOrgId` (when known).
 *
 *  `expectedOrgId` is THIS fortress's own org id (from its enrolled cloud
 *  credential). When supplied, a token carrying an `aud` for a DIFFERENT org is
 *  rejected — anti cross-org replay (a token minted for another fortress but
 *  signed by a shared cloud key, replayed here). An ABSENT `aud` is allowed:
 *  older mints omit it and the per-org signing key already bounds the token.
 *  This is purely ADDITIVE to `aud` — the gateway still deliberately does NOT
 *  require `org` == own org id (the scope args carry that boundary, per A6). */
export async function verifyCapabilityToken(
  token: string,
  publicKeyB64url: string,
  expectedOrgId?: string | null,
): Promise<CapabilityClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  // requiredClaims forces `exp` to be PRESENT; jwtVerify already rejects an `exp`
  // in the past — together they require a live, bounded expiry (no eternal token).
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    requiredClaims: ["exp"],
  });
  const { org, repo, aud } = payload as Record<string, unknown>;
  if (typeof org !== "string" || typeof repo !== "string") {
    throw new Error("capability token missing org/repo");
  }
  if (typeof aud === "string" && aud.length > 0 && expectedOrgId && aud !== expectedOrgId) {
    throw new Error("capability token audience mismatch");
  }
  return {
    org,
    repo,
    project: typeof payload.project === "string" ? payload.project : undefined,
    deviceId: typeof payload.deviceId === "string" ? payload.deviceId : undefined,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    aud: typeof aud === "string" ? aud : undefined,
  };
}
