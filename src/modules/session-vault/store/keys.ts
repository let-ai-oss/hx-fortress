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

/** `${userId}/${family}/${sessionId}` with every segment validated. The
 *  sessionId may be the composite `${sessionId}:a:${agentId}` (agent lanes), so
 *  it is split on ":" and each part validated. */
export function sessionPrefix(k: SessionKey): string {
  assertSegment(k.userId, "userId");
  assertSegment(k.family, "family");
  for (const p of k.sessionId.split(":")) assertSegment(p, "sessionId");
  return `${k.userId}/${k.family}/${k.sessionId}`;
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
