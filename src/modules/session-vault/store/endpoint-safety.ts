// M-4 · SSRF / exfiltration guard for a self-hosted vault's custom S3 endpoint.
//
// A self-hosted vault may point at an S3-compatible endpoint (MinIO, R2, …) via
// FORTRESS_S3_ENDPOINT. Left unvalidated, a hostile or mistaken endpoint could
// send the org's session bytes in cleartext, or aim the store's requests at a
// loopback / link-local / private-range address — including cloud metadata
// (169.254.169.254). So we require https and reject private/loopback IP literals
// unless the operator explicitly opts in (a legitimately-private MinIO on an
// internal network), and support an optional host allowlist. Throws on violation
// (fail-closed — the store is not built).

function parseBool(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** True only for an IPv4/IPv6 LITERAL in a loopback / link-local / private range.
 *  A DNS name (e.g. "minio.internal") is not an IP literal and is not matched
 *  here — the allowlist is the control for names. */
function isPrivateOrLoopbackIp(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a > 255 || b > 255) return false;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
    return false;
  }
  const h = host.toLowerCase();
  if (h === "::1") return true; // IPv6 loopback
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique-local (incl. fd00::/8)
  if (h.startsWith("fe80")) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (mapped) return isPrivateOrLoopbackIp(mapped[1]);
  return false;
}

/** Validate a custom S3 endpoint before the store is constructed. No-op when no
 *  custom endpoint is configured (the AWS default chain resolves the real S3). */
export function assertS3EndpointSafe(
  endpoint: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const raw = endpoint?.trim();
  if (!raw) return;

  const allowPrivate = parseBool(env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FORTRESS_S3_ENDPOINT must be a valid URL");
  }

  if (url.protocol !== "https:" && !allowPrivate) {
    throw new Error(
      "FORTRESS_S3_ENDPOINT must use https (set FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT for a private/plaintext endpoint)",
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  const allowlist = (env.FORTRESS_S3_ENDPOINT_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(host.toLowerCase())) {
    throw new Error(`FORTRESS_S3_ENDPOINT host is not in FORTRESS_S3_ENDPOINT_ALLOWLIST: ${host}`);
  }

  if (!allowPrivate && isPrivateOrLoopbackIp(host)) {
    throw new Error(
      `FORTRESS_S3_ENDPOINT points at a private/loopback address: ${host} (set FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT to allow)`,
    );
  }
}
