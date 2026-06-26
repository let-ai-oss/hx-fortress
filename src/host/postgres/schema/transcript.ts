import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxModels } from "./dimensions";
import { hxSchema } from "./namespace";
import { hxSessionAgents, hxSessions } from "./sessions";

/** Postgres `tsvector` — no native Drizzle type, so a thin customType. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type HxTurnRole = "user" | "assistant" | "system";

// ── Unified transcript ──────────────────────────────────────────────────────
// One row per text-bearing turn, for BOTH the parent session (agent_id null)
// and every child lane (agent_id set). Structured tool calls live in
// hx_tool_calls, not here.

export const hxTurns = hxSchema.table(
  "turns",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    // Null = parent lane; set = a child (subagent/workflow) lane.
    agentId: uuid("agent_id").references(() => hxSessionAgents.id, { onDelete: "cascade" }),
    // Monotonic within the lane (session_id + agent_id).
    seq: integer("seq").notNull(),
    role: text("role").$type<HxTurnRole>().notNull(),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    eventTs: ts("event_ts"),
    text: text("text").notNull(),
    // Convenience copy of the source event; the durable vault blob is the real
    // rebuild source, so this is not load-bearing.
    rawEvent: jsonb("raw_event").$type<Record<string, unknown>>(),
    // Per-turn usage (nullable — populated on assistant turns).
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd"),
    textTsv: tsvector("text_tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${hxTurns.text})`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT so two parent-lane turns (agent_id null) can't share a seq.
    unique("hx_turns_lane_seq_unique").on(t.sessionId, t.agentId, t.seq).nullsNotDistinct(),
    index("hx_turns_tsv_idx").using("gin", t.textTsv),
    index("hx_turns_text_trgm_idx").using("gin", t.text.op("gin_trgm_ops")),
    index("hx_turns_session_seq_idx").on(t.sessionId, t.seq),
    index("hx_turns_role_idx").on(t.role),
    index("hx_turns_model_idx").on(t.modelId),
    index("hx_turns_event_ts_idx").on(t.eventTs),
  ],
);

// ── Structured tool calls ───────────────────────────────────────────────────
// tool_use/tool_result projected to columns (not generic turns) so the SQL
// agent gets clean tool-usage / failure-rate aggregations.

export const hxToolCalls = hxSchema.table(
  "tool_calls",
  {
    id: pk(),
    turnId: uuid("turn_id").references(() => hxTurns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => hxSessionAgents.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    isError: boolean("is_error").notNull().default(false),
    status: text("status"),
    eventTs: ts("event_ts"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("hx_tool_calls_natural_unique").on(t.sessionId, t.toolUseId),
    index("hx_tool_calls_session_tool_idx").on(t.sessionId, t.toolName),
    index("hx_tool_calls_tool_idx").on(t.toolName),
  ],
);

export type HxTurn = typeof hxTurns.$inferSelect;
export type HxToolCall = typeof hxToolCalls.$inferSelect;
