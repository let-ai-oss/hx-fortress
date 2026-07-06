import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RoleSecrets } from "./roles";
import type { Spawner } from "./spawn";

export const PG_ROLE = "fortress";
export const PG_DATABASE = "hx-db";
export const PG_SCHEMA = "hx";
/** SELECT-only login role for the MCP read tools — inherits the NOLOGIN
 *  `hx_readonly` role's grants (migration 0005). */
export const PG_APP_RO_ROLE = "hx_app_ro";
/** DML (no-DDL, no-superuser) login role for ingest + the embed worker. */
export const PG_APP_RW_ROLE = "hx_app_rw";
/** The NOLOGIN role migration 0005 grants schema-wide SELECT to; `hx_app_ro`
 *  is a member so its SELECT set tracks the read grants centrally. */
export const PG_READONLY_ROLE = "hx_readonly";

export interface ClusterDeps {
  spawner: Spawner;
  binDir: string;
  dataDir: string;
  /** Password for the `fortress` superuser, set at initdb time via --pwfile. */
  superPassword: string;
}

/** Escape a string literal for interpolation into a SQL statement (single-quote
 *  doubling). The role passwords are URL-safe hex, but escape defensively so a
 *  hand-edited roles.json can never break the ALTER ROLE. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Initialize the data directory if it has not been initialized yet.
 *
 * NEVER re-initializes an existing cluster: the `PG_VERSION` guard means a data
 * dir created by an older `--auth=trust` build is left intact (no data loss) and
 * converted in place later by `ensureAuth`. A fresh cluster is created with
 * scram-sha-256 for both local + host and the fortress superuser password seeded
 * from a 0600 temp pwfile (removed in `finally`).
 */
export async function ensureCluster(deps: ClusterDeps): Promise<void> {
  if (existsSync(path.join(deps.dataDir, "PG_VERSION"))) return;
  const pwDir = await mkdtemp(path.join(os.tmpdir(), "hx-pg-initpw-"));
  const pwFile = path.join(pwDir, "pw");
  try {
    await writeFile(pwFile, deps.superPassword, { mode: 0o600 });
    await chmod(pwFile, 0o600);
    const { code, stderr } = await deps.spawner.run([
      path.join(deps.binDir, "initdb"),
      "-D",
      deps.dataDir,
      "--encoding=UTF8",
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      `--username=${PG_ROLE}`,
      `--pwfile=${pwFile}`,
    ]);
    if (code !== 0) throw new Error(`initdb failed: ${stderr.trim()}`);
  } finally {
    await rm(pwDir, { recursive: true, force: true });
  }
}

/** A minimal SQL surface against a running cluster. `run` executes a statement
 *  on `database`; `exists` reports whether a query returns at least one row.
 *  The zonky binaries ship no `psql`, so this is backed by Bun's SQL client. */
export interface ClusterSql {
  run(database: string, statement: string): Promise<void>;
  exists(database: string, query: string): Promise<boolean>;
}

// The managed pg_hba.conf: loopback-only, scram-sha-256 for every role, and an
// explicit reject for any non-loopback address (defense-in-depth — the server
// also binds 127.0.0.1 only). Rewritten idempotently on every boot; the first
// hardened boot over an --auth=trust cluster is what converts it in place.
const MANAGED_PG_HBA = [
  "# Managed by hx-fortress — do not edit; rewritten idempotently on every boot.",
  "# Loopback-only + scram-sha-256 for all roles (de-superuser least-privilege).",
  "local   all   all                   scram-sha-256",
  "host    all   all   127.0.0.1/32    scram-sha-256",
  "host    all   all   ::1/128         scram-sha-256",
  "host    all   all   0.0.0.0/0       reject",
  "host    all   all   ::/0            reject",
  "",
].join("\n");

/**
 * Idempotent in-place auth hardening, run AFTER `startServer` and BEFORE
 * `ensureDbSchema`. Converts an existing `--auth=trust` cluster to scram with
 * ZERO re-init:
 *
 *   1. `ALTER ROLE fortress WITH PASSWORD …` — lands even on a still-trust
 *      cluster (the password is ignored at connect time under trust) and is a
 *      harmless re-set once scram is already in force. MUST precede the HBA
 *      rewrite so the next scram connection can authenticate.
 *   2. Overwrite `pg_hba.conf` with the managed loopback-only scram ruleset.
 *   3. Reload so the new HBA takes effect.
 *
 * A crash between (2) and (3) self-heals: both steps are idempotent and re-run
 * on the next boot, and every DSN carries the super password so a connection
 * succeeds whether the running HBA is still trust or already scram.
 */
export async function ensureAuth(
  sql: ClusterSql,
  dataDir: string,
  secrets: RoleSecrets,
  reload: () => Promise<void>,
): Promise<void> {
  // Use the always-present `postgres` database: hx-db may not exist yet (this
  // runs before ensureDbSchema), and ALTER ROLE is cluster-global regardless.
  await sql.run("postgres", `ALTER ROLE ${PG_ROLE} WITH PASSWORD ${quoteLiteral(secrets.super)}`);
  await writeFile(path.join(dataDir, "pg_hba.conf"), MANAGED_PG_HBA, { mode: 0o600 });
  await reload();
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

/**
 * Idempotently provision the two least-privilege login roles, run AFTER
 * `migrate` (so the blanket schema grants cover every table this boot created):
 *
 *   • hx_app_ro — LOGIN, member of hx_readonly (inherits its schema-wide SELECT
 *     from migration 0005). No direct table grants of its own.
 *   • hx_app_rw — LOGIN with USAGE on schema hx + SELECT/INSERT/UPDATE/DELETE on
 *     all current tables + USAGE on all sequences, plus matching ALTER DEFAULT
 *     PRIVILEGES so future migration tables/sequences are covered too. No DDL,
 *     no superuser.
 *
 * Passwords are (re)set every boot from the persisted secrets, and the blanket
 * grants re-run every boot, so a table added by a later migration is covered
 * the first time it boots under this code.
 */
export async function ensureAppRoles(sql: ClusterSql, secrets: RoleSecrets): Promise<void> {
  // hx_app_ro — SELECT only, via membership of hx_readonly.
  const roExists = await sql.exists(
    "postgres",
    `SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_RO_ROLE}'`,
  );
  if (!roExists) {
    await sql.run(PG_DATABASE, `CREATE ROLE ${PG_APP_RO_ROLE} LOGIN IN ROLE ${PG_READONLY_ROLE}`);
  }
  await sql.run(PG_DATABASE, `ALTER ROLE ${PG_APP_RO_ROLE} WITH PASSWORD ${quoteLiteral(secrets.appRo)}`);
  // Ensure membership even if the role pre-existed without it (idempotent).
  await sql.run(PG_DATABASE, `GRANT ${PG_READONLY_ROLE} TO ${PG_APP_RO_ROLE}`);

  // hx_app_rw — schema DML, no DDL.
  const rwExists = await sql.exists(
    "postgres",
    `SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_RW_ROLE}'`,
  );
  if (!rwExists) {
    await sql.run(PG_DATABASE, `CREATE ROLE ${PG_APP_RW_ROLE} LOGIN`);
  }
  await sql.run(PG_DATABASE, `ALTER ROLE ${PG_APP_RW_ROLE} WITH PASSWORD ${quoteLiteral(secrets.appRw)}`);
  await sql.run(PG_DATABASE, `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`);
  await sql.run(
    PG_DATABASE,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`,
  );
  await sql.run(PG_DATABASE, `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`);
  // Future tables/sequences created by later migrations (which run as fortress)
  // inherit the same grants.
  await sql.run(
    PG_DATABASE,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PG_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PG_APP_RW_ROLE}`,
  );
  await sql.run(
    PG_DATABASE,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PG_SCHEMA} GRANT USAGE ON SEQUENCES TO ${PG_APP_RW_ROLE}`,
  );
}
