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
// The separator covers BOTH written forms. `field = value` is how a DSN and an
// env line read; `"field": "value"` is how credentials.json is actually written
// (pretty-printed JSON), and the field rules used to require the separator to
// follow the bare name — in JSON the next character is a quote, so every one of
// them missed the file they were added for. The JSON arm keeps the closing quote
// out of the captured value by matching the quoted form explicitly.
const FIELD_SEP = String.raw`(?:\s*[=:]\s*|"\s*:\s*)`;
const FIELD_VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`;
const PG_PASSWORD_FIELD = new RegExp(String.raw`\b(password)(${FIELD_SEP})(${FIELD_VALUE})`, "gi");

// The shapes THIS appliance holds, which the four above do not recognise at all:
// a GCS service-account JSON, an AWS access key pair, a presigned signature, and
// PGPASSWORD. credentials.json is made of exactly these, and the daemon log
// quotes raw SDK errors. Kept in step with `command-params.ts`, which has had
// the same list all along on the parameter path and did not share it — including
// its high-entropy catch-all, ported below.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SERVICE_ACCOUNT = /("private_key"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
const AWS_ACCESS_KEY = /\bA(?:KIA|SIA|ROA|IDA)[0-9A-Z]{12,}\b/g;
const AWS_SECRET_FIELD = new RegExp(
  String.raw`\b(secret[_-]?access[_-]?key|aws[_-]?secret[_-]?access[_-]?key|session[_-]?token|private[_-]?key[_-]?id)(${FIELD_SEP})(${FIELD_VALUE})`,
  "gi",
);
const PRESIGNED_SIGNATURE = /\b(X-(?:Goog|Amz)-Signature=)([A-Fa-f0-9]{16,})/gi;
const PG_PASSWORD_ENV = /\b(PGPASSWORD)(\s*=\s*)(\S+)/g;
const API_KEY_FIELD = /\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})/g;
/** The catch-all `command-params.ts` has always carried and this file did not:
 *  a long, dense, non-word run inside quotes is a raw key whatever it is called.
 *  Quoted only — an unquoted run of 40 dense characters is as likely to be a
 *  bucket path, a checksum or an object key, and blanking those makes diagnosis
 *  impossible for no gain. */
const HIGH_ENTROPY_QUOTED = /"([A-Za-z0-9+/=_-]{40,})"/g;

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
    .replace(PG_PASSWORD_FIELD, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(SERVICE_ACCOUNT, (_m, open: string, _key: string, close: string) => `${open}${REDACTED}${close}`)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(AWS_SECRET_FIELD, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(PRESIGNED_SIGNATURE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(PG_PASSWORD_ENV, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(API_KEY_FIELD, REDACTED)
    .replace(HIGH_ENTROPY_QUOTED, `"${REDACTED}"`);
}

/**
 * Redact recursively through a response body. Keys are left alone - the SHAPE of
 * a payload is not a secret and hiding it makes a diagnosis impossible.
 *
 * A value whose data lives somewhere other than its own enumerable properties is
 * passed through UNTOUCHED. A Date is the one that matters: the driver hands
 * timestamptz columns back as Date objects, and rebuilding one from
 * Object.entries produces `{}` - so every instant in every response would arrive
 * at the browser as an empty object, and every "last activity" on every page
 * would read as unknown. There is no credential shape inside a Date to look for.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactCredentials(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value instanceof Date) return value;
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
