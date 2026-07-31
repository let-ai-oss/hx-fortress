// Nothing the console renders, logs or throws may carry credential material.
//
// The rule is stated absolutely in the threat model, and it has to be enforced
// at the LAST step rather than at each source: a DSN reaches a rendered page
// through pg.json, through ui.json, through a driver's error message and through
// an exception nobody wrote, and only the last of those is a place a reviewer
// would think to look. So every value that leaves the console goes through here.
//
// It does not try to recognise secrets by entropy. It recognises the SHAPES the
// fortress actually holds - a connection string with a password, a bearer token,
// a base64url credential in a query string - and replaces the secret part while
// leaving enough of the value to be useful in a diagnosis.

/** What a redacted value reads as. One string, so a reader learns to see it. */
export const REDACTED = "[redacted]";

const DSN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]*)@/gi;
const BEARER = /\b(bearer|token|authorization)(\s*[=:]\s*|\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const QUERY_SECRET = /([?&](?:password|passwd|pwd|token|secret|credential|key)=)([^&\s]+)/gi;
const PG_PASSWORD_FIELD = /\b(password)(\s*[=:]\s*)('[^']*'|"[^"]*"|\S+)/gi;

/**
 * Redact every credential shape in a string.
 *
 * Applied to response bodies, to log lines and to error messages alike. The
 * error path matters most: a driver's connect failure quotes the whole DSN, and
 * that message reaches a rendered page through no code anybody wrote.
 */
export function redactCredentials(value: string): string {
  return value
    .replace(DSN, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(QUERY_SECRET, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(PG_PASSWORD_FIELD, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`);
}

/** Redact recursively through a response body. Keys are left alone - the SHAPE
 *  of a payload is not a secret and hiding it makes a diagnosis impossible. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactCredentials(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(inner);
    }
    return out as unknown as T;
  }
  return value;
}

/** The message form of an unknown throw, redacted. Stack traces are dropped
 *  entirely: they carry file paths and, on a connect failure, the DSN again. */
export function redactedMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactCredentials(raw);
}
