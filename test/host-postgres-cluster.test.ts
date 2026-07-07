import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureAppRoles,
  ensureAuth,
  ensureCluster,
  ensureDatabaseAndSchema,
  type ClusterSql,
} from "../src/host/postgres/cluster";
import type { RoleSecrets } from "../src/host/postgres/roles";
import type { Spawner } from "../src/host/postgres/spawn";

const SECRETS: RoleSecrets = { super: "super-pw", appRo: "ro-pw", appRw: "rw-pw" };

function recorder(results: Array<{ code: number }> = []): {
  spawner: Spawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    spawner: {
      run: async (cmd) => {
        calls.push(cmd);
        const r = results[i++] ?? { code: 0 };
        return { code: r.code, stderr: "" };
      },
    },
  };
}

function fakeSql(
  exists: boolean | ((database: string, query: string) => boolean) = false,
): { sql: ClusterSql; runs: Array<[string, string]> } {
  const runs: Array<[string, string]> = [];
  const existsFn = typeof exists === "function" ? exists : () => exists;
  return {
    runs,
    sql: {
      run: async (database, statement) => {
        runs.push([database, statement]);
      },
      exists: async (database, query) => existsFn(database, query),
    },
  };
}

describe("cluster", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-cluster-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("runs initdb with scram + a pwfile when the data dir is empty", async () => {
    const { spawner, calls } = recorder();
    await ensureCluster({
      spawner,
      binDir: "/bin",
      dataDir: path.join(root, "pgdata"),
      superPassword: SECRETS.super,
    });
    expect(calls[0][0]).toBe("/bin/initdb");
    // De-superuser: scram for local + host, no more --auth=trust.
    expect(calls[0]).toContain("--auth-host=scram-sha-256");
    expect(calls[0]).toContain("--auth-local=scram-sha-256");
    expect(calls[0]).not.toContain("--auth=trust");
    expect(calls[0]).toContain("--username=fortress");
    // The superuser password is seeded from a temp --pwfile (removed after).
    expect(calls[0].some((a) => a.startsWith("--pwfile="))).toBe(true);
  });

  test("skips initdb when PG_VERSION already exists (never re-inits)", async () => {
    const dataDir = path.join(root, "pgdata");
    await Bun.write(path.join(dataDir, "PG_VERSION"), "18\n");
    const { spawner, calls } = recorder();
    await ensureCluster({ spawner, binDir: "/bin", dataDir, superPassword: SECRETS.super });
    expect(calls.length).toBe(0);
  });

  test("creates database when absent, then schema", async () => {
    const { sql, runs } = fakeSql(false);
    await ensureDatabaseAndSchema(sql);
    expect(runs[0]).toEqual(["postgres", 'CREATE DATABASE "hx-db"']);
    expect(runs[1]).toEqual(["hx-db", "CREATE SCHEMA IF NOT EXISTS hx"]);
  });

  test("skips database creation when it already exists, still ensures schema", async () => {
    const { sql, runs } = fakeSql(true);
    await ensureDatabaseAndSchema(sql);
    expect(runs.some(([, s]) => s.includes("CREATE DATABASE"))).toBe(false);
    expect(runs).toContainEqual(["hx-db", "CREATE SCHEMA IF NOT EXISTS hx"]);
  });
});

describe("ensureAuth (in-place trust→scram conversion)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-auth-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("sets the super password, writes a scram HBA, then reloads (in that order)", async () => {
    const { sql, runs } = fakeSql(false);
    let hbaAtReload: string | null = null;
    let reloads = 0;
    const reload = async (): Promise<void> => {
      reloads += 1;
      // The HBA must already be rewritten before the reload fires.
      hbaAtReload = await readFile(path.join(root, "pg_hba.conf"), "utf8").catch(() => null);
    };
    await ensureAuth(sql, root, SECRETS, reload);

    // ALTER ROLE runs on the always-present `postgres` db (hx-db may not exist yet).
    expect(runs).toContainEqual(["postgres", "ALTER ROLE fortress WITH PASSWORD 'super-pw'"]);
    expect(reloads).toBe(1);

    const hba = await readFile(path.join(root, "pg_hba.conf"), "utf8");
    expect(hba).toContain("scram-sha-256");
    expect(hba).toContain("127.0.0.1/32");
    expect(hba).toContain("0.0.0.0/0       reject");
    expect(hba).toContain("::/0            reject");
    // No trust anywhere in the managed ruleset.
    expect(hba).not.toContain("trust");
    // The HBA was already on disk when reload fired (rewrite precedes reload).
    expect(hbaAtReload ?? "").toContain("scram-sha-256");
  });
});

describe("ensureAppRoles (idempotent least-privilege roles)", () => {
  test("creates both login roles + grants when they are absent", async () => {
    const { sql, runs } = fakeSql(false);
    await ensureAppRoles(sql, SECRETS);
    const stmts = runs.map(([, s]) => s);

    expect(stmts).toContain("CREATE ROLE hx_app_ro LOGIN IN ROLE hx_readonly");
    expect(stmts).toContain("CREATE ROLE hx_app_rw LOGIN");
    expect(stmts).toContain("ALTER ROLE hx_app_ro WITH PASSWORD 'ro-pw'");
    expect(stmts).toContain("ALTER ROLE hx_app_rw WITH PASSWORD 'rw-pw'");
    expect(stmts).toContain("GRANT hx_readonly TO hx_app_ro");
    expect(stmts).toContain("GRANT USAGE ON SCHEMA hx TO hx_app_rw");
    expect(
      stmts.some((s) => s.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hx TO hx_app_rw")),
    ).toBe(true);
    expect(stmts.some((s) => s.includes("GRANT USAGE ON ALL SEQUENCES IN SCHEMA hx TO hx_app_rw"))).toBe(true);
    expect(stmts.some((s) => s.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA hx"))).toBe(true);
    // The migration journal's writes are revoked back from the DML role.
    expect(
      stmts.some((s) =>
        /REVOKE INSERT, UPDATE, DELETE ON hx\.schema_migrations FROM hx_app_rw/.test(s),
      ),
    ).toBe(true);
    // hx_app_rw never gets DDL/superuser via this path.
    expect(stmts.some((s) => /CREATE TABLE|SUPERUSER|CREATEROLE|CREATEDB/.test(s))).toBe(false);
  });

  test("skips CREATE ROLE when the roles already exist, but re-applies grants (idempotent)", async () => {
    const { sql, runs } = fakeSql(true);
    await ensureAppRoles(sql, SECRETS);
    const stmts = runs.map(([, s]) => s);

    expect(stmts.some((s) => s.startsWith("CREATE ROLE"))).toBe(false);
    // Passwords + grants are re-applied every boot regardless.
    expect(stmts).toContain("ALTER ROLE hx_app_ro WITH PASSWORD 'ro-pw'");
    expect(stmts).toContain("ALTER ROLE hx_app_rw WITH PASSWORD 'rw-pw'");
    expect(stmts).toContain("GRANT USAGE ON SCHEMA hx TO hx_app_rw");
  });
});
