import { defineConfig } from "drizzle-kit";

// Dev-time only. The Drizzle schema is the source of truth; `drizzle-kit
// generate` emits the SQL migrations into `out` (and `--custom` for the bits
// it can't express: extensions, views, roles). At RUNTIME those `.sql` files
// are imported as embedded text and applied by src/host/postgres/migrate.ts —
// Drizzle's own fs-based migrator can't run inside the compiled binary, so the
// runtime never reads this config or the migrations folder from disk.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/host/postgres/schema/index.ts",
  out: "./src/host/postgres/migrations",
  schemaFilter: ["hx"],
});
