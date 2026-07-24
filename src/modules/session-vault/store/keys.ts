// M-6 · central, validated object-key builders shared by BOTH stores (GCS + S3).
//
// The session key segments (userId / family / sessionId) originate from a
// capability token or a tunnel RPC — untrusted from the store's point of view. A
// segment carrying "/" or ".." could escape its `${userId}/${family}/${sessionId}`
// prefix and read or clobber another session's (or another user's) objects. Every
// segment is therefore constrained to a conservative charset and rejected if it
// is "." / ".." or empty. The internal path literals (".staging", ".compact-*",
// "log.jsonl") are code-controlled and never pass through assertSegment.

import type { SessionKey } from "./types.js";

const SEG = /^[A-Za-z0-9._-]{1,200}$/;

function assertSegment(v: string, label: string): void {
  if (!SEG.test(v) || v === "." || v === "..") throw new Error(`invalid ${label} segment`);
}

/** Validate a sessionId, which is EITHER a plain colon-free segment OR the agent-
 *  lane composite `${sessionId}:a:${agentId}` (built by the gateway, exactly three
 *  parts with the literal `a` marker in the middle). A plain sessionId (a UUID)
 *  must contain NO `:`, so a crafted multi-colon id ("S:b:c", "S:a:A:B", a stray
 *  ":") can't fabricate a nested prefix or masquerade as an agent lane. */
function assertSessionId(sessionId: string): void {
  if (!sessionId.includes(":")) {
    assertSegment(sessionId, "sessionId");
    return;
  }
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[1] !== "a") {
    throw new Error("invalid sessionId segment");
  }
  assertSegment(parts[0], "sessionId"); // the base session id
  assertSegment(parts[2], "sessionId"); // the agent id (marker `a` is fixed)
}

/** `${userId}/${family}/${sessionId}` with every segment validated (the sessionId
 *  via `assertSessionId` — plain, or the agent-lane composite). */
export function sessionPrefix(k: SessionKey): string {
  assertSegment(k.userId, "userId");
  assertSegment(k.family, "family");
  assertSessionId(k.sessionId);
  return `${k.userId}/${k.family}/${k.sessionId}`;
}

/** The `${userId}/` list prefix for one user's objects, with the segment validated
 *  — parity with the per-object key builders so an untrusted userId can never widen
 *  a listing beyond its own prefix (M-6). */
export function listPrefix(userId: string): string {
  assertSegment(userId, "userId");
  return `${userId}/`;
}

/** The two list prefixes that together cover EVERY object of one session: its
 *  own directory (`…/sid/`) and every agent lane (`…/sid:a:` — sibling
 *  prefixes, not nested). Both are exact-segment shaped: the char after the
 *  session id is `/` or `:`, so a longer sibling id can never match. Callers
 *  pass the BASE session id (no `:a:` composite). */
export function sessionDeletePrefixes(k: SessionKey): [string, string] {
  if (k.sessionId.includes(":")) throw new Error("deleteSession requires the base session id");
  const p = sessionPrefix(k);
  return [`${p}/`, `${p}:a:`];
}

export function stagingObject(k: SessionKey, chunkId: string): string {
  assertSegment(chunkId, "chunkId");
  return `${sessionPrefix(k)}/.staging/${chunkId}.jsonl`;
}

export function canonicalObject(k: SessionKey): string {
  return `${sessionPrefix(k)}/log.jsonl`;
}

// Only these sidecar artifacts may be written/read by name — the `name` on the
// artifact RPC / gateway route is caller-controlled, so an allowlist prevents it
// naming ".staging/…", "log.jsonl", or a traversal path.
const ARTIFACT_ALLOWLIST = new Set(["session.json", "tasks.json", "plan.json"]);

// The workbench also writes/reads a per-run workflow artifact named
// `workflow-<runId>.json` (workflowArtifactName). runId varies per run, so a fixed
// Set can't hold it — a STRICT pattern admits it while the `[A-Za-z0-9_-]` charset
// (no ".", no "/") keeps it traversal-safe just like an assertSegment segment.
const WORKFLOW_ARTIFACT = /^workflow-[A-Za-z0-9_-]{4,200}\.json$/;

export function artifactObject(k: SessionKey, name: string): string {
  if (!ARTIFACT_ALLOWLIST.has(name) && !WORKFLOW_ARTIFACT.test(name)) {
    throw new Error(`artifact not allowed: ${name}`);
  }
  return `${sessionPrefix(k)}/${name}`;
}
