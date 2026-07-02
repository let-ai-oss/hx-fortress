// A4 · hx_session_search — CROSS-session keyword/substring search over the
// fortress's local `hx.turns` (text_tsv GIN + pg_trgm). The index is BROAD: it
// covers every text-bearing turn including tool_use/tool_result (logs/output/
// code), so a literal hits whether the user typed it or a tool emitted it. Each
// query INNER JOINs hx.sessions and applies the workbench-resolved scope on the
// live session row (§13-A6); never the denormalized turns.user_id.

import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import { scopePredicate, type FortressScope } from "./scope";

export interface SearchInput {
  scope: FortressScope;
  query: string;
  k?: number;
  family?: string;
  fromDate?: string;
  toDate?: string;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  kind: string | null;
  snippet: string;
  rank: number;
}

const DEFAULT_K = 20;
const MAX_K = 100;

export async function hxSessionSearch(db: HxDb, input: SearchInput): Promise<{ hits: SearchHit[] }> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { hits: [] };
  const k = Math.min(Math.max(1, input.k ?? DEFAULT_K), MAX_K);

  // Match the generated column's config (`to_tsvector('english', text)`).
  const tsq = sql`plainto_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank(${hxTurns.textTsv}, ${tsq})`;

  const conditions = [
    scopePredicate(input.scope),
    sql`${hxTurns.textTsv} @@ ${tsq}`,
    isNull(hxTurns.deletedAt),
  ];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  if (input.fromDate) conditions.push(gte(hxTurns.eventTs, input.fromDate));
  if (input.toDate) conditions.push(lte(hxTurns.eventTs, input.toDate));

  const rows = await db
    .select({
      sessionId: hxSessions.sessionId,
      seq: hxTurns.seq,
      kind: hxTurns.kind,
      rank,
      snippet: sql<string>`ts_headline('english', coalesce(${hxTurns.text}, ''), ${tsq}, 'MaxFragments=1,MaxWords=20,MinWords=5,ShortWord=2')`,
    })
    .from(hxTurns)
    .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
    .where(and(...conditions))
    .orderBy(desc(rank))
    .limit(k);

  return {
    hits: rows.map((r) => ({
      sessionId: r.sessionId,
      seq: r.seq,
      kind: r.kind,
      snippet: r.snippet,
      rank: Number(r.rank),
    })),
  };
}
