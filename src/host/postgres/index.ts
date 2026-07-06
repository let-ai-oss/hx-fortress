import { mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireBinaries } from "./acquire";
import { detectMusl, resolveZonkyClassifier } from "./classifier";
import {
  ensureAppRoles,
  ensureAuth,
  ensureCluster,
  ensureDatabaseAndSchema,
  PG_APP_RO_ROLE,
  PG_APP_RW_ROLE,
  PG_DATABASE,
  PG_ROLE,
  type ClusterSql,
} from "./cluster";
import { ensureRoleSecrets, type RoleSecrets } from "./roles";
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

  // Per-install role secrets, read (or minted) once and memoized. Awaited by the
  // first boot hook that needs it (ensureCluster) and reused everywhere; the
  // synchronous role-DSN accessor below reads the resolved value (only ever
  // invoked once the cluster is ready, by which point this is populated).
  let secrets: RoleSecrets | null = null;
  const getSecrets = async (): Promise<RoleSecrets> => {
    if (!secrets) secrets = await ensureRoleSecrets(deps.paths.pgRoles);
    return secrets;
  };

  // Loopback only: the server binds 127.0.0.1, never an external interface. The
  // password is URL-safe hex (roles.ts), so it needs no escaping in the DSN.
  const dsnFor = (database: string, password: string, role: string): string =>
    `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
  // Bootstrap connections (schema, auth hardening, migrations) run as the
  // fortress superuser.
  const superDsn = (database: string, s: RoleSecrets): string =>
    dsnFor(database, s.super, PG_ROLE);
  // Role-aware DSN handed to modules once ready. Default/"rw" → the DML role;
  // "ro" → the SELECT-only role (least-privilege for the MCP read tools).
  const roleDsn = (role?: "ro" | "rw"): string => {
    if (!secrets) throw new Error("postgres role secrets not initialized");
    return role === "ro"
      ? dsnFor(PG_DATABASE, secrets.appRo, PG_APP_RO_ROLE)
      : dsnFor(PG_DATABASE, secrets.appRw, PG_APP_RW_ROLE);
  };

  const sql: ClusterSql = {
    run: async (database, statement) => {
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        await client.unsafe(statement);
      } finally {
        await client.end();
      }
    },
    exists: async (database, query) => {
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        const rows = await client.unsafe(query);
        return Array.isArray(rows) && rows.length > 0;
      } finally {
        await client.end();
      }
    },
  };

  return createEmbeddedPostgres({
    dsn: roleDsn,
    acquire: () =>
      acquireBinaries({
        fetchImpl: fetch,
        extract: makeExtractor(spawner),
        cacheDir: deps.paths.postgresCache,
        versionDir,
        classifier,
        version: resolved.version,
        binariesUrl: resolved.binariesUrl,
        // M-3: prefer the baked pinned hash; fall back to the network `.sha256`
        // (with a SECURITY warn) unless strict pinning is required.
        requirePinned: envFlag(deps.env.FORTRESS_PG_REQUIRE_PINNED),
        allowUnpinned: envFlag(deps.env.FORTRESS_PG_ALLOW_UNPINNED),
        log: (msg, fields) => deps.logger?.warn(msg, fields),
      }),
    ensureCluster: async (binDir) => {
      const s = await getSecrets();
      await ensureCluster({ spawner, binDir, dataDir, superPassword: s.super });
    },
    startServer: async (binDir) => {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
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
    ensureAuth: async (binDir) => {
      const s = await getSecrets();
      await ensureAuth(sql, dataDir, s, async () => {
        const { code, stderr } = await spawner.run([
          path.join(binDir, "pg_ctl"),
          "-D",
          dataDir,
          "reload",
        ]);
        if (code !== 0) throw new Error(`pg_ctl reload failed: ${stderr.trim()}`);
      });
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
      await runMigrations(makeMigrationExec(superDsn(PG_DATABASE, await getSecrets())), migrations);
    },
    ensureAppRoles: async () => {
      await ensureAppRoles(sql, await getSecrets());
    },
  });
}

/** Defensive boolean env parse: only the common truthy spellings enable a flag;
 *  anything else (unset, empty, "0", "false", junk) reads as off. */
function envFlag(value: string | undefined): boolean {
  const s = value?.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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
