import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureDefaultConfig, FileConfigStore } from "../src/host/config";
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

describe("ensureDefaultConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ensure-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("creates config.json with the given cloud URL when absent", async () => {
    const paths = fortressPaths(root);
    await ensureDefaultConfig(paths, "wss://let.ai/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored).toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://let.ai/tunnel" },
      modules: { enabled: [] },
    });
  });

  test("creates parent directory if it does not exist", async () => {
    const nested = path.join(root, "deep", "fortress");
    const paths = fortressPaths(nested);
    await ensureDefaultConfig(paths, "wss://let.ai/tunnel");

    const raw = JSON.parse(await readFile(paths.config, "utf8")) as unknown;
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  test("does not overwrite an existing config", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://original.let.ai/tunnel" },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureDefaultConfig(paths, "wss://new.let.ai/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud.url).toBe("wss://original.let.ai/tunnel");
    expect(stored.modules.enabled).toEqual(["session_vault"]);
  });
});
