import { importJWK, jwtVerify } from "jose";

export interface CapabilityClaims {
  org: string;
  project?: string;
  repo: string;
  deviceId?: string;
  sub?: string;
  /** Target fortress org id the cloud bound the token to (anti cross-org replay). */
  aud?: string;
  /** v2 capability-grant purpose. Present ⇒ a v2 grant, not a legacy v1 token. */
  purpose?: "ingest" | "read";
  /** v2 read-grant scope commitment: base64url(sha256(canonical scope)). */
  scopeHash?: string;
  /** Grant schema version (2 for a capability grant). Absent on v1 tokens. */
  v?: number;
}

/** A verified v2 capability grant — a cloud-signed, purpose-scoped, object-bound
 *  authorization the fortress verifies offline against the per-org signing key.
 *  Every claim is required except the object binders (`scopeHash` on reads; the
 *  `repo`/`project`/`deviceId` ingest binders). */
export interface GrantClaims {
  v: number;
  purpose: "ingest" | "read";
  org: string;
  aud: string;
  sub: string;
  scopeHash?: string;
  repo?: string;
  project?: string;
  deviceId?: string;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** The ONE place the "require a grant" decision is encoded for the HTTP surface
 *  (gateway upload/read routes + POST /mcp). Default OFF: a grant is verified
 *  IF present but not REQUIRED, so the current grant-less workbench keeps working.
 *  The human flips FORTRESS_GRANT_ENFORCE=1 after the workbench mint side ships. */
export function isGrantEnforcing(): boolean {
  return parseBooleanEnv(process.env.FORTRESS_GRANT_ENFORCE);
}

/** The reverse-tunnel equivalent of isGrantEnforcing (vault RPC + tunnel MCP).
 *  Default OFF for the same non-bricking reason; FORTRESS_TUNNEL_GRANT_ENFORCE. */
export function isTunnelGrantEnforcing(): boolean {
  return parseBooleanEnv(process.env.FORTRESS_TUNNEL_GRANT_ENFORCE);
}

/** True when the token carries v2-grant framing (an `aud`, a `purpose`, or v===2)
 *  — as opposed to a legacy v1 capability token bound only by the signing key. */
export function isV2Claims(claims: CapabilityClaims): boolean {
  return claims.purpose !== undefined || claims.aud !== undefined || claims.v === 2;
}

/** Verify an EdDSA capability JWT against a base64url raw Ed25519 public key.
 *  Throws on a bad signature, a missing/expired `exp`, or missing required claims.
 *
 *  `expectedOrgId` is THIS fortress's own org id (from its enrolled cloud
 *  credential), or null before enrollment. Binding rules:
 *   • A v1 token (no `aud`/`purpose`) is accepted as-is DURING THE COMPAT WINDOW
 *     (FORTRESS_GRANT_ENFORCE off) — its per-org signing key is its only binding,
 *     matching pre-grant traffic so nothing breaks.
 *   • Otherwise (a v2 token, OR enforcement on) the token MUST be bound to this
 *     fortress's own org: `aud === org === expectedOrgId`. We must know our own
 *     org id to bind — refuse when we don't (fail-closed). This is the tightening
 *     from the pre-grant era, where the gateway deliberately left `org` unchecked. */
export async function verifyCapabilityToken(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string | null,
): Promise<CapabilityClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  // requiredClaims forces `exp` to be PRESENT; jwtVerify already rejects an `exp`
  // in the past — together they require a live, bounded expiry (no eternal token).
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    requiredClaims: ["exp"],
  });
  const p = payload as Record<string, unknown>;
  const { org, repo, aud, purpose } = p;
  if (typeof org !== "string" || typeof repo !== "string") {
    throw new Error("capability token missing org/repo");
  }
  const claims: CapabilityClaims = {
    org,
    repo,
    project: typeof p.project === "string" ? p.project : undefined,
    deviceId: typeof p.deviceId === "string" ? p.deviceId : undefined,
    sub: typeof p.sub === "string" ? p.sub : undefined,
    aud: typeof aud === "string" ? aud : undefined,
    purpose: purpose === "ingest" || purpose === "read" ? purpose : undefined,
    scopeHash: typeof p.scopeHash === "string" ? p.scopeHash : undefined,
    v: typeof p.v === "number" ? p.v : undefined,
  };

  const isV1 = claims.aud === undefined && claims.purpose === undefined;
  if (isV1 && !isGrantEnforcing()) {
    return claims;
  }

  if (!expectedOrgId) {
    throw new Error("capability token: fortress org id unknown");
  }
  if (claims.aud !== expectedOrgId || claims.org !== expectedOrgId) {
    throw new Error("capability token audience mismatch");
  }
  return claims;
}

/** Verify a v2 capability GRANT against the per-org Ed25519 signing key (the same
 *  key that signs v1 capability tokens). Fail-closed on tampering: any bad claim
 *  throws a specific error.
 *
 *  Requires `v === 2`, `purpose === opts.purpose`, `org === aud === expectedOrgId`,
 *  a non-empty `sub`, and — for a read grant — a present `scopeHash`. The caller
 *  then binds the grant to the object it touches (write) or recomputes the scope
 *  hash over the tool args (read). */
export async function verifyGrant(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string,
  opts: { purpose: "ingest" | "read" },
): Promise<GrantClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    requiredClaims: ["exp"],
  });
  const p = payload as Record<string, unknown>;
  const v = typeof p.v === "number" ? p.v : undefined;
  const { purpose, org, aud, sub } = p;
  if (v !== 2) throw new Error("grant version unsupported");
  if (purpose !== "ingest" && purpose !== "read") throw new Error("grant purpose invalid");
  if (purpose !== opts.purpose) throw new Error("grant purpose mismatch");
  if (typeof org !== "string" || org !== expectedOrgId) throw new Error("grant org mismatch");
  if (typeof aud !== "string" || aud !== expectedOrgId) throw new Error("grant audience mismatch");
  if (typeof sub !== "string" || sub.length === 0) throw new Error("grant missing sub");
  const scopeHash = typeof p.scopeHash === "string" ? p.scopeHash : undefined;
  if (opts.purpose === "read" && !scopeHash) {
    throw new Error("read grant missing scopeHash");
  }
  return {
    v,
    purpose,
    org,
    aud,
    sub,
    scopeHash,
    repo: typeof p.repo === "string" ? p.repo : undefined,
    project: typeof p.project === "string" ? p.project : undefined,
    deviceId: typeof p.deviceId === "string" ? p.deviceId : undefined,
  };
}
