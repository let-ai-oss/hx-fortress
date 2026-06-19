import { describe, expect, test } from "bun:test";

import { runFortressHost } from "../src/host/main";
import type { WsCloudConnectionDeps } from "../src/cloud";
import type { ModuleRegistry } from "../src/host/module-registry";
import type { CloudConnection } from "../src/host/types";

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
});
