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
// The quotes are their OWN groups so a redacted JSON line is still JSON. Eating
// them produced `{"secretAccessKey": [redacted]}`, which no reader can parse —
// on the Logs tab, whose whole value is that a machine can read it back.
//
// The double-quoted arm honours ESCAPES (`"ab\"cd"` is one value, not two), and
// the unquoted arm stops at a value DELIMITER rather than running to the next
// space. `\S+` swallowed everything after the field — so a line carrying the
// routine `"password":null` lost its host, its bucket and its error, and the
// audited logs EXPORT rendered as complete while most of it had been deleted.
const FIELD_VALUE = String.raw`(?:'[^']*'|(")(?:[^"\\]|\\.)*(")|[^\s,;}\])]+)`;
const PG_PASSWORD_FIELD = new RegExp(String.raw`\b(password)(${FIELD_SEP})(${FIELD_VALUE})`, "gi");

/** Re-emit `label`, its separator and a redaction that keeps whatever quoting
 *  the value had. `open`/`close` are the quote groups from FIELD_VALUE; they are
 *  undefined for the unquoted and single-quoted forms. */
function redactField(
  label: string,
  sep: string,
  raw: string,
  open?: string,
  close?: string,
): string {
  // `null`, `true`, `false` and a bare number are STATES, not secrets: they say
  // whether something is configured, and `"password":[redacted]` is not JSON
  // where `"password":null` was. Same rule `redactValue` applies to a leaf.
  if (/^(?:null|true|false|-?\d+(?:\.\d+)?)$/i.test(raw)) return `${label}${sep}${raw}`;
  return `${label}${sep}${open ?? ""}${REDACTED}${close ?? ""}`;
}

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
 *
 *  DELIBERATELY NARROW, because the console's Logs tab is the surface that says
 *  what is broken and a redactor that blanks ordinary values makes it useless.
 *  Excluded, measured against real log lines:
 *    • anything containing `/` — an object key, a session key, a bucket path;
 *    • pure hex — a checksum, a request id, a fileId (the migration's own
 *      "checksum mismatch: <sha256>" line is the case that made this concrete);
 *    • pure decimal, and anything with a `-`-separated word shape
 *      (`expired-after-3600-seconds`), which is prose, not a key.
 *  What is left is a base64-ish run mixing cases and digits, which is what a raw
 *  key looks like and what almost nothing else does. */
const HIGH_ENTROPY_QUOTED = /"([A-Za-z0-9+/=_-]{40,})"/g;
function looksLikeRawKey(value: string): boolean {
  if (value.includes("/")) return false;
  if (/^[0-9a-fA-F]+$/.test(value)) return false;
  if (/^[0-9]+$/.test(value)) return false;
  if (/-/.test(value) && /[a-z]{3,}-[a-z0-9]/i.test(value)) return false;
  // Mixed case AND digits: the shape of a generated secret.
  return /[a-z]/.test(value) && /[A-Z0-9+/=_]/.test(value);
}

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
    .replace(
      PG_PASSWORD_FIELD,
      (_m, label: string, sep: string, raw: string, open?: string, close?: string) =>
        redactField(label, sep, raw, open, close),
    )
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(SERVICE_ACCOUNT, (_m, open: string, _key: string, close: string) => `${open}${REDACTED}${close}`)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(
      AWS_SECRET_FIELD,
      (_m, label: string, sep: string, raw: string, open?: string, close?: string) =>
        redactField(label, sep, raw, open, close),
    )
    .replace(PRESIGNED_SIGNATURE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(PG_PASSWORD_ENV, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(API_KEY_FIELD, REDACTED)
    .replace(HIGH_ENTROPY_QUOTED, (whole: string, inner: string) =>
      looksLikeRawKey(inner) ? `"${REDACTED}"` : whole,
    );
}

/** A property NAME that makes its value a secret whatever SHAPE the value takes.
 *
 *  Every rule above needs name, separator and value inside ONE string, which is
 *  how a log line or an error message is shaped. A structured body is not: the
 *  name is the object key and the value is a bare leaf, so `{"secretAccessKey":
 *  "wJal…"}` went through every rule untouched — on the very path `redactValue`
 *  exists for. Matched on the key here, and kept in step with the field rules
 *  above and with `command-params.ts`. */
const SECRET_KEY_NAME =
  /^(?:.*_)?(?:password|passwd|pwd|secret|secret[_-]?access[_-]?key|session[_-]?token|private[_-]?key(?:[_-]?id)?|api[_-]?key|apikey|dsn|database[_-]?url|signing[_-]?key|client[_-]?secret)$/i;

// DELIBERATELY NOT on that list: a bare `token`, and `credentialRef`. The
// console MINTS both and has to hand them back — the sign-in response carries
// the session token, the setup link carries its own, and a credentialRef names
// an indirection precisely so the secret it points at never travels. Redacting
// them by name broke sign-in outright (measured: the token came back as
// "[redacted]"), which is the shape of over-redaction that makes a redactor get
// switched off. `session_token` IS on the list — that one is AWS's, at rest in
// credentials.json, and nothing serves it to a caller.

/**
 * Redact recursively through a response body. Keys are left alone - the SHAPE of
 * a payload is not a secret and hiding it makes a diagnosis impossible - but a
 * key whose NAME says its value is a credential redacts that value outright.
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
      // A named secret goes whatever its shape: the name is the whole evidence,
      // and null/absent stays as it is so "not configured" and "withheld" do not
      // read alike.
      // A named secret goes whatever its shape — a string, and an object or an
      // array too, because this is the LAST belt on a response body and the
      // shape rules cannot reach a bare leaf nested under it.
      //
      // Except the primitives that are facts about configuration rather than
      // secrets: a `hasPassword: false` or a `passwordSet: true` says whether
      // something is set, and replacing it with a string changes its type as
      // well as its meaning — the same reason `null` is left alone, so "not
      // configured" and "withheld" never read alike.
      const named = SECRET_KEY_NAME.test(camelToSnake(key));
      const primitive = inner === null || inner === undefined || typeof inner === "boolean" || typeof inner === "number";
      out[key] = named && !primitive ? REDACTED : redactValue(inner);
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

/** `secretAccessKey` → `secret_access_key`, so one pattern covers both spellings
 *  rather than two that drift. */
function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
