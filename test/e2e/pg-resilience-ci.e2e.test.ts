// LOAD-BEARING real-Postgres pins for the PG-layer resilience design
// (v0.17.0). Gated on FORTRESS_PG_CI_DSN — a plain reachable Postgres DSN
// (CI: a pgvector/pgvector:pg18 service container; locally e.g.
//   docker run --rm -e POSTGRES_PASSWORD=hx -p 5498:5432 pgvector/pgvector:pg18
//   FORTRESS_PG_CI_DSN=postgresql://postgres:hx@127.0.0.1:5498/postgres bun test pg-resilience-ci
// ). These connect DIRECTLY to the DSN — deliberately NOT via the embedded
// provider (the FORTRESS_PG_E2E lane is bit-rotted: its fixtures point pgvector
// acquisition at a fake cloud URL — known-broken, repair out of scope).
//
// Every empirical claim the design rests on is re-pinned here so a Bun/driver
// upgrade fails THIS lane loudly instead of shipping a silent prod no-op:
//   • multi-statement .simple() result shape (journal read indexes the LAST
//     element — a mis-parse re-runs migration 0 forever and the fortress never
//     becomes ready);
//   • SET LOCAL binding inside the implicit batch txn (57014 / 55P03);
//   • PostgresError field layout (SQLSTATE in .errno; kill-class in .code);
//   • wrapped (db.execute) vs BARE (db.transaction / raw Bun.SQL) error shapes;
//   • startup-param statement_timeout reaching the server;
//   • .detail (not .message) carrying constraint values — the sanitizer's
//     sentinel exclusion.

import { afterAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";

import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { runMigrations, type Migration } from "../../src/host/postgres/migrate";
import {
  dbSqlState,
  isKillClassDbError,
  isStatementTimeoutDbError,
  unwrapDbError,
} from "../../src/host/postgres/pg-errors";
import { sanitizeDbError } from "../../src/host/postgres/sanitize";

const DSN = process.env.FORTRESS_PG_CI_DSN ?? "";

const opened: Bun.SQL[] = [];
function client(options: Record<string, unknown> = {}): Bun.SQL {
  const c = new Bun.SQL(DSN, options as never);
  opened.push(c);
  return c;
}

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close({ timeout: 2 }).catch(() => {})));
});

describe.if(DSN !== "")("PG resilience pins (real Postgres)", () => {
  test("journal-read shape: the prefixed multi-statement batch's LAST result set is the rows (LOAD-BEARING)", async () => {
    const exec = makeMigrationExec(DSN);
    // Stateless against a reused local container (CI's is always fresh).
    await exec.exec(
      "CREATE SCHEMA IF NOT EXISTS hx;" +
        "CREATE TABLE IF NOT EXISTS hx.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" +
        "DELETE FROM hx.schema_migrations WHERE name = 'ci_0001_probe';" +
        "DROP TABLE IF EXISTS hx.ci_probe;",
    );
    const migrations: Migration[] = [
      { name: "ci_0001_probe", sql: "CREATE TABLE IF NOT EXISTS hx.ci_probe(id int);" },
    ];
    const first = await runMigrations(exec, migrations);
    expect(first).toEqual(["ci_0001_probe"]);
    // Idempotence IS the shape test: a mis-parsed journal read would return []
    // applied names and re-run (then journal-PK-abort) migration 1 forever.
    const second = await runMigrations(exec, migrations);
    expect(second).toEqual([]);
    const rows = await exec.query<{ name: string }>("SELECT name FROM hx.schema_migrations");
    expect(rows.some((r) => r.name === "ci_0001_probe")).toBe(true);
  });

  test("SET LOCAL statement_timeout binds the batch's implicit txn: pg_sleep past it dies 57014 via .errno", async () => {
    const exec = makeMigrationExec(DSN, { env: { FORTRESS_DB_MIGRATION_TIMEOUT_MS: "400" } });
    let caught: unknown = null;
    try {
      await exec.exec("SELECT pg_sleep(2);");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isStatementTimeoutDbError(caught)).toBe(true);
    expect(dbSqlState(caught)).toBe("57014");
    // …and the bound evaporates with the batch (SET LOCAL, not SET): a fresh
    // batch on the same DSN runs unbounded again.
    await makeMigrationExec(DSN).exec("SELECT pg_sleep(0.5);");
  });

  test("a held migration advisory lock bounds the WAIT via lock_timeout (clean 55P03 — the zombie-vs-retry serializer)", async () => {
    const holder = client({ max: 1 });
    await holder.unsafe(
      "BEGIN; SELECT pg_advisory_xact_lock(26744, 1835624306);",
    ).simple();
    try {
      const exec = makeMigrationExec(DSN, { lockTimeoutMs: 300 });
      let caught: unknown = null;
      try {
        await exec.exec("SELECT 1;");
      } catch (err) {
        caught = err;
      }
      expect(dbSqlState(caught)).toBe("55P03");
    } finally {
      await holder.unsafe("ROLLBACK;").simple();
    }
  });

  test("startup-param statement_timeout reaches the server (the pools' only per-statement bound)", async () => {
    const c = client({ max: 1, connection: { statement_timeout: 250 } });
    const rows = (await c`SHOW statement_timeout`) as { statement_timeout: string }[];
    expect(rows[0]?.statement_timeout).toBe("250ms");
  });

  test("kill via db.transaction arrives BARE; via db.execute arrives WRAPPED — the classifier covers both (R5)", async () => {
    // maxLifetime hard-kills the active txn even mid-query — atomic rollback.
    const db = drizzle(client({ max: 1, maxLifetime: 1 }));
    let txnErr: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(3)`);
      });
    } catch (err) {
      txnErr = err;
    }
    expect(txnErr).not.toBeNull();
    // BARE: the txn path re-throws the PostgresError itself (cause-less).
    expect((txnErr as { query?: unknown }).query).toBeUndefined();
    expect(isKillClassDbError(txnErr)).toBe(true);

    const db2 = drizzle(client({ max: 1, maxLifetime: 1 }));
    let execErr: unknown = null;
    try {
      await db2.execute(sql`SELECT pg_sleep(3)`);
    } catch (err) {
      execErr = err;
    }
    expect(execErr).not.toBeNull();
    expect(isKillClassDbError(execErr)).toBe(true);
  }, 20_000);

  test("in-txn 57014 (startup param) is classified via .errno through the txn rethrow", async () => {
    const db = drizzle(client({ max: 1, connection: { statement_timeout: 300 } }));
    let caught: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(2)`);
      });
    } catch (err) {
      caught = err;
    }
    expect(isStatementTimeoutDbError(caught)).toBe(true);
    expect(isKillClassDbError(caught)).toBe(false); // NOT retried as a kill
  });

  test("sanitizer sentinel: a REAL 23505's bound value lives in .detail and NEVER survives sanitizeDbError", async () => {
    const c = client({ max: 1 });
    await c.unsafe(
      "CREATE TABLE IF NOT EXISTS ci_sentinel (k text PRIMARY KEY); DELETE FROM ci_sentinel;",
    ).simple();
    const db = drizzle(c);
    await db.execute(sql`INSERT INTO ci_sentinel (k) VALUES ('SENTINEL_SECRET_VALUE_XYZ')`);
    let caught: unknown = null;
    try {
      await db.execute(sql`INSERT INTO ci_sentinel (k) VALUES ('SENTINEL_SECRET_VALUE_XYZ')`);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const cause = unwrapDbError(caught) as { message: string; detail?: string };
    // The empirical premise itself: values ride in .detail, never .message.
    expect(cause.message).not.toContain("SENTINEL_SECRET_VALUE_XYZ");
    expect(String(cause.detail ?? "")).toContain("SENTINEL_SECRET_VALUE_XYZ");
    const sanitized = sanitizeDbError(caught);
    expect(sanitized).toContain("23505");
    expect(sanitized).not.toContain("SENTINEL_SECRET_VALUE_XYZ");
    expect(sanitized).not.toContain("Failed query");
  });
});
