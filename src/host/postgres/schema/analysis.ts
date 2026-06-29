import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bigCounter, counter, createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxModels, hxProjects, hxUsers } from "./dimensions";
import { hxSchema } from "./namespace";
import { hxSessions } from "./sessions";

export type HxIngestEventStatus = "pending" | "processed" | "failed" | "ignored";
export type HxAnalysisKind = "script" | "agent";
export type HxAnalysisRunStatus = "running" | "complete" | "failed";

// ── Ingest events — audit + trigger spine ───────────────────────────────────

export const hxIngestEvents = hxSchema.table(
  "ingest_events",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    sessionId: uuid("session_id").references(() => hxSessions.id, { onDelete: "set null" }),
    family: text("family"),
    // The client-side session id string (distinct from the FK above).
    sessionIdExt: text("session_id_ext"),
    chunkId: text("chunk_id"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<HxIngestEventStatus>().notNull().default("pending"),
    error: text("error"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("hx_ingest_events_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index("hx_ingest_events_user_created_idx").on(t.userId, t.createdAt),
    index("hx_ingest_events_status_created_idx").on(t.status, t.createdAt),
    index("hx_ingest_events_session_created_idx").on(t.sessionId, t.createdAt),
  ],
);

// ── Analysis definitions / runs / facts ─────────────────────────────────────

export const hxAnalysisDefinitions = hxSchema.table(
  "analysis_definitions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HxAnalysisKind>().notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    description: text("description"),
    inputSchema: jsonb("input_schema").notNull(),
    outputSchema: jsonb("output_schema").notNull(),
    projection: jsonb("projection").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("hx_analysis_definitions_user_kind_idx").on(t.userId, t.kind)],
);

export const hxAnalysisRuns = hxSchema.table(
  "analysis_runs",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").references(() => hxAnalysisDefinitions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<HxAnalysisKind>().notNull(),
    status: text("status").$type<HxAnalysisRunStatus>().notNull(),
    sourceScope: jsonb("source_scope").notNull(),
    parameters: jsonb("parameters").notNull(),
    output: jsonb("output"),
    outputSummary: text("output_summary"),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    usage: jsonb("usage"),
    error: text("error"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("hx_analysis_runs_user_status_idx").on(t.userId, t.status),
    index("hx_analysis_runs_user_started_idx").on(t.userId, t.startedAt),
  ],
);

// Junction: which sessions fed a run (replaces a jsonb id array → real FKs).
export const hxAnalysisRunSessions = hxSchema.table(
  "analysis_run_sessions",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => hxAnalysisRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.sessionId] }),
    index("hx_analysis_run_sessions_session_idx").on(t.sessionId),
  ],
);

export const hxAnalysisFacts = hxSchema.table(
  "analysis_facts",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => hxAnalysisRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => hxSessions.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    valueText: text("value_text"),
    valueNumber: doublePrecision("value_number"),
    valueBool: boolean("value_bool"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("hx_analysis_facts_user_key_idx").on(t.userId, t.key),
    index("hx_analysis_facts_run_idx").on(t.runId),
    index("hx_analysis_facts_session_idx").on(t.sessionId),
  ],
);

// ── Usage rollup — day × user × project × model, for cheap trend dashboards ──

export const hxUsageRollup = hxSchema.table(
  "usage_rollup",
  {
    id: pk(),
    bucketDate: date("bucket_date", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => hxProjects.id, { onDelete: "set null" }),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    sessionCount: counter("session_count"),
    turnCount: counter("turn_count"),
    inputTokens: bigCounter("input_tokens"),
    outputTokens: bigCounter("output_tokens"),
    cacheReadTokens: bigCounter("cache_read_tokens"),
    cacheCreationTokens: bigCounter("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("hx_usage_rollup_grain_unique")
      .on(t.bucketDate, t.userId, t.projectId, t.modelId)
      .nullsNotDistinct(),
  ],
);

export type HxIngestEvent = typeof hxIngestEvents.$inferSelect;
export type HxAnalysisDefinition = typeof hxAnalysisDefinitions.$inferSelect;
export type HxAnalysisRun = typeof hxAnalysisRuns.$inferSelect;
export type HxAnalysisFact = typeof hxAnalysisFacts.$inferSelect;
export type HxUsageRollup = typeof hxUsageRollup.$inferSelect;
