// The metadata ingestion path: parse a committed session chunk and write the
// derived metadata into the bundled hx schema. Called by the gateway commit
// handlers after the bytes are composed into the canonical blob. Everything for
// one chunk lands in a single transaction; a per-chunk dedupe key on
// hx.ingest_events makes a re-committed chunk a no-op (idempotent retries).

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { HxDb, HxTx } from "../host/postgres/db";
import {
  hxIngestEvents,
  hxSessionAgents,
  hxSessions,
  hxToolCalls,
  hxTurns,
  type HxSessionAgentKind,
  type HxTitleSource,
} from "../host/postgres/schema";
import { hxEmbeddings } from "../host/postgres/schema/embeddings";
import { hxSessionFacts } from "../host/postgres/schema/facts";
import { signalEmbedWork } from "../modules/embed-worker/signal";
import type { SessionKey } from "../modules/session-vault/store/types";
import { upsertDevice, upsertModel, upsertOrg, upsertProject, upsertRepo, upsertUser } from "./dimensions";
import { parseChunk, type ParsedChunk, type ParsedToolCall, type ParsedTurn } from "./parse";

/** Hard-delete the embeddings owned by the given (now-deleted) turn ids, in the
 *  SAME txn as the turn delete. hx.embeddings is a POLYMORPHIC owner (owner_kind
 *  /owner_id, no FK), so a `replace` — which deletes + reinserts turns under new
 *  ids — has no cascade and would orphan the old vectors, bloating the HNSW (A7).
 *  No-op when hx.embeddings is absent (a non-pgvector fortress where 0006 was
 *  gated-skipped), so the replace path stays safe there. */
async function deleteOrphanedEmbeddings(tx: HxTx, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  // to_regclass returns NULL (never errors) when the relation is absent, so this
  // probe can't poison the surrounding transaction.
  const reg = await tx.execute(sql`SELECT to_regclass('hx.embeddings') AS rel`);
  const rows = Array.isArray(reg) ? reg : ((reg as { rows?: unknown[] }).rows ?? []);
  const present = (rows[0] as { rel?: string | null } | undefined)?.rel != null;
  if (!present) return;
  await tx
    .delete(hxEmbeddings)
    .where(and(eq(hxEmbeddings.ownerKind, "turn"), inArray(hxEmbeddings.ownerId, turnIds)));
}

// ── Per-session productivity facts (§13-A4) ──────────────────────────────────
// Derived at ingest from the session's turns + tool_calls and upserted into
// hx.session_facts in the SAME commit txn (recomputed from the LIVE post-write
// state, so `replace` — which deletes + reinserts the lane first — never
// double-counts). Scoped to the PARENT lane (agent_id IS NULL): the §10
// completeness guarantee is parent-lane.

/** Cap each inter-event gap at a fixed idle threshold (§13-A4: e.g. 5 min). */
const IDLE_CAP_MS = 5 * 60 * 1000;
/** Tools whose inputs carry a file diff (files_touched / lines_±). */
const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Line count of a newline-delimited string; non-string / empty ⇒ 0 (a deletion
 *  adds no lines). "a\nb" ⇒ 2. */
function lineCount(v: unknown): number {
  return typeof v === "string" && v.length > 0 ? v.split("\n").length : 0;
}

interface DiffMetrics {
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
}

/** files_touched / lines_± from the Edit/Write/MultiEdit tool inputs (§13-A4):
 *  Write → content (added only); Edit → old_string/new_string; MultiEdit → the
 *  sum over edits[]. files_touched = distinct file_path count across all three. */
function diffMetrics(calls: { toolName: string | null; input: Record<string, unknown> | null }[]): DiffMetrics {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const c of calls) {
    if (!c.toolName || !DIFF_TOOLS.has(c.toolName) || !c.input) continue;
    const input = c.input;
    if (typeof input.file_path === "string" && input.file_path) files.add(input.file_path);
    if (c.toolName === "Write") {
      linesAdded += lineCount(input.content);
    } else if (c.toolName === "Edit") {
      linesAdded += lineCount(input.new_string);
      linesRemoved += lineCount(input.old_string);
    } else {
      // MultiEdit — one file_path, an edits[] of { old_string, new_string }.
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const e of edits) {
        if (e && typeof e === "object") {
          const ed = e as Record<string, unknown>;
          linesAdded += lineCount(ed.new_string);
          linesRemoved += lineCount(ed.old_string);
        }
      }
    }
  }
  return { filesTouched: files.size, linesAdded, linesRemoved };
}

/** active_ms = idle-capped sum of inter-event gaps over event_ts, applying the
 *  §10 fill rule: a null event_ts INHERITS the prior turn's work-time; a LEADING
 *  null run is seeded from the session's first known activity, and from `seedTs`
 *  (the session's first_event_at / upload time, never commit-time) when the
 *  session has no event_ts at all. Returns active_ms + the primary-day basis
 *  (min(event_ts), else the seed). `orderedEventTs` is the parent lane in seq
 *  order. */
function activeMsFromEventTs(
  orderedEventTs: (string | null)[],
  seedTs: string | null,
): { activeMs: number; basisMs: number | null } {
  const parse = (v: string | null): number | null => {
    if (v == null) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  };

  let firstKnownMs: number | null = null;
  let minMs: number | null = null;
  for (const ts of orderedEventTs) {
    const ms = parse(ts);
    if (ms == null) continue;
    if (firstKnownMs == null) firstKnownMs = ms;
    if (minMs == null || ms < minMs) minMs = ms;
  }
  const seedMs = parse(seedTs);
  // The leading null run is seeded from first known activity, else the seed.
  let prev: number | null = firstKnownMs ?? seedMs;

  let activeMs = 0;
  let last: number | null = null;
  for (const ts of orderedEventTs) {
    const ms = parse(ts);
    let cur: number;
    if (ms != null) {
      cur = ms;
      prev = ms; // a real ts becomes the basis the next null inherits
    } else if (prev != null) {
      cur = prev; // inherit the prior turn's work-time
    } else {
      continue; // no basis yet (all-null prefix, no seed) — skip
    }
    if (last != null) {
      const gap = cur - last;
      if (gap > 0) activeMs += Math.min(gap, IDLE_CAP_MS);
    }
    last = cur;
  }
  return { activeMs, basisMs: minMs ?? seedMs };
}

/** Recompute + upsert the session's hx.session_facts row from its LIVE parent-
 *  lane turns + tool_calls (§13-A4). Called in the commit txn AFTER this chunk's
 *  turns/tool_calls are written. `seedTs` = the session's first_event_at / upload
 *  time (the fill-rule seed for an all-null-ts session). */
async function recomputeSessionFacts(
  tx: HxTx,
  sessionId: string,
  userId: string,
  seedTs: string | null,
  now: string,
): Promise<void> {
  const turns = await tx
    .select({ kind: hxTurns.kind, eventTs: hxTurns.eventTs })
    .from(hxTurns)
    .where(and(eq(hxTurns.sessionId, sessionId), isNull(hxTurns.agentId)))
    .orderBy(asc(hxTurns.seq));

  const calls = await tx
    .select({ toolName: hxToolCalls.toolName, input: hxToolCalls.input })
    .from(hxToolCalls)
    .where(and(eq(hxToolCalls.sessionId, sessionId), isNull(hxToolCalls.agentId)));

  let userMsgs = 0;
  let assistantMsgs = 0;
  for (const t of turns) {
    if (t.kind === "user_text") userMsgs += 1;
    else if (t.kind === "assistant_text") assistantMsgs += 1;
  }

  const toolCallsByType: Record<string, number> = {};
  for (const c of calls) {
    if (!c.toolName) continue; // a tool_result-only row carries an empty name
    toolCallsByType[c.toolName] = (toolCallsByType[c.toolName] ?? 0) + 1;
  }

  const { activeMs, basisMs } = activeMsFromEventTs(
    turns.map((t) => t.eventTs),
    seedTs,
  );
  // primary_day = date(min(event_ts)) in UTC.
  const primaryDay = basisMs == null ? null : new Date(basisMs).toISOString().slice(0, 10);
  const { filesTouched, linesAdded, linesRemoved } = diffMetrics(calls);

  const row = {
    userId,
    primaryDay,
    activeMs,
    userMsgs,
    assistantMsgs,
    toolCallsByType,
    filesTouched,
    linesAdded,
    linesRemoved,
    updatedAt: now,
  };
  await tx
    .insert(hxSessionFacts)
    .values({ sessionId, ...row })
    .onConflictDoUpdate({ target: hxSessionFacts.sessionId, set: row });
}

// Attribution resolved upstream (the cloud over the tunnel, or the capability
// token on the direct gateway). All ids are the cloud-side "external" ids the
// hx dimension tables reconcile on; null when the upstream didn't provide one.
export interface IngestAttribution {
  orgExternalId: string | null;
  repoSlug: string | null;
  projectExternalId: string | null;
  deviceId: string | null;
}

export interface IngestCommitInput {
  attribution: IngestAttribution;
  key: SessionKey;
  chunkId: string;
  chunkText: string;
  totalBytes: number;
  componentCount: number;
  replace: boolean;
  meta: Record<string, unknown> | null;
}

export interface IngestAgentCommitInput extends IngestCommitInput {
  agentId: string;
}

interface ResolvedDimensions {
  userId: string;
  orgId: string | null;
  projectId: string | null;
  repoId: string | null;
  deviceId: string | null;
  modelId: string | null;
}

function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" ? v : null;
}

function titleSourceOf(meta: Record<string, unknown> | null): HxTitleSource | null {
  const v = meta?.titleSource;
  return v === "user" || v === "ai" || v === "fallback" ? v : null;
}

/** Best-effort repo identity for when the client didn't send an explicit
 *  repoSlug (claims.repo / meta.repoSlug — the PREFERRED source). Falls back to
 *  the last path segment of the session's cwd (e.g. "/home/x/let-forge" →
 *  "let-forge"), the repo root for the common case of running at the checkout
 *  root. Returns null for an empty/root path so we never upsert a junk
 *  dimension. Heuristic — a client that sends its real slug always wins. */
function repoSlugFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const segs = cwd.split(/[/\\]+/).filter((seg) => seg && seg !== "." && seg !== "..");
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
}

function kindOf(meta: Record<string, unknown> | null): HxSessionAgentKind {
  return meta?.kind === "workflow_agent" ? "workflow_agent" : "subagent";
}

async function resolveDimensions(
  tx: HxTx,
  attribution: IngestAttribution,
  userExternalId: string,
  lastModel: string | null,
  now: string,
  cwd: string | null,
): Promise<ResolvedDimensions> {
  const userId = await upsertUser(tx, userExternalId, now);
  const orgId = attribution.orgExternalId ? await upsertOrg(tx, attribution.orgExternalId, now) : null;
  const projectId =
    orgId && attribution.projectExternalId
      ? await upsertProject(tx, orgId, attribution.projectExternalId, now)
      : null;
  // Prefer the client-sent repoSlug; fall back to the cwd's repo root so repo
  // attribution (and the by-repo aggregate) is populated instead of null when the
  // client omits it (see repoSlugFromCwd).
  const repoSlug = attribution.repoSlug ?? repoSlugFromCwd(cwd);
  const repoId = repoSlug ? await upsertRepo(tx, repoSlug, projectId, now) : null;
  const deviceId = attribution.deviceId ? await upsertDevice(tx, userId, attribution.deviceId, now) : null;
  const modelId = lastModel ? await upsertModel(tx, lastModel, now) : null;
  return { userId, orgId, projectId, repoId, deviceId, modelId };
}

/** True if this chunk was already ingested (its ingest event exists). */
async function alreadyIngested(tx: HxTx, dedupeKey: string): Promise<boolean> {
  const rows = await tx
    .select({ id: hxIngestEvents.id })
    .from(hxIngestEvents)
    .where(eq(hxIngestEvents.dedupeKey, dedupeKey))
    .limit(1);
  return rows.length > 0;
}

/** Insert turns for one lane (parent: agentId null), seq continuing from max+1. */
// Postgres text/jsonb both reject U+0000 (0x00). Transcripts can carry `\u0000`
// JSON escapes (e.g. in tool output) that JSON.parse decodes to a real null byte,
// which would fail the whole session's insert. Strip null bytes from every parsed
// text + deep-scrub the raw/tool JSON objects before they reach the DB.
function stripNul(s: string | null): string | null {
  return typeof s === "string" && s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}
function deepStripNul<T>(v: T): T {
  // Walk the actual object and strip real U+0000 from string VALUES only. (An
  // earlier stringify→regex→parse shortcut corrupted content that legitimately
  // contained the literal text "\\u0000" — an escaped backslash — into invalid JSON.)
  if (typeof v === "string") return (v.includes("\u0000") ? v.replace(/\u0000/g, "") : v) as T;
  if (Array.isArray(v)) return v.map((x) => deepStripNul(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepStripNul(val);
    return out as T;
  }
  return v;
}
function scrubParsed(parsed: ParsedChunk): void {
  parsed.lastUserText = stripNul(parsed.lastUserText);
  parsed.lastAssistantText = stripNul(parsed.lastAssistantText);
  for (const t of parsed.turns) {
    t.text = stripNul(t.text);
    t.rawEvent = deepStripNul(t.rawEvent);
  }
  for (const c of parsed.toolCalls) {
    c.input = deepStripNul(c.input);
    c.result = deepStripNul(c.result);
  }
}

async function insertTurns(
  tx: HxTx,
  sessionId: string,
  agentId: string | null,
  turns: ParsedTurn[],
  now: string,
): Promise<void> {
  if (turns.length === 0) return;
  const laneFilter = agentId
    ? and(eq(hxTurns.sessionId, sessionId), eq(hxTurns.agentId, agentId))
    : and(eq(hxTurns.sessionId, sessionId), isNull(hxTurns.agentId));
  const [{ maxSeq }] = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${hxTurns.seq}), -1)` })
    .from(hxTurns)
    .where(laneFilter);
  let seq = Number(maxSeq ?? -1) + 1;
  const rows = turns.map((t) => ({
    sessionId,
    agentId,
    seq: seq++,
    role: t.role,
    kind: t.kind,
    eventTs: t.eventTs,
    text: t.text,
    rawEvent: t.rawEvent,
    createdAt: now,
    updatedAt: now,
  }));
  // Batch the insert: one multi-row INSERT binds rows×cols params and the PG wire
  // protocol caps at 65535 — a very large session (thousands of turns) would blow
  // it ("too many parameters"). ~500 rows/batch keeps params well under the cap.
  const INSERT_BATCH = 500;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await tx.insert(hxTurns).values(rows.slice(i, i + INSERT_BATCH));
  }
}

/** Upsert tool calls by (session_id, tool_use_id) — tool_use sets name/input,
 *  tool_result (a separate event) fills in result/is_error for the same id. */
async function upsertToolCalls(
  tx: HxTx,
  sessionId: string,
  agentId: string | null,
  calls: ParsedToolCall[],
  now: string,
): Promise<void> {
  for (const c of calls) {
    if (!c.toolUseId) continue;
    const set: Partial<typeof hxToolCalls.$inferInsert> = { updatedAt: now };
    if (c.toolName !== null) set.toolName = c.toolName;
    if (c.input !== null) set.input = c.input;
    if (c.result !== null) {
      set.result = c.result;
      set.isError = c.isError;
    }
    await tx
      .insert(hxToolCalls)
      .values({
        sessionId,
        agentId,
        toolUseId: c.toolUseId,
        toolName: c.toolName ?? "",
        input: c.input,
        result: c.result,
        isError: c.isError,
        eventTs: c.eventTs,
      })
      .onConflictDoUpdate({ target: [hxToolCalls.sessionId, hxToolCalls.toolUseId], set });
  }
}

function ingestEventPayload(input: IngestCommitInput, sessionRowId: string, parsed: ParsedChunk) {
  return {
    chunk: {
      id: input.chunkId,
      byteCount: Buffer.byteLength(input.chunkText),
      totalBytes: input.totalBytes,
      componentCount: input.componentCount,
    },
    session: {
      rowId: sessionRowId,
      family: input.key.family,
      sessionId: input.key.sessionId,
      meta: input.meta ?? {},
    },
    transcriptIndex: {
      status: input.chunkText.trim() ? "indexed" : "skipped",
      inserted: parsed.turns.length,
    },
  };
}

/** Ingest a parent session commit into the bundled hx schema. */
export async function ingestCommit(db: HxDb, input: IngestCommitInput): Promise<void> {
  const userExternalId = input.key.userId;
  if (!userExternalId) return; // no user → can't satisfy the NOT NULL session FK
  const now = new Date().toISOString();
  const dedupeKey = `${userExternalId}:${input.key.family}:${input.key.sessionId}:${input.chunkId}`;
  const parsed = parseChunk(input.chunkText);
  scrubParsed(parsed);

  await db.transaction(async (tx) => {
    if (await alreadyIngested(tx, dedupeKey)) return;

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now, metaStr(input.meta, "cwd"));

    const existing = (
      await tx
        .select()
        .from(hxSessions)
        .where(
          and(
            eq(hxSessions.userId, dims.userId),
            eq(hxSessions.family, input.key.family),
            eq(hxSessions.sessionId, input.key.sessionId),
          ),
        )
        .limit(1)
    )[0];

    const prev = input.replace ? undefined : existing;
    const rollup = {
      eventCount: (prev?.eventCount ?? 0) + parsed.eventCount,
      userTextCount: (prev?.userTextCount ?? 0) + parsed.userTextCount,
      assistantCount: (prev?.assistantCount ?? 0) + parsed.assistantCount,
      toolCallCount: (prev?.toolCallCount ?? 0) + parsed.toolCallCount,
      inputTokens: (prev?.inputTokens ?? 0) + parsed.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + parsed.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + parsed.cacheReadTokens,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + parsed.cacheCreationTokens,
      estCostUsd: (prev?.estCostUsd ?? 0) + parsed.costUsd,
      chunkCount: input.replace ? 1 : (existing?.chunkCount ?? 0) + 1,
    };
    const lastActivityAt = parsed.lastActivityAt ?? existing?.lastActivityAt ?? now;
    const meta = input.meta;

    let sessionRowId: string;
    if (existing) {
      await tx
        .update(hxSessions)
        .set({
          deviceId: dims.deviceId ?? existing.deviceId,
          orgId: dims.orgId,
          projectId: dims.projectId,
          repoId: dims.repoId,
          modelId: dims.modelId ?? existing.modelId,
          attributionSource: "auto",
          title: metaStr(meta, "title") ?? existing.title,
          titleSource: titleSourceOf(meta) ?? existing.titleSource,
          ccdSessionId: metaStr(meta, "ccdSessionId") ?? existing.ccdSessionId,
          sourcePath: metaStr(meta, "sourcePath") ?? existing.sourcePath,
          cwd: metaStr(meta, "cwd") ?? existing.cwd,
          gitBranch: metaStr(meta, "gitBranch") ?? existing.gitBranch,
          entrypoint: metaStr(meta, "entrypoint") ?? existing.entrypoint,
          originator: metaStr(meta, "originator") ?? existing.originator,
          lastUserText: parsed.lastUserText ?? existing.lastUserText,
          lastAssistantText: parsed.lastAssistantText ?? existing.lastAssistantText,
          ...rollup,
          bytesUploaded: input.totalBytes,
          lastActivityAt,
          updatedAt: now,
        })
        .where(eq(hxSessions.id, existing.id));
      sessionRowId = existing.id;
    } else {
      const [ins] = await tx
        .insert(hxSessions)
        .values({
          userId: dims.userId,
          deviceId: dims.deviceId,
          orgId: dims.orgId,
          projectId: dims.projectId,
          repoId: dims.repoId,
          modelId: dims.modelId,
          family: input.key.family,
          sessionId: input.key.sessionId,
          ccdSessionId: metaStr(meta, "ccdSessionId"),
          title: metaStr(meta, "title"),
          titleSource: titleSourceOf(meta),
          sourcePath: metaStr(meta, "sourcePath"),
          cwd: metaStr(meta, "cwd"),
          gitBranch: metaStr(meta, "gitBranch"),
          entrypoint: metaStr(meta, "entrypoint"),
          originator: metaStr(meta, "originator"),
          attributionSource: "auto",
          lastUserText: parsed.lastUserText,
          lastAssistantText: parsed.lastAssistantText,
          ...rollup,
          bytesUploaded: input.totalBytes,
          firstEventAt: parsed.firstActivityAt ?? now,
          lastActivityAt,
        })
        .returning({ id: hxSessions.id });
      sessionRowId = ins.id;
    }

    if (input.replace) {
      // Capture the deleted turn ids (RETURNING) so their embeddings hard-delete
      // in the same txn — no FK cascade reaches the polymorphic owner (A7).
      const deleted = await tx
        .delete(hxTurns)
        .where(and(eq(hxTurns.sessionId, sessionRowId), isNull(hxTurns.agentId)))
        .returning({ id: hxTurns.id });
      await deleteOrphanedEmbeddings(
        tx,
        deleted.map((d) => d.id),
      );
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), isNull(hxToolCalls.agentId)));
    }

    await insertTurns(tx, sessionRowId, null, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, null, parsed.toolCalls, now);

    // Per-session productivity facts (§13-A4) — recomputed from the live parent-
    // lane state, so a `replace` (which re-indexed the lane above) recomputes
    // cleanly. Seed the §10 fill rule from the session's first activity / upload.
    await recomputeSessionFacts(
      tx,
      sessionRowId,
      dims.userId,
      existing?.firstEventAt ?? parsed.firstActivityAt ?? now,
      now,
    );

    await tx.insert(hxIngestEvents).values({
      userId: dims.userId,
      eventType: "hx.session.updated",
      sessionId: sessionRowId,
      family: input.key.family,
      sessionIdExt: input.key.sessionId,
      chunkId: input.chunkId,
      dedupeKey,
      payload: ingestEventPayload(input, sessionRowId, parsed),
      status: "processed",
      processedAt: now,
    });
  });

  // Off the commit path: nudge the embed worker that new indexable turns may
  // have landed (debounced + max-wait capped). Best-effort — never throws.
  signalEmbedWork();
}

/** Ingest a child-lane (subagent / workflow-agent) commit. */
export async function ingestAgentCommit(db: HxDb, input: IngestAgentCommitInput): Promise<void> {
  const userExternalId = input.key.userId;
  if (!userExternalId || !input.agentId) return;
  const now = new Date().toISOString();
  const dedupeKey = `${userExternalId}:${input.key.family}:${input.key.sessionId}:a:${input.agentId}:${input.chunkId}`;
  const parsed = parseChunk(input.chunkText);
  scrubParsed(parsed);

  await db.transaction(async (tx) => {
    if (await alreadyIngested(tx, dedupeKey)) return;

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now, metaStr(input.meta, "cwd"));

    // Ensure the parent session row exists (a child chunk can arrive first).
    const parent = (
      await tx
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .where(
          and(
            eq(hxSessions.userId, dims.userId),
            eq(hxSessions.family, input.key.family),
            eq(hxSessions.sessionId, input.key.sessionId),
          ),
        )
        .limit(1)
    )[0];
    let sessionRowId: string;
    if (parent) {
      sessionRowId = parent.id;
    } else {
      const [ins] = await tx
        .insert(hxSessions)
        .values({
          userId: dims.userId,
          deviceId: dims.deviceId,
          orgId: dims.orgId,
          projectId: dims.projectId,
          repoId: dims.repoId,
          family: input.key.family,
          sessionId: input.key.sessionId,
          attributionSource: "auto",
          firstEventAt: parsed.firstActivityAt ?? now,
          lastActivityAt: parsed.lastActivityAt ?? now,
        })
        .returning({ id: hxSessions.id });
      sessionRowId = ins.id;
    }

    const meta = input.meta;
    const existingAgent = (
      await tx
        .select()
        .from(hxSessionAgents)
        .where(
          and(eq(hxSessionAgents.sessionId, sessionRowId), eq(hxSessionAgents.agentExternalId, input.agentId)),
        )
        .limit(1)
    )[0];
    const prev = input.replace ? undefined : existingAgent;
    const agentRollup = {
      eventCount: (prev?.eventCount ?? 0) + parsed.eventCount,
      inputTokens: (prev?.inputTokens ?? 0) + parsed.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + parsed.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + parsed.cacheReadTokens,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + parsed.cacheCreationTokens,
      estCostUsd: (prev?.estCostUsd ?? 0) + parsed.costUsd,
      chunkCount: input.replace ? 1 : (existingAgent?.chunkCount ?? 0) + 1,
    };
    const agentLastActivityAt = parsed.lastActivityAt ?? existingAgent?.lastActivityAt ?? now;

    let agentRowId: string;
    if (existingAgent) {
      await tx
        .update(hxSessionAgents)
        .set({
          kind: kindOf(meta),
          runId: metaStr(meta, "runId") ?? existingAgent.runId,
          toolUseId: metaStr(meta, "toolUseId") ?? existingAgent.toolUseId,
          agentType: metaStr(meta, "agentType") ?? existingAgent.agentType,
          label: metaStr(meta, "label") ?? existingAgent.label,
          worktreePath: metaStr(meta, "worktreePath") ?? existingAgent.worktreePath,
          cwd: metaStr(meta, "cwd") ?? existingAgent.cwd,
          gitBranch: metaStr(meta, "gitBranch") ?? existingAgent.gitBranch,
          modelId: dims.modelId ?? existingAgent.modelId,
          ...agentRollup,
          bytesUploaded: input.totalBytes,
          lastActivityAt: agentLastActivityAt,
          updatedAt: now,
        })
        .where(eq(hxSessionAgents.id, existingAgent.id));
      agentRowId = existingAgent.id;
    } else {
      const [ins] = await tx
        .insert(hxSessionAgents)
        .values({
          sessionId: sessionRowId,
          agentExternalId: input.agentId,
          kind: kindOf(meta),
          runId: metaStr(meta, "runId"),
          toolUseId: metaStr(meta, "toolUseId"),
          agentType: metaStr(meta, "agentType"),
          label: metaStr(meta, "label"),
          worktreePath: metaStr(meta, "worktreePath"),
          cwd: metaStr(meta, "cwd"),
          gitBranch: metaStr(meta, "gitBranch"),
          modelId: dims.modelId,
          ...agentRollup,
          bytesUploaded: input.totalBytes,
          lastActivityAt: agentLastActivityAt,
        })
        .returning({ id: hxSessionAgents.id });
      agentRowId = ins.id;
    }

    if (input.replace) {
      // Child lane: same explicit embeddings hard-delete across the agent_id lane.
      const deleted = await tx
        .delete(hxTurns)
        .where(and(eq(hxTurns.sessionId, sessionRowId), eq(hxTurns.agentId, agentRowId)))
        .returning({ id: hxTurns.id });
      await deleteOrphanedEmbeddings(
        tx,
        deleted.map((d) => d.id),
      );
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), eq(hxToolCalls.agentId, agentRowId)));
    }

    await insertTurns(tx, sessionRowId, agentRowId, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, agentRowId, parsed.toolCalls, now);

    // hx.session_facts is intentionally NOT recomputed here — the §10/§13-A4
    // completeness guarantee is scoped to the parent lane (agent_id IS NULL),
    // which a child-lane commit does not touch.

    await tx.insert(hxIngestEvents).values({
      userId: dims.userId,
      eventType: "hx.session.agent.updated",
      sessionId: sessionRowId,
      family: input.key.family,
      sessionIdExt: input.key.sessionId,
      chunkId: input.chunkId,
      dedupeKey,
      payload: { ...ingestEventPayload(input, sessionRowId, parsed), agentId: input.agentId, agentRowId },
      status: "processed",
      processedAt: now,
    });
  });

  // Off the commit path: nudge the embed worker (best-effort — never throws).
  signalEmbedWork();
}
