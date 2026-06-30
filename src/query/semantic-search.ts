// A4 · hx_semantic_search — SEMANTIC (vector) search over the in-scope sessions'
// conversational turns. The query TEXT is embedded INSIDE the fortress (it holds
// the OpenAI key — workbench never needs it), then an HNSW cosine scan (`<=>`)
// over hx.embeddings is JOINed embeddings → turns → the live session row, with
// the workbench-resolved scope applied on the SESSION (§13-A6; embeddings carry
// no user id, so scope is never evaluated on the vector row). Candidates are
// over-fetched (k×N) and re-ranked because the HNSW post-filters the scope WHERE.
//
// DEGRADE-TO-KEYWORD: when pgvector is absent (`to_regtype('vector') IS NULL`, or
// 0006 unapplied so hx.embeddings doesn't exist), or no embedder is configured,
// or the query embed fails, it falls back to hx_session_search over the same
// scope and returns those hits with `degraded:"keyword"` — never an empty or
// misleading result.

import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import { hxEmbeddings } from "../host/postgres/schema/embeddings";
import type { Embedder } from "../modules/embed-worker/openai";
import { hxSessionSearch } from "./search";
import { scopePredicate, type FortressScope } from "./scope";

export interface SemanticSearchInput {
  scope: FortressScope;
  queryText: string;
  k?: number;
  family?: string;
  fromDate?: string;
  toDate?: string;
}

export interface SemanticHit {
  sessionId: string;
  seq: number;
  kind: string | null;
  snippet: string;
  /** Cosine distance (lower = nearer); null on a keyword-degraded hit. */
  distance: number | null;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  /** Present only when the request fell back to keyword search. */
  degraded?: "keyword";
  reason?: string;
}

const DEFAULT_K = 20;
const MAX_K = 100;
// Over-fetch factor: the HNSW filters scope AFTER the distance scan, so pull more
// candidates than k and truncate post-filter to avoid starving a small scope.
const OVERFETCH = 5;
const SNIPPET_CHARS = 240;

function snippetOf(text: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

/** Normalize drizzle's `execute` result to a row array across driver shapes. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe?.rows) ? (maybe.rows as T[]) : [];
}

async function vectorAvailable(db: HxDb): Promise<boolean> {
  try {
    const res = await db.execute(sql`SELECT to_regtype('vector') IS NOT NULL AS ok`);
    return rowsOf<{ ok: boolean }>(res)[0]?.ok === true;
  } catch {
    return false;
  }
}

async function degradeToKeyword(
  db: HxDb,
  input: SemanticSearchInput,
  reason: string,
): Promise<SemanticSearchResult> {
  const kw = await hxSessionSearch(db, {
    scope: input.scope,
    query: input.queryText,
    k: input.k,
    family: input.family,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });
  return {
    hits: kw.hits.map((h) => ({
      sessionId: h.sessionId,
      seq: h.seq,
      kind: h.kind,
      snippet: h.snippet,
      distance: null,
    })),
    degraded: "keyword",
    reason,
  };
}

export async function hxSemanticSearch(
  db: HxDb,
  embedder: Embedder | null,
  input: SemanticSearchInput,
): Promise<SemanticSearchResult> {
  const queryText = typeof input.queryText === "string" ? input.queryText.trim() : "";
  if (!queryText) return { hits: [] };
  if (!embedder) return degradeToKeyword(db, input, "embedder_unavailable");
  if (!(await vectorAvailable(db))) return degradeToKeyword(db, input, "vector_extension_absent");

  const k = Math.min(Math.max(1, input.k ?? DEFAULT_K), MAX_K);

  // The embedder may dead-letter an un-embeddable input as a null vector
  // (per-input poison-pill handling), so a null/empty query vector degrades to
  // keyword exactly like an embed throw.
  let queryVec: number[] | null | undefined;
  try {
    [queryVec] = await embedder.embed([queryText]);
  } catch {
    return degradeToKeyword(db, input, "query_embed_failed");
  }
  if (!queryVec || queryVec.length === 0) return degradeToKeyword(db, input, "query_embed_failed");
  const literal = `[${queryVec.join(",")}]`;

  const distance = sql<number>`${hxEmbeddings.embedding} <=> ${literal}::vector`;

  const conditions = [
    scopePredicate(input.scope),
    eq(hxEmbeddings.ownerKind, "turn"),
    isNull(hxTurns.deletedAt),
  ];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  if (input.fromDate) conditions.push(gte(hxTurns.eventTs, input.fromDate));
  if (input.toDate) conditions.push(lte(hxTurns.eventTs, input.toDate));

  try {
    // Selective-scope recall: the HNSW index applies the scope WHERE only AFTER
    // its approximate distance scan, so on a narrow scope pgvector's default
    // hnsw.ef_search (40) can surface fewer than k in-scope rows — or none.
    // Raise the candidate pool and, on pgvector ≥ 0.8, let iterative scan keep
    // probing until k post-filter rows are found. Both are SET LOCAL inside one
    // transaction so they scope to THIS query alone and never leak to other
    // pooled queries; k×OVERFETCH stays as a backstop cap.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 200`);
      // hnsw.iterative_scan exists only on pgvector ≥ 0.8; on older builds it is
      // an unknown GUC that errors. Isolate the SET in a savepoint so that error
      // rolls back only the savepoint and never poisons the outer transaction.
      try {
        await tx.transaction(async (inner) => {
          await inner.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
        });
      } catch {
        // pgvector < 0.8 — no iterative scan; ef_search + OVERFETCH carry recall.
      }
      return tx
        .select({
          sessionId: hxSessions.sessionId,
          seq: hxTurns.seq,
          kind: hxTurns.kind,
          text: hxTurns.text,
          distance,
        })
        .from(hxEmbeddings)
        .innerJoin(hxTurns, eq(hxTurns.id, hxEmbeddings.ownerId))
        .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
        .where(and(...conditions))
        .orderBy(distance)
        .limit(k * OVERFETCH);
    });

    const hits = rows.slice(0, k).map((r) => ({
      sessionId: r.sessionId,
      seq: r.seq,
      kind: r.kind,
      snippet: snippetOf(r.text),
      distance: Number(r.distance),
    }));
    return { hits };
  } catch {
    // hx.embeddings missing (0006 unapplied) or any vector fault → keyword.
    return degradeToKeyword(db, input, "semantic_query_failed");
  }
}
