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
}

/** Initialize the data directory if it has not been initialized yet. */
export async function ensureCluster(deps: ClusterDeps): Promise<void> {
  if (existsSync(path.join(deps.dataDir, "PG_VERSION"))) return;
  const { code, stderr } = await deps.spawner.run([
    path.join(deps.binDir, "initdb"),
    "-D",
    deps.dataDir,
    "--encoding=UTF8",
    "--auth=trust",
    `--username=${PG_ROLE}`,
  ]);
  if (code !== 0) throw new Error(`initdb failed: ${stderr.trim()}`);
}

/** A minimal SQL surface against a running cluster. `run` executes a statement
 *  on `database`; `exists` reports whether a query returns at least one row.
 *  The zonky binaries ship no `psql`, so this is backed by Bun's SQL client. */
export interface ClusterSql {
  run(database: string, statement: string): Promise<void>;
  exists(database: string, query: string): Promise<boolean>;
}

/** Create the hx-db database (if absent) and the hx schema (idempotent). */
export async function ensureDatabaseAndSchema(sql: ClusterSql): Promise<void> {
  const present = await sql.exists(
    "postgres",
    `SELECT 1 FROM pg_database WHERE datname = '${PG_DATABASE}'`,
  );
  if (!present) {
    await sql.run("postgres", `CREATE DATABASE "${PG_DATABASE}"`);
  }
  await sql.run(PG_DATABASE, `CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);
}
