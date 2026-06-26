import { existsSync } from "node:fs";
import path from "node:path";

import type { Spawner } from "./spawn";

export const PG_ROLE = "fortress";
export const PG_DATABASE = "hx-db";
export const PG_SCHEMA = "hx";

export interface ClusterDeps {
  spawner: Spawner;
  binDir: string;
  dataDir: string;
  socketDir: string;
}

export async function ensureCluster(deps: ClusterDeps): Promise<void> {
  if (existsSync(path.join(deps.dataDir, "PG_VERSION"))) return;
  await run(deps.spawner, [
    path.join(deps.binDir, "initdb"),
    "-D",
    deps.dataDir,
    "--encoding=UTF8",
    "--auth=trust",
    `--username=${PG_ROLE}`,
  ]);
}

export async function ensureDatabaseAndSchema(deps: ClusterDeps): Promise<void> {
  const psql = path.join(deps.binDir, "psql");
  const conn = ["-h", deps.socketDir, "-U", PG_ROLE, "-v", "ON_ERROR_STOP=1"];

  const probe = await deps.spawner.run([
    psql, ...conn, "-d", "postgres", "-tAc",
    `SELECT 1 FROM pg_database WHERE datname='${PG_DATABASE}'`,
  ]);
  if (probe.code !== 0) {
    await run(deps.spawner, [
      psql, ...conn, "-d", "postgres", "-c", `CREATE DATABASE "${PG_DATABASE}"`,
    ]);
  }
  await run(deps.spawner, [
    psql, ...conn, "-d", PG_DATABASE, "-c", `CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`,
  ]);
}

async function run(spawner: Spawner, cmd: string[]): Promise<void> {
  const { code, stderr } = await spawner.run(cmd);
  if (code !== 0) throw new Error(`${path.basename(cmd[0])} failed: ${stderr.trim()}`);
}
