import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePendingEnrollmentForStartup, runFortressHost } from "../src/host/main";
import { FileCredentialStore, FilePendingEnrollmentStore, type WsCloudConnectionDeps } from "../src/cloud";
import type { ModuleRegistry } from "../src/host/module-registry";
import type { CloudConnection } from "../src/host/types";
import { fortressPaths } from "../src/host/paths";

describe("runFortressHost", () => {
  test("composes the production host runtime", async () => {
    let capturedRuntime: {
      start(): Promise<void>;
      stop(): Promise<void>;
    } | null = null;
    let capturedConnection: CloudConnection | null = null;
    let capturedDeps: WsCloudConnectionDeps | null = null;

    await runFortressHost({
      root: "/tmp/fortress",
      version: "0.0.0-test",
      createConnection(dependencies) {
        capturedDeps = dependencies;
        capturedConnection = {
          state: () => "offline",
          status: () => ({
            state: "offline",
            reason: null,
            message: null,
          }),
          open: async () => {},
          close: async () => {},
        };
        return capturedConnection;
      },
      run: async (runtime) => {
        capturedRuntime = runtime;
      },
    });

    expect(capturedRuntime).not.toBeNull();
    expect(capturedConnection).not.toBeNull();
    expect(capturedDeps).not.toBeNull();
    if (!capturedDeps) {
      throw new Error("expected capturedDeps");
    }
    const dependencies = capturedDeps as WsCloudConnectionDeps;
    expect(dependencies.identity).toMatchObject({
      version: "0.0.0-test",
      protocolVersion: 1,
    });
    const registry = dependencies.dispatcher as ModuleRegistry;
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "stopped", error: null },
    ]);
  });

  describe("pending enrollment", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "hx-fortress-host-main-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("ignores and clears a stale pending enrollment when credentials already exist", async () => {
      const paths = fortressPaths(root);
      await mkdir(path.dirname(paths.credentials), { recursive: true });
      await writeFile(
        paths.credentials,
        JSON.stringify({
          orgId: "org-1",
          fortressId: "fortress-1",
          credential: "credential-1",
        }),
      );
      await writeFile(
        paths.pendingEnrollment,
        JSON.stringify({
          token: "expired-token",
          cloudUrl: "wss://new.let.ai/_api/hx-gateway/vault-tunnel",
        }),
      );

      const pendingEnrollment = await resolvePendingEnrollmentForStartup(
        new FilePendingEnrollmentStore(paths.pendingEnrollment),
        new FileCredentialStore(paths.credentials),
      );

      expect(pendingEnrollment).toBeNull();
      await expect(readFile(paths.pendingEnrollment, "utf8")).rejects.toThrow();
    });
  });
});
