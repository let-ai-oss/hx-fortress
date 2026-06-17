import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureCoreModulesEnabled,
  ensureDefaultConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
} from "../src/host/config";
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
      gateway: { publicUrl: "https://fortress.example", future: true },
      modules: { enabled: ["session_vault"], future: true },
      future: true,
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://example.let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("defaults the gateway URL for legacy configs that predate the field", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "wss://example.let.ai/tunnel" },
      modules: { enabled: ["session_vault"] },
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://example.let.ai/tunnel" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
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
      {
        schemaVersion: 2,
        cloud: { url: "wss://example.let.ai" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: [] },
      },
      "schemaVersion must be 1",
    ],
    [
      "unsafe cloud URL",
      {
        schemaVersion: 1,
        cloud: { url: "https://example.let.ai" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: [] },
      },
      "cloud.url must use ws: or wss:",
    ],
    [
      "unsafe gateway URL",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        gateway: { publicUrl: "ws://fortress.example" },
        modules: { enabled: [] },
      },
      "gateway.publicUrl must use http: or https:",
    ],
    [
      "duplicate modules",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["session_vault", "session_vault"] },
      },
      "modules.enabled must contain unique module ids",
    ],
    [
      "invalid module id",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["../escape"] },
      },
      "Invalid module id",
    ],
    [
      "missing cloud object",
      { schemaVersion: 1, gateway: { publicUrl: "https://fortress.example" }, modules: { enabled: [] } },
      "cloud must be an object",
    ],
    [
      "missing modules array",
      {
        schemaVersion: 1,
        cloud: { url: "wss://example.let.ai" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: {},
      },
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

  test("creates config.json with the given cloud URL and default gateway URL when absent", async () => {
    const paths = fortressPaths(root);
    await ensureDefaultConfig(paths, "wss://let.ai/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored).toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://let.ai/tunnel" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("creates config.json with an explicit gateway public URL when given", async () => {
    const paths = fortressPaths(root);
    await ensureDefaultConfig(paths, "wss://let.ai/tunnel", "https://fortress.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
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
      gateway: { publicUrl: "https://original.example" },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureDefaultConfig(paths, "wss://new.let.ai/tunnel", "https://new.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud.url).toBe("wss://original.let.ai/tunnel");
    expect(stored.gateway.publicUrl).toBe("https://original.example");
    expect(stored.modules.enabled).toEqual(["session_vault"]);
  });
});

describe("ensureGatewayPublicUrlConfigured", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ensure-gateway-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes the default gateway URL into a legacy config missing the field", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://let.ai/tunnel" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe(DEFAULT_GATEWAY_PUBLIC_URL);
  });

  test("writes the chosen gateway URL into a legacy config missing the field", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://let.ai/tunnel" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths, "https://fortress.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
  });

  test("preserves an existing gateway URL", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://let.ai/tunnel" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
  });
});

describe("ensureCoreModulesEnabled", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-core-modules-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("no-ops when config does not exist", async () => {
    const paths = fortressPaths(root);
    await expect(ensureCoreModulesEnabled(paths)).resolves.toBeUndefined();
  });

  test("no-ops when all core modules already enabled", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toEqual(["session_vault"]);
  });

  test("adds missing core modules to existing config", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toContain("session_vault");
    expect(stored.cloud.url).toBe("wss://let.ai/tunnel");
  });

  test("preserves existing non-core enabled modules", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toContain("session_vault");
  });
});
