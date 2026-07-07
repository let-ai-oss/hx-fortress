import { describe, expect, test } from "bun:test";

import { runMigrations, type Migration, type MigrationExec } from "../src/host/postgres/migrate";

/** In-memory fake: records exec'd statements, tracks schema_migrations, and
 *  answers extension-availability from the given set. */
function fakeDb(availableExtensions: string[] = []): MigrationExec & {
  calls: string[];
  applied: Set<string>;
} {
  const applied = new Set<string>();
  const calls: string[] = [];
  const available = new Set(availableExtensions);
  return {
    calls,
    applied,
    async exec(sql) {
      calls.push(sql);
      const insert = sql.match(/schema_migrations.*VALUES \('([^']+)'\)/s);
      if (insert) applied.add(insert[1]);
    },
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes("FROM hx.schema_migrations")) {
        return [...applied].map((name) => ({ name })) as T[];
      }
      // The extension-availability check now binds the name ($1) — read it from
      // params rather than a quoted literal.
      if (sql.includes("pg_available_extensions WHERE name = $1")) {
        const ext = String(params?.[0] ?? "");
        return [{ n: available.has(ext) ? 1 : 0 }] as T[];
      }
      return [] as T[];
    },
  };
}

const sample: Migration[] = [
  { name: "0000_a", sql: "CREATE TABLE a();" },
  { name: "0001_b", sql: "CREATE TABLE b();" },
];

describe("runMigrations", () => {
  test("applies all migrations in order on a fresh db", async () => {
    const db = fakeDb();
    const done = await runMigrations(db, sample);
    expect(done).toEqual(["0000_a", "0001_b"]);
    expect(db.calls.some((c) => c.includes("CREATE TABLE a()"))).toBe(true);
    expect(db.calls.some((c) => c.includes("CREATE TABLE b()"))).toBe(true);
  });

  test("is idempotent — skips already-applied migrations", async () => {
    const db = fakeDb();
    await runMigrations(db, sample);
    const second = await runMigrations(db, sample);
    expect(second).toEqual([]);
  });

  test("rejects an invalid migration name (SQL-injection guard)", async () => {
    const db = fakeDb();
    await expect(
      runMigrations(db, [{ name: "0000_a'; DROP TABLE x;--", sql: "SELECT 1;" }]),
    ).rejects.toThrow("invalid migration name");
  });

  const gated: Migration[] = [{ name: "0006_vec", sql: "CREATE TABLE v();", requires: "vector" }];

  test("skips a gated migration when its extension is unavailable", async () => {
    const db = fakeDb([]); // vector not available
    const done = await runMigrations(db, gated);
    expect(done).toEqual([]);
    expect(db.applied.has("0006_vec")).toBe(false);
    expect(db.calls.some((c) => c.includes("CREATE TABLE v()"))).toBe(false);
  });

  test("applies a gated migration when its extension is available", async () => {
    const db = fakeDb(["vector"]);
    const done = await runMigrations(db, gated);
    expect(done).toEqual(["0006_vec"]);
    expect(db.applied.has("0006_vec")).toBe(true);
  });
});
