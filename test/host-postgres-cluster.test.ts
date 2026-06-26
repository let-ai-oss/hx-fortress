import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureCluster, ensureDatabaseAndSchema } from "../src/host/postgres/cluster";
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
    await ensureCluster({ spawner, binDir: "/bin", dataDir: path.join(root, "pgdata"), socketDir: "/sock" });
    expect(calls[0][0]).toBe("/bin/initdb");
    expect(calls[0]).toContain("--auth=trust");
    expect(calls[0]).toContain("--username=fortress");
  });

  test("skips initdb when PG_VERSION already exists", async () => {
    const dataDir = path.join(root, "pgdata");
    await Bun.write(path.join(dataDir, "PG_VERSION"), "18\n");
    const { spawner, calls } = recorder();
    await ensureCluster({ spawner, binDir: "/bin", dataDir, socketDir: "/sock" });
    expect(calls.length).toBe(0);
  });

  test("creates database (when absent) and schema with psql", async () => {
    // First call = existence probe returns code 1 (absent) → CREATE DATABASE runs, then CREATE SCHEMA.
    const { spawner, calls } = recorder([{ code: 1 }]);
    await ensureDatabaseAndSchema({ spawner, binDir: "/bin", dataDir: "/d", socketDir: "/sock" });
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("/bin/psql"))).toBe(true);
    expect(joined.some((c) => c.includes('CREATE DATABASE "hx-db"'))).toBe(true);
    expect(joined.some((c) => c.includes("CREATE SCHEMA IF NOT EXISTS hx"))).toBe(true);
  });

  test("skips CREATE DATABASE when it already exists", async () => {
    // existence probe returns code 0 (present) → no CREATE DATABASE, still CREATE SCHEMA.
    const { spawner, calls } = recorder([{ code: 0 }]);
    await ensureDatabaseAndSchema({ spawner, binDir: "/bin", dataDir: "/d", socketDir: "/sock" });
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("CREATE DATABASE"))).toBe(false);
    expect(joined.some((c) => c.includes("CREATE SCHEMA IF NOT EXISTS hx"))).toBe(true);
  });
});
