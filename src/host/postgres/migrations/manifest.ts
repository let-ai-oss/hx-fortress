import type { Migration } from "../migrate";

// Migrations in apply order. Each entry imports a drizzle-kit-generated `.sql`
// file as embedded text (so it survives `bun build --compile` — the runtime
// never reads a migrations folder). The `name` matches the drizzle journal tag.
//
// Adding a migration: run `bunx drizzle-kit generate` (or `--custom` for
// extensions/views/roles), then append one import + one array entry here.
import sql0000Extensions from "./0000_extensions.sql" with { type: "text" };
import sql0001Dimensions from "./0001_dimensions.sql" with { type: "text" };

export const migrations: Migration[] = [
  { name: "0000_extensions", sql: sql0000Extensions },
  { name: "0001_dimensions", sql: sql0001Dimensions },
];
