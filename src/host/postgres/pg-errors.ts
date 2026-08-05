// Classifiers for Bun.SQL / drizzle Postgres errors — the PG-layer analog of
// GuardedStore's breach taxonomy.
//
// Field layout (empirically pinned on Bun 1.3.14 + PG 18; the FORTRESS_PG_CI_DSN
// lane re-pins it against a real server so a driver upgrade fails loudly):
//   • server-raised errors:  { code: "ERR_POSTGRES_SERVER_ERROR", errno: "<SQLSTATE>" }
//     — the SQLSTATE ("57014", "23505", …) lives in `.errno`; `.code` is the
//     same constant for EVERY server error, so reading `.code` for a SQLSTATE
//     never matches.
//   • connection-lifecycle kills: { code: "ERR_POSTGRES_CONNECTION_CLOSED" |
//     "…CONNECTION_TIMEOUT" | "…IDLE_TIMEOUT" | "…LIFETIME_TIMEOUT" } with NO errno.
//
// Wrapping (also pinned): a kill through drizzle's `db.execute` arrives WRAPPED
// in DrizzleQueryError (the PostgresError on `.cause`); a kill through
// `db.transaction` re-throws the PostgresError BARE; raw Bun.SQL throws BARE.
// Every classifier therefore unwraps-if-wrapped, then reads `.code`/`.errno`
// on whichever it holds.

const KILL_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
]);

/** The underlying driver error beneath drizzle's query wrapper (identified
 *  structurally — `.query` string + `.params` array — never by class name,
 *  which the minified release binary rewrites), or the value itself. */
export function unwrapDbError(err: unknown): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { query?: unknown }).query === "string" &&
    Array.isArray((err as { params?: unknown }).params) &&
    (err as { cause?: unknown }).cause !== undefined
  ) {
    return (err as { cause: unknown }).cause;
  }
  return err;
}

/** Connection-lifecycle kill: the pool closed/rotated/timed out under the query.
 *  The statement may or may not have committed server-side, which is exactly-once
 *  safe here (in-txn dedupe + per-session advisory lock), so ONE retry is sound.
 *  57014 (a server-side statement_timeout cancel) is DELIBERATELY not kill-class:
 *  retrying a statement the server just proved too slow doubles the damage. */
export function isKillClassDbError(err: unknown): boolean {
  const code = (unwrapDbError(err) as { code?: unknown } | null)?.code;
  return typeof code === "string" && KILL_CODES.has(code);
}

/** SQLSTATE of a (possibly wrapped) server error, or null for anything else. */
export function dbSqlState(err: unknown): string | null {
  const errno = (unwrapDbError(err) as { errno?: unknown } | null)?.errno;
  if (typeof errno === "string" && errno) return errno;
  if (typeof errno === "number") return String(errno);
  return null;
}

/** Server cancelled the statement via statement_timeout (SQLSTATE 57014). */
export function isStatementTimeoutDbError(err: unknown): boolean {
  return dbSqlState(err) === "57014";
}

/** PgBouncer-class poolers reject unknown startup parameters with this literal
 *  (genuine Postgres says "unrecognized configuration parameter" — no overlap).
 *  Other pooler families may phrase it differently; the README =0 row is the
 *  backstop. Callers apply this only to connection-class error paths (a probe /
 *  first-query-per-connection rejection), never as free-text over arbitrary
 *  RPC errors. */
export function isUnsupportedStartupParamError(err: unknown): boolean {
  const e = unwrapDbError(err);
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /unsupported startup parameter/i.test(msg);
}

/** Positional marker: the per-session advisory-lock ACQUISITION (the first
 *  statement of an ingest/tombstone txn) was 57014-cancelled while WAITING for
 *  the lock — e.g. a live chunk queued behind a long same-session restore txn.
 *  Tagging at the await site is shape-proof (no `.query` sniffing); the txn
 *  rolled back atomically, so retrying it once is exactly-once safe. */
export class SessionLockTimeoutError extends Error {
  constructor(public readonly cause: unknown) {
    super("session_lock_timeout");
  }
}

/** Re-throw `err` as a SessionLockTimeoutError when it is a 57014 cancel —
 *  used by the try/catch that wraps ONLY the advisory-lock statement. */
export function tagLockTimeout(err: unknown): never {
  if (isStatementTimeoutDbError(err)) throw new SessionLockTimeoutError(err);
  throw err;
}

/** True for the two transient classes worth exactly one whole-operation retry:
 *  a connection-lifecycle kill, or a 57014 that cancelled the advisory-lock
 *  WAIT (tagged positionally). A plain 57014 on a working statement is NOT
 *  transient — the server proved the statement too slow. */
export function isTransientDbError(err: unknown): boolean {
  return isKillClassDbError(err) || err instanceof SessionLockTimeoutError;
}

/** Run `fn`; on a transient-class failure run it EXACTLY once more. `fn` must
 *  re-resolve its db handle itself so the retry lands on a post-rotation pool.
 *  Exactly-once holds at every call site via the in-txn dedupe key + the
 *  per-session advisory lock (a killed txn rolled back atomically). */
export async function retryOnceOnTransientDbError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    return await fn();
  }
}
