// A4 · hx_sessions_aggregate — productivity metrics over the in-scope sessions,
// computed LIVE from `hx.session_facts JOIN hx.sessions` (§10 — one source, one
// bucketing). The per-session facts rows are derived at ingest (§13-A4); this
// reads them live, scoped by the workbench-resolved identities (A6) + the live
// `hx.sessions.deleted_at IS NULL` row — the fortress evaluates no org/repo
// predicate of its own. A live JOIN (not a baked rollup), so a re-attributed or
// soft-deleted session is correct on every call. Fail-closed: an empty scope ⇒
// `scopePredicate` is `false` ⇒ zeros.

import { and, eq, gte, ilike, isNull, lte, sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxUsers } from "../host/postgres/schema";
import { hxSessionFacts } from "../host/postgres/schema/facts";
import { scopePredicate, type FortressScope } from "./scope";

export interface AggregateInput {
  scope: FortressScope;
  family?: string;
  /** ISO date lower bound on the session's primary day (the §10 bucket). */
  fromDate?: string;
  /** ISO date upper bound on the session's primary day. */
  toDate?: string;
  cwdContains?: string;
  /** When "user", also return per-owner subtotals in `groups` (team/org boards). */
  groupBy?: "user";
}

export interface AggregateResult {
  totalSessions: number;
  activeMs: number;
  userMsgs: number;
  assistantMsgs: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  toolCallsByType: Record<string, number>;
  /** Primary-day span of the matched sessions (null when the scope is empty). */
  firstDay: string | null;
  lastDay: string | null;
  /** Per-owner subtotals, present only when groupBy:"user". key = userExternalId. */
  groups?: AggregateGroup[];
}

export interface AggregateGroup {
  key: string;
  totalSessions: number;
  activeMs: number;
  userMsgs: number;
  assistantMsgs: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Coerce a Postgres aggregate scalar (number | bigint | numeric-as-string) to a
 *  finite number; non-finite ⇒ 0. */
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export async function hxSessionsAggregate(db: HxDb, input: AggregateInput): Promise<AggregateResult> {
  const conditions: SQL[] = [scopePredicate(input.scope), isNull(hxSessions.deletedAt)];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  // The §10 day bucket is the facts row's primary_day, not the session activity window.
  if (input.fromDate) conditions.push(gte(hxSessionFacts.primaryDay, input.fromDate));
  if (input.toDate) conditions.push(lte(hxSessionFacts.primaryDay, input.toDate));
  if (input.cwdContains) conditions.push(ilike(hxSessions.cwd, `%${input.cwdContains}%`));
  const where = and(...conditions);

  // Scalar sums in SQL (one row even when nothing matches — count 0, sums coalesced).
  const [agg] = await db
    .select({
      totalSessions: sql<number>`count(*)::int`,
      activeMs: sql<string>`coalesce(sum(${hxSessionFacts.activeMs}), 0)::bigint`,
      userMsgs: sql<number>`coalesce(sum(${hxSessionFacts.userMsgs}), 0)::int`,
      assistantMsgs: sql<number>`coalesce(sum(${hxSessionFacts.assistantMsgs}), 0)::int`,
      filesTouched: sql<number>`coalesce(sum(${hxSessionFacts.filesTouched}), 0)::int`,
      linesAdded: sql<number>`coalesce(sum(${hxSessionFacts.linesAdded}), 0)::int`,
      linesRemoved: sql<number>`coalesce(sum(${hxSessionFacts.linesRemoved}), 0)::int`,
      firstDay: sql<string | null>`to_char(min(${hxSessionFacts.primaryDay}), 'YYYY-MM-DD')`,
      lastDay: sql<string | null>`to_char(max(${hxSessionFacts.primaryDay}), 'YYYY-MM-DD')`,
    })
    .from(hxSessionFacts)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
    .where(where);

  // tool_calls_by_type is a jsonb map per session — merge the maps over the SAME
  // scope (facts rows are per-session, far below a turn scan, per §10).
  const typeRows = await db
    .select({ toolCallsByType: hxSessionFacts.toolCallsByType })
    .from(hxSessionFacts)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
    .where(where);

  const toolCallsByType: Record<string, number> = {};
  for (const r of typeRows) {
    for (const [name, count] of Object.entries(r.toolCallsByType ?? {})) {
      toolCallsByType[name] = (toolCallsByType[name] ?? 0) + num(count);
    }
  }

  // Per-owner subtotals (team/org boards: "how is work spread", "is anyone
  // working too much"). Same scope + filters; GROUP BY the session owner's
  // external id so the caller can attribute load per member. Ordered busiest-first.
  let groups: AggregateGroup[] | undefined;
  if (input.groupBy === "user") {
    const grpRows = await db
      .select({
        key: hxUsers.externalId,
        totalSessions: sql<number>`count(*)::int`,
        activeMs: sql<string>`coalesce(sum(${hxSessionFacts.activeMs}), 0)::bigint`,
        userMsgs: sql<number>`coalesce(sum(${hxSessionFacts.userMsgs}), 0)::int`,
        assistantMsgs: sql<number>`coalesce(sum(${hxSessionFacts.assistantMsgs}), 0)::int`,
        filesTouched: sql<number>`coalesce(sum(${hxSessionFacts.filesTouched}), 0)::int`,
        linesAdded: sql<number>`coalesce(sum(${hxSessionFacts.linesAdded}), 0)::int`,
        linesRemoved: sql<number>`coalesce(sum(${hxSessionFacts.linesRemoved}), 0)::int`,
      })
      .from(hxSessionFacts)
      .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(where)
      .groupBy(hxUsers.externalId)
      .orderBy(sql`count(*) DESC`);
    groups = grpRows.map((g) => ({
      key: g.key,
      totalSessions: num(g.totalSessions),
      activeMs: num(g.activeMs),
      userMsgs: num(g.userMsgs),
      assistantMsgs: num(g.assistantMsgs),
      filesTouched: num(g.filesTouched),
      linesAdded: num(g.linesAdded),
      linesRemoved: num(g.linesRemoved),
    }));
  }

  return {
    totalSessions: num(agg?.totalSessions),
    activeMs: num(agg?.activeMs),
    userMsgs: num(agg?.userMsgs),
    assistantMsgs: num(agg?.assistantMsgs),
    filesTouched: num(agg?.filesTouched),
    linesAdded: num(agg?.linesAdded),
    linesRemoved: num(agg?.linesRemoved),
    toolCallsByType,
    firstDay: agg?.firstDay ?? null,
    lastDay: agg?.lastDay ?? null,
    ...(groups ? { groups } : {}),
  };
}
