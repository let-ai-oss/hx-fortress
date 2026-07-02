import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertModuleId, type fortressPaths } from "./paths";
import { HX_EMBEDDING_DIM } from "./postgres/schema/embeddings";
import type { ConfigStore, FortressConfig, FortressPostgresConfig } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export class FileConfigStore implements ConfigStore {
  constructor(private readonly paths: FortressPaths) { }

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

export const DEFAULT_GATEWAY_PORT = 8787;
export const DEFAULT_GATEWAY_PUBLIC_URL = `http://localhost:${DEFAULT_GATEWAY_PORT}`;

export function parseFortressConfig(value: unknown): FortressConfig {
  try {
    if (!isRecord(value)) throw new Error("root must be an object");
    if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    if (!isRecord(value.cloud)) throw new Error("cloud must be an object");
    if (typeof value.cloud.url !== "string") {
      throw new Error("cloud.url must be a string");
    }
    assertCloudUrl(value.cloud.url);

    const gatewayPublicUrl = parseGatewayPublicUrl(value.gateway);

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

    const postgres = parsePostgresConfig(value.postgres);

    return {
      schemaVersion: 1,
      cloud: { url: value.cloud.url },
      gateway: { publicUrl: gatewayPublicUrl },
      modules: { enabled: [...enabled] },
      ...(postgres ? { postgres } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid Fortress config:")) {
      throw error;
    }
    throw invalidConfig(errorMessage(error));
  }
}

function parseGatewayPublicUrl(value: unknown): string {
  if (typeof value === "undefined") return DEFAULT_GATEWAY_PUBLIC_URL;
  if (!isRecord(value)) throw new Error("gateway must be an object");
  if (typeof value.publicUrl !== "string") {
    throw new Error("gateway.publicUrl must be a string");
  }
  assertGatewayPublicUrl(value.publicUrl);
  return value.publicUrl;
}

function parsePostgresConfig(value: unknown): FortressPostgresConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("postgres must be an object");
  const result: FortressPostgresConfig = {};
  for (const key of ["version", "binariesUrl", "dataDir", "externalUrl", "pgvectorUrl"] as const) {
    const field = value[key];
    if (typeof field === "undefined") continue;
    if (typeof field !== "string") throw new Error(`postgres.${key} must be a string`);
    result[key] = field;
  }
  if (typeof value.port !== "undefined") {
    if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
      throw new Error("postgres.port must be an integer");
    }
    result.port = value.port;
  }
  return result;
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

export function assertGatewayPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("gateway.publicUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("gateway.publicUrl must use http: or https:");
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

// ── Ingest gateway ──────────────────────────────────────────────────────────

export interface GatewayConfig {
  enabled: boolean;
  gatewayUrl?: string;
  port: number;
}

/** Resolve the direct-ingest ("fortress-direct") gateway settings. MC-2382
 *  retired this path: by default hx uploads relay over the reverse tunnel, so the
 *  fortress advertises no public URL and the local gateway server stays off. A
 *  public URL is advertised ONLY when the operator opts in via FORTRESS_PUBLIC_URL
 *  (the persisted localhost default is local-only, never advertised).
 *  FORTRESS_GATEWAY_PORT overrides the listen port. */
export function resolveGatewayConfig(
  env: Record<string, string | undefined>,
  // _persistedGatewayUrl?: string,
): GatewayConfig {
  const gatewayUrl = env.FORTRESS_PUBLIC_URL?.trim();
  const port = Number(env.FORTRESS_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
  return { enabled: Boolean(gatewayUrl), gatewayUrl: gatewayUrl || undefined, port };
}

// ── Embed worker (A3) ─────────────────────────────────────────────────────

export interface EmbedConfig {
  /** True only when FORTRESS_OPENAI_API_KEY is set — otherwise the worker stays
   *  off and hx_semantic_search degrades to keyword. */
  enabled: boolean;
  apiKey: string;
  model: string;
  dimensions: number;
  /** OpenAI endpoint base (override for a zero-retention / DPA endpoint). */
  baseUrl: string;
  /** The worker's OWN Bun.SQL pool cap (the createHxDb handle is uncapped). */
  dbMax: number;
  concurrency: number;
  batchSize: number;
  maxPerPass: number;
  debounceMs: number;
  maxWaitMs: number;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// hx.embeddings.embedding is vector(HX_EMBEDDING_DIM = 1024). text-embedding-3-large
// supports Matryoshka dims 256..3072; a value outside that range is nonsensical for the
// model (OpenAI would 400), so fall back to 1024 rather than crash the embed worker.
// NOTE: the column is fixed at 1024 — ANY non-1024 dimension needs a migration to
// widen/narrow the vector column, so the safest value is 1024 unless the column is migrated.
const EMBED_DIM_MIN = 256;
const EMBED_DIM_MAX = 3072;

/** Range-validate FORTRESS_EMBED_DIMENSIONS, falling back to the column width (1024)
 *  when out of the model's valid Matryoshka range. */
function resolveEmbedDimensions(value: string | undefined): number {
  const dims = intEnv(value, HX_EMBEDDING_DIM);
  return dims >= EMBED_DIM_MIN && dims <= EMBED_DIM_MAX ? dims : HX_EMBEDDING_DIM;
}

/** Resolve the embed worker's settings from FORTRESS_* env. The OpenAI key (the
 *  one HUMAN input, §13-A3) gates the whole feature: absent ⇒ disabled. Model
 *  defaults match the spec — text-embedding-3-large @ 1024 (Matryoshka). */
export function resolveEmbedConfig(
  env: Record<string, string | undefined>,
  configKey?: string,
): EmbedConfig {
  // Env overrides the persisted key (ops flexibility); otherwise use the key the
  // enroll wizard wrote to credentials.json (MC-2465).
  const apiKey = env.FORTRESS_OPENAI_API_KEY?.trim() || configKey?.trim() || "";
  return {
    enabled: apiKey.length > 0,
    apiKey,
    model: env.FORTRESS_EMBED_MODEL?.trim() || "text-embedding-3-large",
    dimensions: resolveEmbedDimensions(env.FORTRESS_EMBED_DIMENSIONS),
    baseUrl: env.FORTRESS_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    dbMax: intEnv(env.FORTRESS_EMBED_DB_MAX, 4),
    concurrency: intEnv(env.FORTRESS_EMBED_CONCURRENCY, 2),
    batchSize: intEnv(env.FORTRESS_EMBED_BATCH, 96),
    maxPerPass: intEnv(env.FORTRESS_EMBED_MAX_PER_PASS, 500),
    debounceMs: intEnv(env.FORTRESS_EMBED_DEBOUNCE_MS, 5_000),
    maxWaitMs: intEnv(env.FORTRESS_EMBED_MAX_WAIT_MS, 30 * 60_000),
  };
}

export async function ensureGatewayPublicUrlConfigured(
  paths: FortressPaths,
  gatewayPublicUrl = DEFAULT_GATEWAY_PUBLIC_URL,
): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(paths.config, "utf8");
  } catch {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return;
  }

  if (isRecord(value) && isRecord(value.gateway) && typeof value.gateway.publicUrl === "string") {
    return;
  }

  assertGatewayPublicUrl(gatewayPublicUrl);
  const normalized = parseFortressConfig(value);
  await writeConfig(paths, {
    ...normalized,
    gateway: { publicUrl: gatewayPublicUrl },
  });
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
  await writeConfig(paths, updated);
}

/** Bundled modules that must always be enabled. Added to new configs by default
 *  and migrated into existing configs by ensureCoreModulesEnabled. */
export const CORE_MODULE_IDS: readonly string[] = ["session_vault"];

/** Creates config.json with a minimal valid config if it does not already exist.
 *  Called by the host on startup when a pending enrollment is present. */
export async function ensureDefaultConfig(
  paths: FortressPaths,
  cloudUrl: string,
  gatewayPublicUrl = DEFAULT_GATEWAY_PUBLIC_URL,
): Promise<void> {
  try {
    await access(paths.config);
    return;
  } catch {
    // file absent — write the default below
  }

  assertGatewayPublicUrl(gatewayPublicUrl);

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    gateway: { publicUrl: gatewayPublicUrl },
    modules: { enabled: [...CORE_MODULE_IDS] },
  };

  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeConfig(paths, config);
}

/** Creates or updates config.json for an explicit enrollment attempt.
 *  A pending enrollment is the operator's current install intent, so the cloud
 *  URL must point at that enrollment even when an old config already exists. */
export async function ensureEnrollmentConfig(
  paths: FortressPaths,
  cloudUrl: string,
  gatewayPublicUrl?: string,
): Promise<void> {
  if (gatewayPublicUrl) assertGatewayPublicUrl(gatewayPublicUrl);

  const existing = await new FileConfigStore(paths).load().catch(() => null);

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    gateway: { publicUrl: gatewayPublicUrl ?? existing?.gateway.publicUrl ?? DEFAULT_GATEWAY_PUBLIC_URL },
    modules: existing?.modules ?? { enabled: [...CORE_MODULE_IDS] },
  };

  await writeConfig(paths, config);
}

async function writeConfig(paths: FortressPaths, config: FortressConfig): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  const tmp = `${paths.config}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, paths.config);
}
