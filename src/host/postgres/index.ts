import { mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireBinaries } from "./acquire";
import { detectMusl, resolveZonkyClassifier } from "./classifier";
import { ensureCluster, ensureDatabaseAndSchema } from "./cluster";
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
    return createExternalPostgres(url, () => probeExternal(url));
  }

  const classifier = resolveZonkyClassifier(
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
    detectMusl(),
  );
  const versionDir = deps.paths.postgresVersionDir(resolved.version);
  const binDir = path.join(versionDir, "bin");
  const socketDir = deps.paths.postgresSocket;
  const cluster = (resolvedBinDir: string) => ({
    spawner,
    binDir: resolvedBinDir,
    dataDir: resolved.dataDir,
    socketDir,
  });

  return createEmbeddedPostgres({
    socketDir,
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
    ensureCluster: async (resolvedBinDir) => {
      await mkdir(socketDir, { recursive: true });
      await ensureCluster(cluster(resolvedBinDir));
    },
    ensureDbSchema: (resolvedBinDir) => ensureDatabaseAndSchema(cluster(resolvedBinDir)),
    launch: (resolvedBinDir) => launchPostgres(resolvedBinDir, resolved.dataDir, socketDir),
    probeReady: () => probeSocket(spawner, binDir, socketDir),
  });
}

function launchPostgres(
  binDir: string,
  dataDir: string,
  socketDir: string,
): { kill: () => void; exited: Promise<number> } {
  const proc = Bun.spawn(
    [path.join(binDir, "postgres"), "-D", dataDir, "-k", socketDir, "-c", "listen_addresses="],
    { stdout: "inherit", stderr: "inherit" },
  );
  return { kill: () => proc.kill("SIGTERM"), exited: proc.exited };
}

async function probeSocket(
  spawner: Spawner,
  binDir: string,
  socketDir: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await spawner.run([path.join(binDir, "pg_isready"), "-h", socketDir]);
    if (res.code === 0) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function probeExternal(url: string): Promise<boolean> {
  try {
    const sql = new Bun.SQL(url);
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}
