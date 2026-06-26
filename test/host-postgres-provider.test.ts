import { describe, expect, test } from "bun:test";

import { createEmbeddedPostgres, createExternalPostgres } from "../src/host/postgres/provider";

const DSN = "postgresql://fortress@127.0.0.1:54329/hx-db";

describe("embedded provider", () => {
  test("progresses to ready and exposes the dsn", async () => {
    const order: string[] = [];
    const provider = createEmbeddedPostgres({
      dsn: DSN,
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
      ensureDbSchema: async () => {
        order.push("schema");
      },
      stopServer: async () => {
        order.push("stop");
      },
    });
    await provider.start();
    expect(provider.status().phase).toBe("ready");
    expect(provider.isReady()).toBe(true);
    expect(provider.dsn()).toBe(DSN);
    expect(order).toEqual(["acquire", "cluster", "start", "schema"]);
    await provider.stop();
    expect(order.at(-1)).toBe("stop");
  });

  test("records failed phase without throwing when acquire fails", async () => {
    const provider = createEmbeddedPostgres({
      dsn: DSN,
      acquire: async () => {
        throw new Error("network down");
      },
      ensureCluster: async () => {},
      startServer: async () => {},
      ensureDbSchema: async () => {},
      stopServer: async () => {},
    });
    await provider.start();
    expect(provider.status().phase).toBe("failed");
    expect(provider.status().reason).toContain("network down");
    expect(provider.isReady()).toBe(false);
    expect(provider.dsn()).toBeNull();
  });
});

describe("external provider", () => {
  test("is ready when the probe succeeds; dsn echoes the url", async () => {
    const provider = createExternalPostgres("postgresql://host/hx-db", async () => true);
    await provider.start();
    expect(provider.isReady()).toBe(true);
    expect(provider.dsn()).toBe("postgresql://host/hx-db");
    await provider.stop();
  });

  test("fails without throwing when unreachable", async () => {
    const provider = createExternalPostgres("postgresql://host/hx-db", async () => false);
    await provider.start();
    expect(provider.status().phase).toBe("failed");
    expect(provider.isReady()).toBe(false);
  });
});
