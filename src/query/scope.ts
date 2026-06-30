// A6 · scope enforcement — the fortress-side privacy boundary for every hx_*
// query tool.
//
// Workbench (the MCP client) resolves consent into a concrete scope and passes
// it as a tool argument; the fortress matches the ENUMERATED in-scope session
// identities on its LIVE `hx.sessions` row (plus `deleted_at IS NULL`) and
// evaluates NO org/repo/project/membership/shares predicate of its own (it
// holds no roster/shares/grants). It never re-derives attribution and never
// reads the denormalized `turns.user_id` (which would bypass attribution,
// shares, grants, and the parent's soft-delete) — keyword/read queries join
// turns -> sessions and apply the scope on the session row.
//
// Identity = the fortress natural key (userExternalId, family, sessionId):
// userExternalId resolves to hx.users.external_id, then (user, family,
// session_id) matches the hx.sessions UNIQUE natural key.
//
// FAIL-CLOSED: empty/absent identities ⇒ match-nothing (the authenticated MCP
// caller is the org's workbench, not an end user — there is no caller-own
// fallback). The owner gate is purely ADDITIVE AND-narrowing (active-member set
// so a departed owner drops); it is never a substitute for enumeration.

import { sql, type SQL } from "drizzle-orm";

import { hxSessions } from "../host/postgres/schema";

/** One enumerated in-scope session, by fortress natural key. */
export interface ScopeIdentity {
  userExternalId: string;
  family: string;
  sessionId: string;
}

/** The resolved consent scope passed on every hx_* MCP call (§13-C). */
export interface FortressScope {
  /** Enumerated in-scope session identities. Empty ⇒ match nothing. */
  identities: ScopeIdentity[];
  /** Additive AND-narrowing owner gate: a session is admitted only if its owner
   *  (userExternalId) is in this active-member set. Absent ⇒ no extra narrowing. */
  ownerGate?: { activeMemberExternalIds: string[] };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce untrusted MCP JSON args into a typed scope. Anything malformed
 *  degrades to an empty identity set, so a bad payload fails closed rather than
 *  widening the result. */
export function parseScope(raw: unknown): FortressScope {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawIdentities = Array.isArray(obj.identities) ? obj.identities : [];
  const identities: ScopeIdentity[] = [];
  for (const it of rawIdentities) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const userExternalId = asString(r.userExternalId);
    const family = asString(r.family);
    const sessionId = asString(r.sessionId);
    if (userExternalId && family && sessionId) {
      identities.push({ userExternalId, family, sessionId });
    }
  }
  let ownerGate: FortressScope["ownerGate"];
  if (obj.ownerGate && typeof obj.ownerGate === "object") {
    const g = obj.ownerGate as Record<string, unknown>;
    const members = Array.isArray(g.activeMemberExternalIds)
      ? g.activeMemberExternalIds.filter((m): m is string => typeof m === "string")
      : [];
    ownerGate = { activeMemberExternalIds: members };
  }
  return ownerGate ? { identities, ownerGate } : { identities };
}

/** A SQL predicate selecting the live `hx.sessions` rows admitted by the scope.
 *  AND this into any query whose FROM/JOIN includes `hx.sessions`. Fail-closed:
 *  an empty identity set yields `false` (match nothing).
 *
 *  Carries the identities as a self-contained VALUES join (never a single
 *  `IN (…)` — Postgres' ~65 535-parameter ceiling), matching §13-C. */
export function scopePredicate(scope: FortressScope): SQL {
  const identities = Array.isArray(scope?.identities) ? scope.identities : [];
  if (identities.length === 0) return sql`false`;

  const tuples = identities.map(
    (i) => sql`(${i.userExternalId}::text, ${i.family}::text, ${i.sessionId}::text)`,
  );
  const values = sql.join(tuples, sql`, `);

  // Owner gate: admit an identity only if its owner is an active member. An
  // empty active-member set admits nothing (a gate with no members).
  let gate: SQL = sql``;
  if (scope.ownerGate) {
    const members = Array.isArray(scope.ownerGate.activeMemberExternalIds)
      ? scope.ownerGate.activeMemberExternalIds
      : [];
    gate =
      members.length === 0
        ? sql` AND false`
        : sql` AND scope_ids.user_external_id IN (${sql.join(
            members.map((m) => sql`${m}`),
            sql`, `,
          )})`;
  }

  return sql`${hxSessions.id} IN (
    SELECT s2.id FROM hx.sessions s2
    JOIN hx.users u2 ON u2.id = s2.user_id
    JOIN (VALUES ${values}) AS scope_ids(user_external_id, family, session_id)
      ON u2.external_id = scope_ids.user_external_id
     AND s2.family = scope_ids.family
     AND s2.session_id = scope_ids.session_id
    WHERE s2.deleted_at IS NULL${gate}
  )`;
}
