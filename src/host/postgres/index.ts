import { mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireBinaries } from "./acquire";
import { detectMusl, resolveZonkyClassifier } from "./classifier";
import { ensureCluster, ensureDatabaseAndSchema, PG_DATABASE, PG_ROLE, type ClusterSql } from "./cluster";
import { makeExtractor } from "./extract";
import { createEmbeddedPostgres, createExternalPostgres } from "./provider";
import { resolvePostgresConfig } from "./resolve";
import { defaultSpawner, type Spawner } from "./spawn";
import type { fortressPaths } from "../paths";
import type { FortressConfig, PostgresProvider } from "../types";

export interface BuildPostgresDeps {
  env: Record<string, string | undefined>;
  config: FortressConfig;
  paths: ReturnType<typeof fortressPaths>;
  platform?: NodeJS.Platform;
  arch?: string;
  spawner?: Spawner;
}

export function buildPostgresProvider(deps: BuildPostgresDeps): PostgresProvider {
  const spawner = deps.spawner ?? defaultSpawner;
  const resolved = resolvePostgresConfig(deps.env, deps.config, deps.paths.defaultPgData);

  if (resolved.mode === "external" && resolved.externalUrl) {
    const url = resolved.externalUrl;
    return createExternalPostgres(url, () => probe(url));
  }

  const classifier = resolveZonkyClassifier(
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
    detectMusl(),
  );
  const versionDir = deps.paths.postgresVersionDir(resolved.version);
  const dataDir = resolved.dataDir;
  const socketDir = deps.paths.postgresSocket;
  const port = resolved.port;
  // Loopback only: the server binds 127.0.0.1, never an external interface.
  const dsnFor = (database: string) =>
    `postgresql://${PG_ROLE}@127.0.0.1:${port}/${database}`;

  const sql: ClusterSql = {
    run: async (database, statement) => {
      const client = new Bun.SQL(dsnFor(database));
      try {
        await client.unsafe(statement);
      } finally {
        await client.end();
      }
    },
    exists: async (database, query) => {
      const client = new Bun.SQL(dsnFor(database));
      try {
        const rows = await client.unsafe(query);
        return Array.isArray(rows) && rows.length > 0;
      } finally {
        await client.end();
      }
    },
  };

  return createEmbeddedPostgres({
    dsn: dsnFor(PG_DATABASE),
    acquire: () =>
      acquireBinaries({
        fetchImpl: fetch,
        extract: makeExtractor(spawner),
        cacheDir: deps.paths.postgresCache,
        versionDir,
        classifier,
        version: resolved.version,
        binariesUrl: resolved.binariesUrl,
      }),
    ensureCluster: (binDir) => ensureCluster({ spawner, binDir, dataDir }),
    startServer: async (binDir) => {
      await mkdir(socketDir, { recursive: true });
      const { code, stderr } = await spawner.run([
        path.join(binDir, "pg_ctl"),
        "-D",
        dataDir,
        "-w",
        "-o",
        `-k ${socketDir} -p ${port} -c listen_addresses=127.0.0.1`,
        "start",
      ]);
      if (code !== 0) throw new Error(`pg_ctl start failed: ${stderr.trim()}`);
    },
    stopServer: async (binDir) => {
      await spawner.run([path.join(binDir, "pg_ctl"), "-D", dataDir, "-m", "fast", "stop"]);
    },
    ensureDbSchema: () => ensureDatabaseAndSchema(sql),
  });
}

async function probe(url: string): Promise<boolean> {
  try {
    const client = new Bun.SQL(url);
    await client`SELECT 1`;
    await client.end();
    return true;
  } catch {
    return false;
  }
}
