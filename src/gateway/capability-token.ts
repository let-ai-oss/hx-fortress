import { importJWK, jwtVerify } from "jose";

export interface CapabilityClaims {
  org: string;
  project?: string;
  repo: string;
  deviceId?: string;
  sub?: string;
}

/** Verify an EdDSA capability JWT against a base64url raw Ed25519 public key.
 *  Throws on bad signature, expiry, or missing required claims. */
export async function verifyCapabilityToken(
  token: string,
  publicKeyB64url: string,
): Promise<CapabilityClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"] });
  const { org, repo } = payload as Record<string, unknown>;
  if (typeof org !== "string" || typeof repo !== "string") {
    throw new Error("capability token missing org/repo");
  }
  return {
    org,
    repo,
    project: typeof payload.project === "string" ? payload.project : undefined,
    deviceId: typeof payload.deviceId === "string" ? payload.deviceId : undefined,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
  };
}
