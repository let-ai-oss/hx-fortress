import { describe, expect, test } from "bun:test";

import {
  dbSqlState,
  isKillClassDbError,
  isStatementTimeoutDbError,
  isTransientDbError,
  isUnsupportedStartupParamError,
  retryOnceOnTransientDbError,
  SessionLockTimeoutError,
  tagLockTimeout,
  unwrapDbError,
} from "../src/host/postgres/pg-errors";
import { sanitizeDbError } from "../src/host/postgres/sanitize";

// Fixtures MIRROR the empirically-pinned real shapes (Bun 1.3.14 + PG 18; the
// FORTRESS_PG_CI_DSN lane re-pins them against a live server):
//   server error  = { code: "ERR_POSTGRES_SERVER_ERROR", errno: "<SQLSTATE>" }
//   kill-class    = { code: "ERR_POSTGRES_<lifecycle>" } with NO errno
//   drizzle wrap  = { query: string, params: [], cause: <the PostgresError>,
//                     message: "Failed query: …" } — and name STAYS "Error"
//                     (drizzle never sets it; --minify rewrites ctor names).

function serverError(errno: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; errno: string };
  err.code = "ERR_POSTGRES_SERVER_ERROR";
  err.errno = errno;
  return err;
}

function killError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function drizzleWrapped(cause: Error, query = "select 1", params: unknown[] = []): Error {
  const err = new Error(`Failed query: ${query}\nparams: ${params.join(",")}`) as Error & {
    query: string;
    params: unknown[];
    cause: Error;
  };
  err.query = query;
  err.params = params;
  err.cause = cause;
  return err; // deliberately name === "Error" — the real wrapper's shape
}

const KILL_CODES = [
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
];

describe("unwrapDbError", () => {
  test("steps down to the cause of a drizzle-shaped wrapper", () => {
    const cause = killError(KILL_CODES[0], "Connection closed");
    expect(unwrapDbError(drizzleWrapped(cause))).toBe(cause);
  });

  test("keeps a bare error (txn-path kills arrive UNwrapped)", () => {
    const bare = killError(KILL_CODES[3], "Max lifetime timeout reached");
    expect(unwrapDbError(bare)).toBe(bare);
  });

  test("does not unwrap a generic error with an incidental cause", () => {
    const err = new Error("outer");
    (err as Error & { cause: Error }).cause = new Error("inner");
    expect(unwrapDbError(err)).toBe(err);
  });
});

describe("isKillClassDbError", () => {
  for (const code of KILL_CODES) {
    test(`${code} — wrapped AND bare`, () => {
      const bare = killError(code, "kill");
      expect(isKillClassDbError(bare)).toBe(true);
      expect(isKillClassDbError(drizzleWrapped(bare))).toBe(true);
    });
  }

  test("57014 is NOT kill-class (server proved the statement too slow — retrying doubles the damage)", () => {
    const cancel = serverError("57014", "canceling statement due to statement timeout");
    expect(isKillClassDbError(cancel)).toBe(false);
    expect(isKillClassDbError(drizzleWrapped(cancel))).toBe(false);
  });

  test("constraint violations and plain errors are not kill-class", () => {
    expect(isKillClassDbError(serverError("23505", "duplicate key"))).toBe(false);
    expect(isKillClassDbError(new Error("nope"))).toBe(false);
    expect(isKillClassDbError(null)).toBe(false);
  });
});

describe("dbSqlState / isStatementTimeoutDbError", () => {
  test("SQLSTATE is read from .errno — NEVER .code (which is the shared ERR_POSTGRES_SERVER_ERROR)", () => {
    const cancel = serverError("57014", "canceling statement due to statement timeout");
    expect(dbSqlState(cancel)).toBe("57014");
    expect(dbSqlState(drizzleWrapped(cancel))).toBe("57014");
    expect(isStatementTimeoutDbError(cancel)).toBe(true);
    expect(isStatementTimeoutDbError(drizzleWrapped(cancel))).toBe(true);
    // A classifier that read `.code` would see this constant and never match —
    // the broken-fixture trap this test exists to close.
    const misread = killError("57014", "wrong field");
    expect(isKillClassDbError(misread)).toBe(false);
  });

  test("kill-class errors carry no SQLSTATE", () => {
    expect(dbSqlState(killError(KILL_CODES[0], "closed"))).toBeNull();
  });
});

describe("isUnsupportedStartupParamError", () => {
  test("matches PgBouncer's literal, wrapped and bare", () => {
    const bare = new Error("unsupported startup parameter: statement_timeout");
    expect(isUnsupportedStartupParamError(bare)).toBe(true);
    expect(
      isUnsupportedStartupParamError(drizzleWrapped(bare as Error & { code?: string })),
    ).toBe(true);
  });

  test("does not match genuine Postgres's phrasing", () => {
    expect(
      isUnsupportedStartupParamError(new Error('unrecognized configuration parameter "x"')),
    ).toBe(false);
  });
});

describe("tagLockTimeout / SessionLockTimeoutError", () => {
  test("re-throws a 57014 as the positional lock-timeout marker", () => {
    const cancel = drizzleWrapped(serverError("57014", "canceling statement due to statement timeout"));
    expect(() => tagLockTimeout(cancel)).toThrow(SessionLockTimeoutError);
  });

  test("re-throws anything else untouched", () => {
    const other = serverError("23505", "duplicate key");
    try {
      tagLockTimeout(other);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBe(other);
    }
  });
});

describe("retryOnceOnTransientDbError", () => {
  test("retries EXACTLY once on a kill-class failure", async () => {
    let calls = 0;
    const out = await retryOnceOnTransientDbError(async () => {
      calls += 1;
      if (calls === 1) throw killError(KILL_CODES[1], "Connection timeout");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  test("a second transient failure propagates (never loops)", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw killError(KILL_CODES[0], "Connection closed");
      }),
    ).rejects.toThrow("Connection closed");
    expect(calls).toBe(2);
  });

  test("retries once on the lock-timeout marker (live chunk queued behind a restore txn)", async () => {
    let calls = 0;
    const out = await retryOnceOnTransientDbError(async () => {
      calls += 1;
      if (calls === 1) throw new SessionLockTimeoutError(serverError("57014", "canceling"));
      return calls;
    });
    expect(out).toBe(2);
  });

  test("a plain 57014 (statement, not lock) is NOT retried", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw serverError("57014", "canceling statement due to statement timeout");
      }),
    ).rejects.toThrow("canceling statement");
    expect(calls).toBe(1);
  });

  test("non-transient failures are never retried", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw serverError("23505", "duplicate key");
      }),
    ).rejects.toThrow("duplicate key");
    expect(calls).toBe(1);
    expect(isTransientDbError(serverError("23505", "dup"))).toBe(false);
  });
});

describe("sanitizeDbError (DrizzleQueryError collapse)", () => {
  test("collapses a wrapped error to <errno>: <cause message> — never the SQL/params body", () => {
    const cause = serverError("57014", "canceling statement due to statement timeout");
    const wrapped = drizzleWrapped(cause, "insert into hx.turns …", ["SENTINEL_TRANSCRIPT_TEXT"]);
    const out = sanitizeDbError(wrapped);
    expect(out).toBe("57014: canceling statement due to statement timeout");
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("SENTINEL_TRANSCRIPT_TEXT");
    expect(out).not.toContain("insert into");
  });

  test("errno-first: a kill-class cause (no errno) falls back to its code", () => {
    const wrapped = drizzleWrapped(killError(KILL_CODES[3], "Max lifetime timeout reached"));
    expect(sanitizeDbError(wrapped)).toBe(
      "ERR_POSTGRES_LIFETIME_TIMEOUT: Max lifetime timeout reached",
    );
  });

  test("detection is STRUCTURAL (query+params), not name-based — the minified binary breaks names", () => {
    // Simulates a wrapper whose constructor.name minified to "s": only the
    // structural shape identifies it.
    const cause = serverError("23505", "duplicate key value violates unique constraint");
    const impostor = {
      message: 'Failed query: insert…\nparams: SECRET',
      query: "insert…",
      params: ["SECRET"],
      cause,
    };
    const out = sanitizeDbError(impostor);
    expect(out).toContain("23505");
    expect(out).not.toContain("SECRET");
  });

  test("a wrapper with no usable cause still never leaks the query body", () => {
    const orphan = { message: "Failed query: select secret", query: "select secret", params: [] };
    expect(sanitizeDbError(orphan)).toBe("db_query_failed");
  });

  test("plain errors keep today's DSN redaction", () => {
    expect(sanitizeDbError(new Error("connect to postgresql://u:pw@db.internal:5432/hx failed"))).toBe(
      "connect to [REDACTED_URL] failed",
    );
  });
});
