import { describe, expect, test } from "bun:test";

import { createEmbeddedPostgres, createExternalPostgres } from "../src/host/postgres/provider";

const RW_DSN = "postgresql://hx_app_rw:pw-rw@127.0.0.1:54329/hx-db";
const RO_DSN = "postgresql://hx_app_ro:pw-ro@127.0.0.1:54329/hx-db";
const dsnFor = (role?: "ro" | "rw"): string => (role === "ro" ? RO_DSN : RW_DSN);

describe("embedded provider", () => {
  test("progresses to ready and exposes role-aware dsns in de-superuser order", async () => {
    const order: string[] = [];
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => {
        order.push("acquire");
        return "/bin";
      },
      ensureCluster: async () => {
        order.push("cluster");
      },
      startServer: async () => {
        order.push("start");
      },
      ensureAuth: async () => {
        order.push("auth");
      },
      ensureDbSchema: async () => {
        order.push("schema");
      },
      ensureVector: async () => {
        order.push("vector");
      },
      migrate: async () => {
        order.push("migrate");
      },
      ensureAppRoles: async () => {
        order.push("app-roles");
      },
      stopServer: async () => {
        order.push("stop");
      },
    });
    await provider.start();
    expect(provider.status().phase).toBe("ready");
    expect(provider.isReady()).toBe(true);
    // Default + "rw" resolve the DML role; "ro" the SELECT-only role.
    expect(provider.dsn()).toBe(RW_DSN);
    expect(provider.dsn("rw")).toBe(RW_DSN);
    expect(provider.dsn("ro")).toBe(RO_DSN);
    // ensureAuth runs after startServer + before schema; ensureAppRoles last.
    expect(order).toEqual([
      "acquire",
      "cluster",
      "start",
      "auth",
      "schema",
      "vector",
      "migrate",
      "app-roles",
    ]);
    await provider.stop();
    expect(order.at(-1)).toBe("stop");
  });

  test("records failed phase without throwing when acquire fails", async () => {
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => {
        throw new Error("network down");
      },
      ensureCluster: async () => {},
      startServer: async () => {},
      ensureDbSchema: async () => {},
      migrate: async () => {},
      stopServer: async () => {},
    });
    await provider.start();
    expect(provider.status().phase).toBe("failed");
    expect(provider.status().reason).toContain("network down");
    expect(provider.isReady()).toBe(false);
    expect(provider.dsn()).toBeNull();
    expect(provider.dsn("ro")).toBeNull();
  });
});

describe("external provider", () => {
  test("is ready when the probe succeeds; dsn echoes the url", async () => {
    const provider = createExternalPostgres("postgresql://host/hx-db", async () => true);
    await provider.start();
    expect(provider.isReady()).toBe(true);
    // Role-split is embedded-only: both roles resolve to the operator's URL.
    expect(provider.dsn()).toBe("postgresql://host/hx-db");
    expect(provider.dsn("rw")).toBe("postgresql://host/hx-db");
    expect(provider.dsn("ro")).toBe("postgresql://host/hx-db");
    await provider.stop();
  });

  test("fails without throwing when unreachable", async () => {
    const provider = createExternalPostgres("postgresql://host/hx-db", async () => false);
    await provider.start();
    expect(provider.status().phase).toBe("failed");
    expect(provider.isReady()).toBe(false);
  });
});
