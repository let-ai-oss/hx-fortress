import { describe, expect, test } from "bun:test";

import { createEmbeddedPostgres, createExternalPostgres } from "../src/host/postgres/provider";

function fakeLaunch() {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (resolveExit = r));
  return { kill: () => resolveExit(0), exited };
}

describe("embedded provider", () => {
  test("progresses to ready and exposes a socket DSN", async () => {
    const provider = createEmbeddedPostgres({
      acquire: async () => "/bin",
      ensureCluster: async () => {},
      ensureDbSchema: async () => {},
      launch: () => fakeLaunch(),
      probeReady: async () => true,
      socketDir: "/sock",
    });
    await provider.start();
    expect(provider.status().phase).toBe("ready");
    expect(provider.isReady()).toBe(true);
    expect(provider.dsn()).toBe("postgresql://fortress@/hx-db?host=/sock");
    await provider.stop();
  });

  test("records failed phase without throwing when acquire fails", async () => {
    const provider = createEmbeddedPostgres({
      acquire: async () => {
        throw new Error("network down");
      },
      ensureCluster: async () => {},
      ensureDbSchema: async () => {},
      launch: () => ({ kill: () => {}, exited: Promise.resolve(0) }),
      probeReady: async () => false,
      socketDir: "/sock",
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
