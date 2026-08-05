import type { SessionMetadata } from "./types.js";

export const SESSION_METADATA_ARTIFACT = "session.json";
export const SESSION_CANONICAL_ARTIFACT = "log.jsonl";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseSessionMetadata(value: unknown): SessionMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.family !== "string" || typeof row.sessionId !== "string") return null;
  if (typeof row.firstSeenAt !== "string" || typeof row.updatedAt !== "string") return null;
  return {
    family: row.family,
    sessionId: row.sessionId,
    title: stringOrNull(row.title),
    titleSource:
      row.titleSource === "user" || row.titleSource === "ai" || row.titleSource === "fallback"
        ? row.titleSource
        : null,
    bytesUploaded: numberOrZero(row.bytesUploaded),
    eventCount: numberOrZero(row.eventCount),
    userTextCount: numberOrZero(row.userTextCount),
    assistantCount: numberOrZero(row.assistantCount),
    lastActivityAt: stringOrNull(row.lastActivityAt),
    firstSeenAt: row.firstSeenAt,
    updatedAt: row.updatedAt,
    cwd: stringOrNull(row.cwd),
    gitBranch: stringOrNull(row.gitBranch),
    sourcePath: stringOrNull(row.sourcePath),
    repoSlug: stringOrNull(row.repoSlug),
    deviceName: stringOrNull(row.deviceName),
  };
}

/** MC-2606 — the session-list title is PG-authoritative (served by
 *  listSessionsForUser). The session.json artifact is content-only; strip its
 *  title from the legacy `listSessionMetadata` fallback so a stale artifact title
 *  can never diverge from PG. During a fortress PG outage the fallback list is
 *  then untitled rather than stale-titled — one source of truth for the title. */
export function stripListTitle(sessions: SessionMetadata[]): SessionMetadata[] {
  return sessions.map((s) =>
    s.title === null && s.titleSource === null ? s : { ...s, title: null, titleSource: null },
  );
}

export function metadataFromCanonicalObjectName(
  userId: string,
  objectName: string,
  size: number,
  updatedAt: string,
): SessionMetadata | null {
  const prefix = `${userId}/`;
  if (!objectName.startsWith(prefix) || !objectName.endsWith(`/${SESSION_CANONICAL_ARTIFACT}`)) {
    return null;
  }
  const parts = objectName.slice(prefix.length).split("/");
  if (parts.length !== 3 || parts[2] !== SESSION_CANONICAL_ARTIFACT) return null;
  const [family, sessionId] = parts;
  if (!family || !sessionId) return null;
  return {
    family,
    sessionId,
    title: null,
    titleSource: null,
    bytesUploaded: size,
    eventCount: 0,
    userTextCount: 0,
    assistantCount: 0,
    lastActivityAt: updatedAt,
    firstSeenAt: updatedAt,
    updatedAt,
    cwd: null,
    gitBranch: null,
    sourcePath: null,
    repoSlug: null,
    deviceName: null,
  };
}

/**
 * Merge a sidecar being REPLAYED against whatever the store holds now.
 *
 * A parked sidecar is not a delta — it is a whole composition the gateway made
 * from the sidecar as it stood before the pause. Reads stay open through a
 * pause, so every deferred commit inside one episode composed from the SAME
 * pre-pause text, and replaying those compositions verbatim meant the last one
 * won outright: a title set by the first chunk, and every count and stamp only
 * the earlier chunks carried, reverted to their pre-pause values in the
 * customer's only copy.
 *
 * So a replay merges instead of overwriting, with the same rules the gateway
 * applies when it composes: a value present wins over an absent one, counts and
 * activity move forward only, and `firstSeenAt` moves backward only.
 */
export function mergeReplayedMetadata(
  current: SessionMetadata | null,
  incoming: SessionMetadata,
  /** The commit this sidecar belongs to was a REPLACE — authoritative, and its
   *  totals may legitimately be SMALLER than what the bucket holds. Merging them
   *  forward would pin the sidecar to the pre-replace numbers permanently, which
   *  is the same "authoritative on replace" rule the gateway and the hub's
   *  destination bookkeeping both apply. */
  replace = false,
): SessionMetadata {
  if (!current) return incoming;
  if (replace) return incoming;
  const laterIso = (a: string | null, b: string | null): string | null => {
    if (!a) return b;
    if (!b) return a;
    return Date.parse(a) >= Date.parse(b) ? a : b;
  };
  const earlierIso = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);
  return {
    family: incoming.family,
    sessionId: incoming.sessionId,
    // TOGETHER. Resolving them from different sides labelled an AI-derived
    // title as operator-set: the title is the value and the source is a claim
    // ABOUT that value, so they move as one.
    title: incoming.title ?? current.title,
    titleSource: incoming.title !== null ? incoming.titleSource : current.titleSource,
    // Monotonic: a replay carries a snapshot of the totals as they were, and a
    // later chunk's totals are the larger ones.
    bytesUploaded: Math.max(incoming.bytesUploaded, current.bytesUploaded),
    eventCount: Math.max(incoming.eventCount, current.eventCount),
    userTextCount: Math.max(incoming.userTextCount, current.userTextCount),
    assistantCount: Math.max(incoming.assistantCount, current.assistantCount),
    lastActivityAt: laterIso(incoming.lastActivityAt, current.lastActivityAt),
    firstSeenAt: earlierIso(incoming.firstSeenAt, current.firstSeenAt),
    updatedAt: laterIso(incoming.updatedAt, current.updatedAt) ?? incoming.updatedAt,
    cwd: incoming.cwd ?? current.cwd,
    gitBranch: incoming.gitBranch ?? current.gitBranch,
    sourcePath: incoming.sourcePath ?? current.sourcePath,
    repoSlug: incoming.repoSlug ?? current.repoSlug,
    deviceName: incoming.deviceName ?? current.deviceName,
  };
}
