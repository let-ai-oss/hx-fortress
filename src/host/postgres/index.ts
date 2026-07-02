import { mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireBinaries } from "./acquire";
import { detectMusl, resolveZonkyClassifier } from "./classifier";
import { ensureCluster, ensureDatabaseAndSchema, PG_DATABASE, PG_ROLE, type ClusterSql } from "./cluster";
import { makeExtractor, makeTarGzExtractor } from "./extract";
import { runMigrations } from "./migrate";
import { migrations } from "./migrations/manifest";
import { pgMajorOf } from "./pgvector-artifact";
import { ensurePgvectorInstalled } from "./pgvector-install";
import { createEmbeddedPostgres, createExternalPostgres } from "./provider";
import { resolvePostgresConfig } from "./resolve";
import { defaultSpawner, type Spawner } from "./spawn";
import { makeMigrationExec } from "./sql-exec";
import type { fortressPaths } from "../paths";
import type { FortressConfig, PostgresProvider, ScopedLogger } from "../types";

export interface BuildPostgresDeps {
  env: Record<string, string | undefined>;
  config: FortressConfig;
  paths: ReturnType<typeof fortressPaths>;
  platform?: NodeJS.Platform;
  arch?: string;
  spawner?: Spawner;
  logger?: ScopedLogger;
}

export function buildPostgresProvider(deps: BuildPostgresDeps): PostgresProvider {
  const spawner = deps.spawner ?? defaultSpawner;
  const resolved = resolvePostgresConfig(deps.env, deps.config, deps.paths.defaultPgData);

  if (resolved.mode === "external" && resolved.externalUrl) {
    const url = resolved.externalUrl;
    return createExternalPostgres(url, () => probe(url), async () => {
      await runMigrations(makeMigrationExec(url), migrations);
    });
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
    ensureVector: async () => {
      // pgvector is mandatory. It needs a download base (the cloud proxy); an
      // enrolled fortress always has one (the start sequence only runs once the
      // OpenAI key gate has passed, which implies enrollment). A missing base is
      // a real misconfiguration, so fail rather than silently degrade.
      if (!resolved.pgvectorUrl) {
        throw new Error(
          "pgvector requires a download base but none is configured " +
            "(no cloud URL and no FORTRESS_PGVECTOR_URL)",
        );
      }
      await ensurePgvectorInstalled({
        versionDir,
        classifier,
        pgMajor: pgMajorOf(resolved.version),
        baseUrl: resolved.pgvectorUrl,
        darwin: (deps.platform ?? process.platform) === "darwin",
        fetchImpl: fetch,
        extractTarGz: makeTarGzExtractor(spawner),
        spawn: async (cmd) => {
          const { code, stderr } = await spawner.run(cmd);
          if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
        },
        log: (msg, meta) => deps.logger?.info(msg, meta),
      });
    },
    migrate: async () => {
      await runMigrations(makeMigrationExec(dsnFor(PG_DATABASE)), migrations);
    },
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
