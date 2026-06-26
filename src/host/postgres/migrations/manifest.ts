import type { Migration } from "../migrate";

// Migrations in apply order. Each entry imports a drizzle-kit-generated `.sql`
// file as embedded text (so it survives `bun build --compile` — the runtime
// never reads a migrations folder). The `name` matches the drizzle journal tag.
//
// Adding a migration: run `bunx drizzle-kit generate` (or `--custom` for
// extensions/views/roles), then append one import + one array entry here.
import sql0000Extensions from "./0000_extensions.sql" with { type: "text" };
import sql0001Dimensions from "./0001_dimensions.sql" with { type: "text" };
import sql0002Sessions from "./0002_sessions.sql" with { type: "text" };
import sql0003Transcript from "./0003_transcript.sql" with { type: "text" };
import sql0004Analysis from "./0004_analysis.sql" with { type: "text" };

export const migrations: Migration[] = [
  { name: "0000_extensions", sql: sql0000Extensions },
  { name: "0001_dimensions", sql: sql0001Dimensions },
  { name: "0002_sessions", sql: sql0002Sessions },
  { name: "0003_transcript", sql: sql0003Transcript },
  { name: "0004_analysis", sql: sql0004Analysis },
];
