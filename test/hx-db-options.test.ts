import { describe, expect, test } from "bun:test";

import {
  acquireTimeoutMs,
  backgroundPoolMax,
  describePool,
  hxPoolOptions,
  hxPoolOptionsFor,
  lockTimeoutMs,
  poolMax,
  statementTimeoutMs,
} from "../src/host/postgres/db";
import { migrationBatchPrefix, migrationTimeoutMs, lastResultSet } from "../src/host/postgres/sql-exec";
import { probeIntervalMs } from "../src/host/postgres/guarded-db";
import { guarantorIntervalMs } from "../src/ingest/guarantor";

describe("hxPoolOptions env parsing", () => {
  test("defaults: 10 s connect, 10 s ACQUIRE, 1 h lifetime, max 10, 120 s statement_timeout", () => {
    const o = hxPoolOptions({});
    expect(o).toEqual({
      connectionTimeout: 10,
      // Bun calls this idleTimeout; it is the pool checkout-queue bound. It was
      // 60 s — longer than the 25 s RPC deadline that abandons the query — so a
      // starved pool queued work nobody was waiting for any more.
      idleTimeout: 10,
      maxLifetime: 3600,
      max: 10,
      connection: { statement_timeout: 120_000 },
    });
  });

  test("the acquire bound stays UNDER the vault RPC deadline it sheds for", () => {
    // The invariant the outage violated: a checkout queue that outlives the
    // caller keeps the pool busy for requests that were abandoned long ago.
    const DEADLINE_MS = 25_000; // FORTRESS_DB_RPC_DEADLINE_MS default
    expect(acquireTimeoutMs({})).toBeLessThan(DEADLINE_MS);
    expect(hxPoolOptions({}).idleTimeout * 1000).toBeLessThan(DEADLINE_MS);
  });

  test("acquire/lock/pool knobs parse like the rest of the family", () => {
    expect(acquireTimeoutMs({ FORTRESS_DB_ACQUIRE_TIMEOUT_MS: "3000" })).toBe(3000);
    expect(acquireTimeoutMs({ FORTRESS_DB_ACQUIRE_TIMEOUT_MS: "" })).toBe(10_000);
    // 0 is NOT a disable knob here: an unbounded checkout queue is the bug.
    expect(acquireTimeoutMs({ FORTRESS_DB_ACQUIRE_TIMEOUT_MS: "0" })).toBe(10_000);
    expect(lockTimeoutMs({})).toBe(5000);
    expect(lockTimeoutMs({ FORTRESS_DB_LOCK_TIMEOUT_MS: "250" })).toBe(250);
    // 0 IS a hatch here — an operator may choose to wait rather than shed.
    expect(lockTimeoutMs({ FORTRESS_DB_LOCK_TIMEOUT_MS: "0" })).toBe(0);
    expect(poolMax({})).toBe(10);
    expect(poolMax({ FORTRESS_DB_POOL_MAX: "24" })).toBe(24);
    expect(poolMax({ FORTRESS_DB_POOL_MAX: "0" })).toBe(10);
    expect(poolMax({ FORTRESS_DB_POOL_MAX: "junk" })).toBe(10);
    expect(backgroundPoolMax({})).toBe(2);
    expect(backgroundPoolMax({ FORTRESS_DB_BG_POOL_MAX: "4" })).toBe(4);
  });

  test("ms → seconds via ceil, clamped to a minimum of 1 s", () => {
    const o = hxPoolOptions({
      FORTRESS_DB_CONNECT_TIMEOUT_MS: "1500",
      FORTRESS_DB_MAX_LIFETIME_MS: "500",
    });
    expect(o.connectionTimeout).toBe(2);
    expect(o.maxLifetime).toBe(1);
  });

  test("set-but-EMPTY means default (a blanked template var must never zero a bound)", () => {
    const o = hxPoolOptions({
      FORTRESS_DB_CONNECT_TIMEOUT_MS: "",
      FORTRESS_DB_STATEMENT_TIMEOUT_MS: "  ",
      FORTRESS_DB_MAX_LIFETIME_MS: "",
    });
    expect(o.connectionTimeout).toBe(10);
    expect(o.maxLifetime).toBe(3600);
    expect(o.connection).toEqual({ statement_timeout: 120_000 });
  });

  test("garbage falls back to defaults", () => {
    const o = hxPoolOptions({
      FORTRESS_DB_CONNECT_TIMEOUT_MS: "soon",
      FORTRESS_DB_STATEMENT_TIMEOUT_MS: "-5",
      FORTRESS_DB_MAX_LIFETIME_MS: "NaN",
    });
    expect(o.connectionTimeout).toBe(10);
    expect(o.connection).toEqual({ statement_timeout: 120_000 });
    expect(o.maxLifetime).toBe(3600);
  });

  test("statement_timeout=0 OMITS the startup parameter entirely (pooled-DSN escape hatch)", () => {
    const o = hxPoolOptions({ FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" });
    expect(o.connection).toBeUndefined();
    expect(statementTimeoutMs({ FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" })).toBe(0);
  });

  test("=0 omission covers EVERY consumer — the embed worker's 300 s override included", () => {
    const withHatch = hxPoolOptions(
      { FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" },
      { max: 4, statementTimeoutMs: 300_000 },
    );
    expect(withHatch.connection).toBeUndefined();
    expect(withHatch.max).toBe(4);
    const without = hxPoolOptions({}, { max: 4, statementTimeoutMs: 300_000 });
    expect(without.connection).toEqual({ statement_timeout: 300_000 });
  });

  test("maxLifetime=0 means the DEFAULT — rotation is a healer, never disableable", () => {
    expect(hxPoolOptions({ FORTRESS_DB_MAX_LIFETIME_MS: "0" }).maxLifetime).toBe(3600);
  });

  test("connect-timeout=0 means the DEFAULT — a connect bound may never be disabled", () => {
    expect(hxPoolOptions({ FORTRESS_DB_CONNECT_TIMEOUT_MS: "0" }).connectionTimeout).toBe(10);
  });
});

describe("the =0 family is pinned per env (they deliberately differ)", () => {
  test("probe-interval 0 = disabled (store-probe precedent)", () => {
    expect(probeIntervalMs({ FORTRESS_DB_PROBE_INTERVAL_MS: "0" })).toBe(0);
    expect(probeIntervalMs({ FORTRESS_DB_PROBE_INTERVAL_MS: "" })).toBe(60_000);
    expect(probeIntervalMs({})).toBe(60_000);
  });

  test("guarantor-interval 0 = default (never a disable knob)", () => {
    expect(guarantorIntervalMs({ FORTRESS_GUARANTOR_INTERVAL_MS: "0" })).toBe(3_600_000);
    expect(guarantorIntervalMs({ FORTRESS_GUARANTOR_INTERVAL_MS: "" })).toBe(3_600_000);
    expect(guarantorIntervalMs({ FORTRESS_GUARANTOR_INTERVAL_MS: "60000" })).toBe(60_000);
  });
});

describe("describePool", () => {
  test("host only — never userinfo, never the DSN", () => {
    const line = describePool("postgresql://user:secret@db.internal:5432/hx", hxPoolOptions({}));
    expect(line.host).toBe("db.internal");
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(line.statementTimeoutMs).toBe(120_000);
    // Logged under what it DOES, not under Bun's misleading option name.
    expect(line.acquireTimeoutS).toBe(10);
    expect(line.lockTimeoutMs).toBe("omitted");
    expect(
      describePool("postgresql://h/db", hxPoolOptionsFor("rw", {})).lockTimeoutMs,
    ).toBe(5000);
  });

  test("unparseable DSN yields a placeholder, not a throw", () => {
    expect(describePool("not a url", hxPoolOptions({})).host).toBe("unparseable");
  });

  test("names the omission when the hatch is engaged", () => {
    const line = describePool(
      "postgresql://h/db",
      hxPoolOptions({ FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" }),
    );
    expect(line.statementTimeoutMs).toBe("omitted");
  });
});

describe("migration bounding", () => {
  test("timeout env: default 300 s; validated integer; set-but-empty/garbage/0 fall back", () => {
    expect(migrationTimeoutMs({})).toBe(300_000);
    expect(migrationTimeoutMs({ FORTRESS_DB_MIGRATION_TIMEOUT_MS: "" })).toBe(300_000);
    expect(migrationTimeoutMs({ FORTRESS_DB_MIGRATION_TIMEOUT_MS: "0" })).toBe(300_000);
    expect(migrationTimeoutMs({ FORTRESS_DB_MIGRATION_TIMEOUT_MS: "12.5" })).toBe(300_000);
    expect(migrationTimeoutMs({ FORTRESS_DB_MIGRATION_TIMEOUT_MS: "600000" })).toBe(600_000);
  });

  test("prefix: SET LOCAL (txn-scoped — no GUC leak on transaction-mode poolers) + the two-int lock", () => {
    const prefix = migrationBatchPrefix({});
    expect(prefix).toContain("SET LOCAL statement_timeout = 300000;");
    expect(prefix).toContain("SET LOCAL lock_timeout = 30000;");
    // Two-int form (objsubid=2) — disjoint by construction from the one-arg
    // hashtextextended locks ingest/delete take.
    expect(prefix).toContain("pg_advisory_xact_lock(26744, 1835624306)");
    expect(prefix).not.toMatch(/(?<!LOCAL )SET statement_timeout/);
  });

  test("prefix env value is validated before interpolation (never raw text)", () => {
    const prefix = migrationBatchPrefix({
      FORTRESS_DB_MIGRATION_TIMEOUT_MS: "1; DROP TABLE hx.sessions;--",
    });
    expect(prefix).toContain("SET LOCAL statement_timeout = 300000;");
    expect(prefix).not.toContain("DROP TABLE");
  });

  test("lastResultSet: batch → LAST element; single-statement rows pass through; empties are safe", () => {
    expect(lastResultSet([[], [{ lock: true }], [{ name: "0001" }]])).toEqual([{ name: "0001" }]);
    expect(lastResultSet([[], [], []])).toEqual([]);
    expect(lastResultSet([{ name: "0001" }, { name: "0002" }])).toEqual([
      { name: "0001" },
      { name: "0002" },
    ]);
    expect(lastResultSet(undefined)).toEqual([]);
    expect(lastResultSet([])).toEqual([]);
  });
});


describe("per-role pool profiles — background repair can never spend the live budget", () => {
  test("rw (live ingest) carries lock_timeout; ro and bg do not", () => {
    expect(hxPoolOptionsFor("rw", {}).connection).toEqual({
      statement_timeout: 120_000,
      lock_timeout: 5000,
    });
    // Reads never take the per-session advisory lock, so they need no bound.
    expect(hxPoolOptionsFor("ro", {}).connection).toEqual({ statement_timeout: 120_000 });
    // The guarantor HOLDS the lock during a restore — bounding its wait would
    // just make it abandon its own work.
    expect(hxPoolOptionsFor("bg", {}).connection).toEqual({ statement_timeout: 120_000 });
  });

  test("bg is a small, SEPARATE allocation — the isolation the outage needed", () => {
    expect(hxPoolOptionsFor("bg", {}).max).toBe(2);
    expect(hxPoolOptionsFor("rw", {}).max).toBe(10);
    expect(hxPoolOptionsFor("bg", { FORTRESS_DB_BG_POOL_MAX: "3" }).max).toBe(3);
  });

  test("the =0 pooler hatch strips lock_timeout too — both are startup params", () => {
    const o = hxPoolOptionsFor("rw", { FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" });
    expect(o.connection).toBeUndefined();
  });

  test("lock_timeout=0 omits just that param, leaving statement_timeout intact", () => {
    expect(hxPoolOptionsFor("rw", { FORTRESS_DB_LOCK_TIMEOUT_MS: "0" }).connection).toEqual({
      statement_timeout: 120_000,
    });
  });
});
