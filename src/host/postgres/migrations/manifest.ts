import type { Migration } from "../migrate";

import sql0000 from "./0000_extensions.sql" with { type: "text" };

// Ordered list. Append one import + one entry per new migration. The runner
// applies these in array order and records each name in hx.schema_migrations.
export const migrations: Migration[] = [{ name: "0000_extensions", sql: sql0000 }];
