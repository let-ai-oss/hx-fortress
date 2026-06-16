import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertModuleId, type fortressPaths } from "./paths";
import type { ConfigStore, FortressConfig } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export class FileConfigStore implements ConfigStore {
  constructor(private readonly paths: FortressPaths) {}

  async load(): Promise<FortressConfig> {
    let contents: string;
    try {
      contents = await readFile(this.paths.config, "utf8");
    } catch {
      throw invalidConfig("unable to read config.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidConfig("malformed JSON");
    }

    return parseFortressConfig(value);
  }
}

export function parseFortressConfig(value: unknown): FortressConfig {
  try {
    if (!isRecord(value)) throw new Error("root must be an object");
    if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    if (!isRecord(value.cloud)) throw new Error("cloud must be an object");
    if (typeof value.cloud.url !== "string") {
      throw new Error("cloud.url must be a string");
    }
    assertCloudUrl(value.cloud.url);
    if (!isRecord(value.modules)) throw new Error("modules must be an object");
    if (!Array.isArray(value.modules.enabled)) {
      throw new Error("modules.enabled must be an array");
    }
    if (!value.modules.enabled.every((moduleId) => typeof moduleId === "string")) {
      throw new Error("modules.enabled must contain module ids");
    }

    const enabled = value.modules.enabled as string[];
    for (const moduleId of enabled) assertModuleId(moduleId);
    if (new Set(enabled).size !== enabled.length) {
      throw new Error("modules.enabled must contain unique module ids");
    }

    return {
      schemaVersion: 1,
      cloud: { url: value.cloud.url },
      modules: { enabled: [...enabled] },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid Fortress config:")) {
      throw error;
    }
    throw invalidConfig(errorMessage(error));
  }
}

function assertCloudUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("cloud.url must be a valid URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("cloud.url must use ws: or wss:");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(reason: string): Error {
  return new Error(`Invalid Fortress config: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}

/** Migrate an existing config.json to include any core modules not yet listed
 *  in modules.enabled. No-op if config doesn't exist yet or is already up to date. */
export async function ensureCoreModulesEnabled(paths: FortressPaths): Promise<void> {
  let config: FortressConfig;
  try {
    config = await new FileConfigStore(paths).load();
  } catch {
    return;
  }

  const missing = CORE_MODULE_IDS.filter((id) => !config.modules.enabled.includes(id));
  if (missing.length === 0) return;

  const updated: FortressConfig = {
    ...config,
    modules: { enabled: [...config.modules.enabled, ...missing] },
  };
  const tmp = `${paths.config}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`);
  await rename(tmp, paths.config);
}

/** Bundled modules that must always be enabled. Added to new configs by default
 *  and migrated into existing configs by ensureCoreModulesEnabled. */
export const CORE_MODULE_IDS: readonly string[] = ["session_vault"];

/** Creates config.json with a minimal valid config if it does not already exist.
 *  Called by the host on startup when a pending enrollment is present. */
export async function ensureDefaultConfig(
  paths: FortressPaths,
  cloudUrl: string,
): Promise<void> {
  try {
    await access(paths.config);
    return;
  } catch {
    // file absent — write the default below
  }

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    modules: { enabled: [...CORE_MODULE_IDS] },
  };

  await mkdir(path.dirname(paths.config), { recursive: true });
  const tmp = `${paths.config}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, paths.config);
}
