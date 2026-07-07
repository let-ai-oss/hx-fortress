/** Minimal SQL surface the migrator needs against the hx-db connection. `query`
 *  takes optional bound `params` ($1, $2, …) for defense-in-depth; `exec` runs a
 *  (possibly multi-statement) simple-query batch as one implicit transaction. */
export interface MigrationExec {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Migration {
  name: string;
  sql: string;
  /** Gate the migration on a Postgres extension being installable. When the
   *  extension is unavailable the migration is skipped (NOT recorded), so it
   *  retries on a later boot once the binary is packaged. */
  requires?: "vector";
}

async function extensionAvailable(db: MigrationExec, ext: string): Promise<boolean> {
  // Bound param (defense-in-depth) — `ext` is a validated union today, but the
  // standalone SELECT parameterizes cleanly.
  const rows = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = $1`,
    [ext],
  );
  return (rows[0]?.n ?? 0) > 0;
}

const TRACKING_DDL = `
  CREATE SCHEMA IF NOT EXISTS hx;
  CREATE TABLE IF NOT EXISTS hx.schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );`;

/** Apply every migration not yet recorded, in array order. Each migration's
 *  SQL is wrapped in a transaction; its name is recorded on success. Returns
 *  the names actually applied this run. */
export async function runMigrations(db: MigrationExec, migrations: Migration[]): Promise<string[]> {
  await db.exec(TRACKING_DDL);
  const rows = await db.query<{ name: string }>("SELECT name FROM hx.schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];
  for (const migration of migrations) {
    // Names are interpolated into the tracking INSERT below; constrain them to
    // the journal-tag charset so a manifest entry can never inject SQL.
    if (!/^[0-9a-z_]+$/.test(migration.name)) {
      throw new Error(`invalid migration name: ${migration.name}`);
    }
    if (applied.has(migration.name)) continue;
    if (migration.requires && !(await extensionAvailable(db, migration.requires))) {
      // Extension not packaged yet — skip without recording so a later boot
      // (once it ships) applies this migration.
      continue;
    }
    // A multi-statement simple-query batch runs as one implicit transaction in
    // Postgres (no explicit BEGIN/COMMIT — Bun.SQL rejects those on a pooled
    // connection). So the migration and its tracking row commit or roll back
    // together. Every statement we emit is transaction-safe (no CREATE INDEX
    // CONCURRENTLY / CREATE DATABASE / VACUUM). The name stays INLINE (not a bound
    // param) deliberately: a bound INSERT needs the extended protocol, which can't
    // share the simple-query batch — splitting it into its own statement would break
    // the atomic migrate+journal transaction (crash-safety). It is injection-proof
    // via the `/^[0-9a-z_]+$/` gate above (a code-controlled manifest key, no quote).
    await db.exec(
      `${migration.sql}\nINSERT INTO hx.schema_migrations (name) VALUES ('${migration.name}');`,
    );
    ran.push(migration.name);
  }
  return ran;
}
