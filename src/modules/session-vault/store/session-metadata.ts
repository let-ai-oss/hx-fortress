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
