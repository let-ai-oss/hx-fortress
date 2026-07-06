import type { MigrationExec } from "./migrate";

/** A MigrationExec backed by Bun.SQL over a DSN. `exec` uses simple-query mode
 *  so a multi-statement migration batch runs as one implicit transaction. */
export function makeMigrationExec(dsn: string): MigrationExec {
  return {
    async exec(statement) {
      const client = new Bun.SQL(dsn);
      try {
        await client.unsafe(statement).simple();
      } finally {
        await client.end();
      }
    },
    async query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]> {
      const client = new Bun.SQL(dsn);
      try {
        // `unsafe(sql, params)` uses the extended protocol so `$1…` bind safely;
        // no params ⇒ the plain simple-query path (unchanged behavior).
        const rows = params ? await client.unsafe(statement, params) : await client.unsafe(statement);
        return rows as T[];
      } finally {
        await client.end();
      }
    },
  };
}
