import { describe, expect, test } from "bun:test";

import { fortressPaths } from "../src/host/paths";

describe("Fortress paths", () => {
  test("derives the canonical on-disk layout", () => {
    const paths = fortressPaths("/tmp/fortress");

    expect({
      root: paths.root,
      config: paths.config,
      credentials: paths.credentials,
      moduleInventory: paths.moduleInventory,
      log: paths.log,
      status: paths.status,
    }).toEqual({
      root: "/tmp/fortress",
      config: "/tmp/fortress/config.json",
      credentials: "/tmp/fortress/identity/credentials.json",
      moduleInventory: "/tmp/fortress/modules/inventory.json",
      log: "/tmp/fortress/logs/fortress.jsonl",
      status: "/tmp/fortress/runtime/status.json",
    });
    expect(paths.moduleConfig("session_vault")).toBe(
      "/tmp/fortress/modules/session_vault/config.json",
    );
    expect(paths.moduleArtifacts("session_vault")).toBe(
      "/tmp/fortress/modules/session_vault/artifacts",
    );
  });

  test.each(["", "../escape", "Session_Vault", "session/vault", "_private"])(
    "rejects invalid module id %p",
    (moduleId) => {
      const paths = fortressPaths("/tmp/fortress");

      expect(() => paths.moduleConfig(moduleId)).toThrow("Invalid module id");
      expect(() => paths.moduleArtifacts(moduleId)).toThrow("Invalid module id");
    },
  );
});
