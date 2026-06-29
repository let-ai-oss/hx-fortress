// The metadata ingestion path: parse a committed session chunk and write the
// derived metadata into the bundled hx schema. Called by the gateway commit
// handlers after the bytes are composed into the canonical blob. Everything for
// one chunk lands in a single transaction; a per-chunk dedupe key on
// hx.ingest_events makes a re-committed chunk a no-op (idempotent retries).

import { and, eq, isNull, sql } from "drizzle-orm";

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
import type { SessionKey } from "../modules/session-vault/store/types";
import { upsertDevice, upsertModel, upsertOrg, upsertProject, upsertRepo, upsertUser } from "./dimensions";
import { parseChunk, type ParsedChunk, type ParsedToolCall, type ParsedTurn } from "./parse";

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

function kindOf(meta: Record<string, unknown> | null): HxSessionAgentKind {
  return meta?.kind === "workflow_agent" ? "workflow_agent" : "subagent";
}

async function resolveDimensions(
  tx: HxTx,
  attribution: IngestAttribution,
  userExternalId: string,
  lastModel: string | null,
  now: string,
): Promise<ResolvedDimensions> {
  const userId = await upsertUser(tx, userExternalId, now);
  const orgId = attribution.orgExternalId ? await upsertOrg(tx, attribution.orgExternalId, now) : null;
  const projectId =
    orgId && attribution.projectExternalId
      ? await upsertProject(tx, orgId, attribution.projectExternalId, now)
      : null;
  const repoId = attribution.repoSlug ? await upsertRepo(tx, attribution.repoSlug, projectId, now) : null;
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
  await tx.insert(hxTurns).values(
    turns.map((t) => ({
      sessionId,
      agentId,
      seq: seq++,
      role: t.role,
      eventTs: t.eventTs,
      text: t.text,
      rawEvent: t.rawEvent,
      createdAt: now,
      updatedAt: now,
    })),
  );
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

  await db.transaction(async (tx) => {
    if (await alreadyIngested(tx, dedupeKey)) return;

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now);

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
      await tx.delete(hxTurns).where(and(eq(hxTurns.sessionId, sessionRowId), isNull(hxTurns.agentId)));
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), isNull(hxToolCalls.agentId)));
    }

    await insertTurns(tx, sessionRowId, null, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, null, parsed.toolCalls, now);

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
}

/** Ingest a child-lane (subagent / workflow-agent) commit. */
export async function ingestAgentCommit(db: HxDb, input: IngestAgentCommitInput): Promise<void> {
  const userExternalId = input.key.userId;
  if (!userExternalId || !input.agentId) return;
  const now = new Date().toISOString();
  const dedupeKey = `${userExternalId}:${input.key.family}:${input.key.sessionId}:a:${input.agentId}:${input.chunkId}`;
  const parsed = parseChunk(input.chunkText);

  await db.transaction(async (tx) => {
    if (await alreadyIngested(tx, dedupeKey)) return;

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now);

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
      await tx.delete(hxTurns).where(and(eq(hxTurns.sessionId, sessionRowId), eq(hxTurns.agentId, agentRowId)));
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), eq(hxToolCalls.agentId, agentRowId)));
    }

    await insertTurns(tx, sessionRowId, agentRowId, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, agentRowId, parsed.toolCalls, now);

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
}
