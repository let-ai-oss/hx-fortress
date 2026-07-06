import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

const silentLogger = { info() {}, error() {} };

// A stand-in store: readiness only checks for its presence, never calls it.
const fakeStore = {} as SessionStore;

describe("gateway health endpoints", () => {
  let handle: GatewayHandle;
  let storeValue: SessionStore | null;

  beforeEach(() => {
    storeValue = fakeStore;
    handle = startGatewayServer({
      port: 0,
      logger: silentLogger,
      signingKey: async () => null,
      store: () => storeValue,
      postgresReady: () => true,
      db: () => null,
    });
  });

  afterEach(() => {
    handle.stop();
  });

  test("/healthz is an unauthenticated liveness probe that is always 200", async () => {
    storeValue = null;
    const res = await fetch(`http://localhost:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/readyz returns 200 once the vault store is available", async () => {
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ready: true });
  });

  test("/readyz returns 503 while the vault store is offline", async () => {
    storeValue = null;
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, ready: false });
  });

  // M-9a · a body over the 4 MiB ceiling is rejected at the HTTP layer (413)
  // before any handler runs, so a single upload can't exhaust memory.
  test("rejects a request body over the size ceiling", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024);
    const res = await fetch(`http://localhost:${handle.port}/sessions/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    }).catch(() => null);
    // Bun aborts an oversized body with 413 Payload Too Large.
    expect(res?.status).toBe(413);
  });
});
