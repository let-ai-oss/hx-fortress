// A4 · hx_sessions_list — scoped session metadata, keyset-paged on
// last_activity_at (descending), matching §13-C (not numeric offset). Filters:
// family, date range (last_activity_at), cwd substring, free-text search across
// title/last_user_text/last_assistant_text. Scope applied on the live row (A6).

import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions } from "../host/postgres/schema";
import { scopePredicate, type FortressScope } from "./scope";

// Curated metadata projection shared by list + get (a superset that excludes the
// heavy per-turn detail, which lives in hx.turns).
export const SESSION_META_SELECT = {
  sessionId: hxSessions.sessionId,
  family: hxSessions.family,
  title: hxSessions.title,
  titleSource: hxSessions.titleSource,
  cwd: hxSessions.cwd,
  gitBranch: hxSessions.gitBranch,
  sourcePath: hxSessions.sourcePath,
  eventCount: hxSessions.eventCount,
  userTextCount: hxSessions.userTextCount,
  assistantCount: hxSessions.assistantCount,
  toolCallCount: hxSessions.toolCallCount,
  inputTokens: hxSessions.inputTokens,
  outputTokens: hxSessions.outputTokens,
  cacheReadTokens: hxSessions.cacheReadTokens,
  cacheCreationTokens: hxSessions.cacheCreationTokens,
  estCostUsd: hxSessions.estCostUsd,
  bytesUploaded: hxSessions.bytesUploaded,
  lastUserText: hxSessions.lastUserText,
  lastAssistantText: hxSessions.lastAssistantText,
  firstEventAt: hxSessions.firstEventAt,
  lastActivityAt: hxSessions.lastActivityAt,
  id: hxSessions.id,
} as const;

export type SessionMeta = Pick<typeof hxSessions.$inferSelect, keyof typeof SESSION_META_SELECT>;

export interface ListSessionsInput {
  scope: FortressScope;
  family?: string;
  fromDate?: string;
  toDate?: string;
  cwdContains?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface Cursor {
  ts: string;
  id: string;
}

function encodeCursor(lastActivityAt: string | null, id: string): string {
  return Buffer.from(`${lastActivityAt ?? ""}|${id}`).toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    const id = decoded.slice(idx + 1);
    if (!id) return null;
    return { ts: decoded.slice(0, idx), id };
  } catch {
    return null;
  }
}

export async function hxSessionsList(
  db: HxDb,
  input: ListSessionsInput,
): Promise<{ sessions: SessionMeta[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const conditions: SQL[] = [scopePredicate(input.scope)];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  if (input.fromDate) conditions.push(gte(hxSessions.lastActivityAt, input.fromDate));
  if (input.toDate) conditions.push(lte(hxSessions.lastActivityAt, input.toDate));
  if (input.cwdContains) conditions.push(ilike(hxSessions.cwd, `%${input.cwdContains}%`));
  if (input.search) {
    const s = `%${input.search}%`;
    const clause = or(
      ilike(hxSessions.title, s),
      ilike(hxSessions.lastUserText, s),
      ilike(hxSessions.lastAssistantText, s),
    );
    if (clause) conditions.push(clause);
  }

  // Keyset on (last_activity_at DESC NULLS LAST, id DESC).
  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (cur) {
      conditions.push(
        cur.ts
          ? sql`(${hxSessions.lastActivityAt} < ${cur.ts} OR (${hxSessions.lastActivityAt} = ${cur.ts} AND ${hxSessions.id} < ${cur.id}))`
          : sql`(${hxSessions.lastActivityAt} IS NULL AND ${hxSessions.id} < ${cur.id})`,
      );
    }
  }

  const rows = await db
    .select(SESSION_META_SELECT)
    .from(hxSessions)
    .where(and(...conditions))
    .orderBy(sql`${hxSessions.lastActivityAt} DESC NULLS LAST`, desc(hxSessions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.lastActivityAt, last.id) : undefined;

  return nextCursor ? { sessions: page, nextCursor } : { sessions: page };
}
