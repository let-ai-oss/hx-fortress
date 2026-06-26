/** Minimal SQL surface the migrator needs against the hx-db connection. */
export interface MigrationExec {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Migration {
  name: string;
  sql: string;
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
    if (applied.has(migration.name)) continue;
    await db.exec(
      `BEGIN;\n${migration.sql}\nINSERT INTO hx.schema_migrations (name) VALUES ('${migration.name}');\nCOMMIT;`,
    );
    ran.push(migration.name);
  }
  return ran;
}
