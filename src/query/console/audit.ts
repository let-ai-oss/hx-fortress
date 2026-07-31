// The audit trail and the command queue, as the console reads them.
//
// Both are READS in the strict sense — the panel that renders them writes
// nothing, and neither endpoint is spool-logged. That is deliberate and it is
// not an oversight: a self-auditing panel on a poll would grow a table that has
// no DELETE anywhere in the system, so the trail's own size would become a
// function of how often somebody looked at it. What IS audited is the EXPORT,
// because an export is the only way a full-range copy of the trail leaves the
// box, and a trail that cannot say which copy left is not a trail.
//
// Range and filter are enforced HERE, in the statement, never trimmed after the
// rows come back. A server that fetches everything and then slices has already
// paid the cost the bound exists to prevent.

import { sql, type SQL } from "drizzle-orm";

export interface AuditRange {
  /** ISO instants. Both required for an export; optional for a bounded page. */
  from?: string;
  to?: string;
  /** Exact match on the recorded action, e.g. "console.rotate_credentials". */
  action?: string;
  actor?: string;
  /** Matched exactly, whatever it is. Not narrowed to the three origins the
   *  writer uses today: a filter that silently drops an origin a later build
   *  adds would show an operator a trail with rows missing and no sign of it. */
  origin?: string;
  limit?: number;
  cursor?: string;
}

export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 500;
/** The ceiling on one export. A range wide enough to exceed it is answered with
 *  a named refusal naming the narrower range, never with a silent truncation —
 *  a short export that looks complete is worse than no export. */
export const AUDIT_EXPORT_MAX = 10_000;

export interface AuditRow {
  id: string;
  ts: string;
  origin: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  params: unknown;
  kind: string;
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
  spoolFileId: string;
  seq: number;
}

const AUDIT_PROJECTION = sql`
  a.id AS "id",
  a.ts AS "ts",
  a.origin AS "origin",
  a.actor AS "actor",
  a.session_ref AS "sessionRef",
  a.tier AS "tier",
  a.action AS "action",
  a.params AS "params",
  a.kind AS "kind",
  a.ref_seq AS "refSeq",
  a.outcome AS "outcome",
  a.error AS "error",
  a.spool_file_id AS "spoolFileId",
  a.seq AS "seq"`;

function auditFilters(range: AuditRange): SQL[] {
  const out: SQL[] = [];
  if (range.from) out.push(sql`a.ts >= ${range.from}::timestamptz`);
  if (range.to) out.push(sql`a.ts <= ${range.to}::timestamptz`);
  if (range.action) out.push(sql`a.action = ${range.action}`);
  if (range.actor) out.push(sql`a.actor = ${range.actor}`);
  if (range.origin) out.push(sql`a.origin = ${range.origin}`);
  return out;
}

function where(parts: SQL[]): SQL {
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

export function auditPageLimit(requested: number | undefined): number {
  const n = Number(requested);
  if (!Number.isFinite(n)) return AUDIT_PAGE_DEFAULT;
  return Math.min(Math.max(1, Math.trunc(n)), AUDIT_PAGE_MAX);
}

/** A bounded page for the panel. Keyset on (ts, id) so a trail that grows while
 *  somebody is paging does not shift rows under them. */
export function auditPageQuery(range: AuditRange): SQL {
  const parts = auditFilters(range);
  if (range.cursor) {
    const decoded = decodeAuditCursor(range.cursor);
    if (decoded) {
      parts.push(
        sql`(a.ts < ${decoded.ts}::timestamptz OR (a.ts = ${decoded.ts}::timestamptz AND a.id < ${decoded.id}::uuid))`,
      );
    }
  }
  const limit = auditPageLimit(range.limit);
  return sql`SELECT ${AUDIT_PROJECTION} FROM hx.admin_audit a WHERE ${where(parts)}
    ORDER BY a.ts DESC, a.id DESC LIMIT ${limit + 1}`;
}

/** The export. Same filters, a hard ceiling, and no cursor: an export is one
 *  answer to one question, and paging it would let a caller assemble a
 *  full-range dump out of bounded reads that were never recorded as exports. */
export function auditExportQuery(range: AuditRange): SQL {
  const parts = auditFilters(range);
  return sql`SELECT ${AUDIT_PROJECTION} FROM hx.admin_audit a WHERE ${where(parts)}
    ORDER BY a.ts ASC, a.id ASC LIMIT ${AUDIT_EXPORT_MAX + 1}`;
}

export function encodeAuditCursor(row: { ts: string; id: string }): string {
  return Buffer.from(`${row.ts}|${row.id}`).toString("base64url");
}

export function decodeAuditCursor(raw: string): { ts: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    const id = decoded.slice(idx + 1);
    if (!/^[0-9a-fA-F-]{36}$/.test(id) || !decoded.slice(0, idx)) return null;
    return { ts: decoded.slice(0, idx), id };
  } catch {
    return null;
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

export interface CommandRowView {
  id: string;
  kind: string;
  status: string;
  requestedAt: string;
  requestedBy: string | null;
  completedAt: string | null;
  outcome: string | null;
  error: string | null;
}

/** The command queue as the console renders it. `params` is NOT projected: a
 *  command's parameters are allowlisted before they are stored, but the panel
 *  has no reason to echo them and every reason not to. */
export function commandsQuery(limit = 50): SQL {
  const n = Math.min(Math.max(1, Math.trunc(limit)), 200);
  return sql`SELECT
      c.id AS "id",
      c.kind AS "kind",
      c.status AS "status",
      c.requested_at AS "requestedAt",
      c.requested_by AS "requestedBy",
      c.completed_at AS "completedAt",
      c.outcome AS "outcome",
      c.error AS "error"
    FROM hx.console_commands c
    ORDER BY c.requested_at DESC
    LIMIT ${n}`;
}

/**
 * The DRAINED half of the corroboration input.
 *
 * The spool tail is preferred — the drain runs at boot, at first recovery and on
 * a 30s timer, so joining the table alone would render every genuine success as
 * unconfirmed for up to half a minute. But spool files rotate and are reclaimed,
 * while these rows are never deleted, so a tail-ONLY source renders every
 * command older than the retention floor as REPORTED (UNCONFIRMED) — which is
 * the exact state that means a Postgres-role adversary fabricated an outcome.
 * Both sources feed one ANY-MATCH predicate.
 */
export function drainedOutcomesQuery(commandIds: readonly string[]): SQL {
  if (commandIds.length === 0) {
    return sql`SELECT NULL::text AS "sessionRef", NULL::text AS "action", NULL::text AS "kind", NULL::jsonb AS "params" WHERE false`;
  }
  const ids = sql.join(
    commandIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // Projected in the shape the corroboration predicate parses, so the drained
  // half and the spool half reach it as one kind of thing.
  return sql`SELECT a.session_ref AS "sessionRef", a.action AS "action", a.kind AS "kind", a.params AS "params"
    FROM hx.admin_audit a
    WHERE a.kind = 'outcome' AND a.session_ref IN (${ids})`;
}
