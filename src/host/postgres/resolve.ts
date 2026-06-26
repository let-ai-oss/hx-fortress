import type { FortressConfig } from "../types";

export const DEFAULT_PG_VERSION = "18.4.0";
export const DEFAULT_PG_BINARIES_URL = "https://repo1.maven.org/maven2";

export interface ResolvedPostgresConfig {
  mode: "embedded" | "external";
  version: string;
  binariesUrl: string;
  dataDir: string;
  externalUrl: string | null;
}

export function resolvePostgresConfig(
  env: Record<string, string | undefined>,
  config: FortressConfig,
  defaultDataDir: string,
): ResolvedPostgresConfig {
  const persisted = config.postgres ?? {};
  const externalUrl = pick(env.FORTRESS_DATABASE_URL, persisted.externalUrl, null);
  return {
    mode: externalUrl ? "external" : "embedded",
    version: pick(env.FORTRESS_PG_VERSION, persisted.version, DEFAULT_PG_VERSION),
    binariesUrl: pick(env.FORTRESS_PG_BINARIES_URL, persisted.binariesUrl, DEFAULT_PG_BINARIES_URL),
    dataDir: pick(env.FORTRESS_PG_DATA, persisted.dataDir, defaultDataDir),
    externalUrl,
  };
}

function pick<T extends string | null>(
  envValue: string | undefined,
  configValue: string | undefined,
  fallback: T,
): string | T {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = configValue?.trim();
  if (fromConfig) return fromConfig;
  return fallback;
}
