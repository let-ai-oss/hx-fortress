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
import sql0005Views from "./0005_views.sql" with { type: "text" };
import sql0006Embeddings from "./0006_embeddings.sql" with { type: "text" };
import sql0007TurnKind from "./0007_turn_kind.sql" with { type: "text" };
import sql0008SessionFacts from "./0008_session_facts.sql" with { type: "text" };
import sql0010EmbeddingsIndexes from "./0010_embeddings_indexes.sql" with { type: "text" };
import sql0011WidenTokens from "./0011_widen_session_tokens.sql" with { type: "text" };
import sql0012EmbedBudget from "./0012_embed_budget.sql" with { type: "text" };

export const migrations: Migration[] = [
  { name: "0000_extensions", sql: sql0000Extensions },
  { name: "0001_dimensions", sql: sql0001Dimensions },
  { name: "0002_sessions", sql: sql0002Sessions },
  { name: "0003_transcript", sql: sql0003Transcript },
  { name: "0004_analysis", sql: sql0004Analysis },
  { name: "0005_views", sql: sql0005Views },
  // Gated: applied only when pgvector is installable; skipped (and retried)
  // otherwise, so the core schema installs on the stock bundle.
  { name: "0006_embeddings", sql: sql0006Embeddings, requires: "vector" },
  // Net-new `kind` (10-value taxonomy) + `text` nullable for text-less kinds;
  // backfills `kind` from the existing 3-value `role`. NOT gated.
  { name: "0007_turn_kind", sql: sql0007TurnKind },
  // Net-new per-session productivity facts (§13-A4) — derived at ingest from the
  // session's turns/tool_calls; the live aggregate JOINs it to hx.sessions. NOT gated.
  { name: "0008_session_facts", sql: sql0008SessionFacts },
  // 0009 is intentionally absent: the spec slotted an "embed-job lease" table here, but
  // the impl uses one in-process worker (anti-join + ON CONFLICT unique-index fence, 0010) instead.
  // Gated (A7): content_hash btree + UNIQUE(owner_kind, owner_id) on the gated
  // hx.embeddings. Separate migration (never folded into 0006) so the append-
  // only runner applies it once pgvector is present and skips it otherwise.
  { name: "0010_embeddings_indexes", sql: sql0010EmbeddingsIndexes, requires: "vector" },
  { name: "0011_widen_session_tokens", sql: sql0011WidenTokens },
  // Net-new durable daily embed-token budget table (M-9e). NOT gated — the embed
  // worker reads/increments it to hold a per-day OpenAI spend ceiling.
  { name: "0012_embed_budget", sql: sql0012EmbedBudget },
];
