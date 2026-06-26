import { pgSchema } from "drizzle-orm/pg-core";

/** Every hx table is namespaced under the `hx` schema. */
export const hxSchema = pgSchema("hx");

// Group modules re-export their tables; index.ts aggregates them for the
// post-migration parity assertion (every Drizzle table must exist in the DB).
export * from "./dimensions";
export * from "./sessions";
export * from "./transcript";
export * from "./analysis";
