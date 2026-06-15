import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileConfigStore } from "../src/host/config";
import { fortressPaths } from "../src/host/paths";

describe("Fortress config", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("loads the versioned host configuration", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "wss://example.let.ai/tunnel", future: true },
      modules: { enabled: ["session_vault"], future: true },
      future: true,
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://example.let.ai/tunnel" },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("rejects a missing config file without exposing file contents", async () => {
    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(
      "Invalid Fortress config: unable to read config.json",
    );
  });

  test.each([
    ["malformed JSON", "{not-json", "malformed JSON"],
    [
      "unsupported schema",
      { schemaVersion: 2, cloud: { url: "wss://example.let.ai" }, modules: { enabled: [] } },
      "schemaVersion must be 1",
    ],
    [
      "unsafe cloud URL",
      { schemaVersion: 1, cloud: { url: "https://example.let.ai" }, modules: { enabled: [] } },
      "cloud.url must use ws: or wss:",
    ],
    [
      "duplicate modules",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        modules: { enabled: ["session_vault", "session_vault"] },
      },
      "modules.enabled must contain unique module ids",
    ],
    [
      "invalid module id",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        modules: { enabled: ["../escape"] },
      },
      "Invalid module id",
    ],
    [
      "missing cloud object",
      { schemaVersion: 1, modules: { enabled: [] } },
      "cloud must be an object",
    ],
    [
      "missing modules array",
      { schemaVersion: 1, cloud: { url: "wss://example.let.ai" }, modules: {} },
      "modules.enabled must be an array",
    ],
  ])("rejects %s", async (_name, input, reason) => {
    await writeConfig(input);

    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(
      `Invalid Fortress config: ${reason}`,
    );
  });

  async function writeConfig(value: unknown): Promise<void> {
    const contents = typeof value === "string" ? value : JSON.stringify(value);
    await writeFile(fortressPaths(root).config, contents);
  }
});
