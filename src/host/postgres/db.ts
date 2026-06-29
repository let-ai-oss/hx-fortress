import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

// A Drizzle handle over Bun.SQL for the bundled hx-db. The gateway ingestion
// path uses this for typed queries/transactions; the migration runner keeps its
// own raw Bun.SQL exec (simple-query mode) and is unaffected.
export type HxDb = BunSQLDatabase<typeof schema>;

/** The transaction handle drizzle hands to `db.transaction(tx => …)`. Helpers
 *  that run inside a commit accept this so they enlist in the same tx. */
export type HxTx = Parameters<Parameters<HxDb["transaction"]>[0]>[0];

export function createHxDb(dsn: string): HxDb {
  return drizzle(new Bun.SQL(dsn), { schema });
}
