import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureCluster,
  ensureDatabaseAndSchema,
  type ClusterSql,
} from "../src/host/postgres/cluster";
import type { Spawner } from "../src/host/postgres/spawn";

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

function fakeSql(present: boolean): { sql: ClusterSql; runs: Array<[string, string]> } {
  const runs: Array<[string, string]> = [];
  return {
    runs,
    sql: {
      run: async (database, statement) => {
        runs.push([database, statement]);
      },
      exists: async () => present,
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

  test("runs initdb when the data dir is empty", async () => {
    const { spawner, calls } = recorder();
    await ensureCluster({ spawner, binDir: "/bin", dataDir: path.join(root, "pgdata") });
    expect(calls[0][0]).toBe("/bin/initdb");
    expect(calls[0]).toContain("--auth=trust");
    expect(calls[0]).toContain("--username=fortress");
  });

  test("skips initdb when PG_VERSION already exists", async () => {
    const dataDir = path.join(root, "pgdata");
    await Bun.write(path.join(dataDir, "PG_VERSION"), "18\n");
    const { spawner, calls } = recorder();
    await ensureCluster({ spawner, binDir: "/bin", dataDir });
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
