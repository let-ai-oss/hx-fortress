import { defineConfig } from "drizzle-kit";

// Dev-time only: drizzle-kit is used for `check`/`introspect`, NOT for runtime
// migration generation (migrations are hand-authored SQL, applied by
// src/host/postgres/migrate.ts). Runtime never reads this file.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/host/postgres/schema/index.ts",
  out: "./src/host/postgres/migrations",
  schemaFilter: ["hx"],
});
