import { describe, expect, test } from "bun:test";

import { runMigrations, type Migration, type MigrationExec } from "../src/host/postgres/migrate";

/** In-memory fake: records exec'd statements, tracks the schema_migrations set. */
function fakeDb(): MigrationExec & { calls: string[]; applied: Set<string> } {
  const applied = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    applied,
    async exec(sql) {
      calls.push(sql);
      const insert = sql.match(/schema_migrations.*VALUES \('([^']+)'\)/s);
      if (insert) applied.add(insert[1]);
    },
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM hx.schema_migrations")) {
        return [...applied].map((name) => ({ name })) as T[];
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
});
