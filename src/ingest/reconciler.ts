// Component G — the fortress-side guarantor + full-restore engine (MC-2606).
//
// Scans the store for canonical transcripts that have NO hx.sessions row (the
// row-less state that caused the title incident) and re-runs the FULL ingest
// over each — rebuilding the row, turn/FTS indexes, tool_calls, session_facts,
// dimensions, embeddings (async, via signalEmbedWork), and the real title (the
// tier-A cascade). It also runs the title corrective pass over existing
// fallback/empty-title rows. This makes "canonical-without-row" a state the
// fortress cannot durably remain in, and — with Component C (which restores the
// known set WITH attribution first) — restores the existing backlog.
//
// Re-ingest uses `replace: true` (a complete lane rebuild from the whole
// canonical, never an append) and `recovered: true` (org attribution is unknown
// here → left null / never demotes a real org). Paced, single-flight is the
// caller's responsibility (the scheduler), non-throwing per session.

import { sanitizeDbError } from "../host/postgres/sanitize";
import { and, eq, gt, isNull } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessionAgents, hxSessions } from "../host/postgres/schema/sessions";
import { hxUsers } from "../host/postgres/schema/dimensions";
import type { CanonicalEntry, SessionKey, SessionStore } from "../modules/session-vault/store/types";
import { correctTitles } from "./correct-titles";
import { isSessionDeleted } from "./delete";
import { ingestAgentCommit, ingestCommit } from "./ingest";

const AGENT_LANE = ":a:";

export interface ReconcileOptions {
  /** Delay between orphan re-ingests, ms — paces store I/O + the embed queue. */
  batchDelayMs?: number;
  /** Cap on orphans re-ingested this pass (0/undefined = no cap). */
  maxOrphans?: number;
  /** Also run the title corrective pass (default true). */
  correctExistingTitles?: boolean;
  /** Re-ingest sessions whose indexed byte count no longer matches their
   *  canonical. Default false: the pass COUNTS them either way, so the number can
   *  be read from production before anything acts on it. */
  repairStaleIndexes?: boolean;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    warn?(message: string, fields?: Record<string, unknown>): void;
    info?(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface ReconcileResult {
  scanned: number;
  orphans: number;
  restored: number;
  skippedTombstoned: number;
  /** Agent lanes deferred this pass because their parent re-ingest threw — they
   *  retry on the next sweep. A persistently-nonzero value flags a parent that
   *  never re-ingests (e.g. an unreadable canonical). */
  deferred: number;
  errors: number;
  titlesCorrected: number;
  /** Sessions whose row exists but whose indexed byte count differs from the
   *  canonical the store holds — an index that is BEHIND its transcript, which
   *  the existence-only scan cannot see. Counted always; repaired only when
   *  repairStaleIndexes is on. */
  staleIndexes: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A parent row with ZERO events carries no content: it is either a stub minted
 *  by a pre-0.19.0 agent-lane commit that arrived before its parent, or a restore
 *  that never completed. Such a row must NOT count as "indexed" — otherwise it
 *  masks its own canonical from the orphan scan and the session stays content-less
 *  forever (the permanent-loss shape). Re-ingesting is idempotent (replace: true
 *  rebuilds the lane from the whole canonical), so treating it as an orphan is
 *  always safe: a genuinely empty canonical simply rebuilds to the same nothing. */
const INDEXED = gt(hxSessions.eventCount, 0);

/** The natural key a canonical maps to. Parent lanes key on hx.sessions; agent
 *  lanes (`baseSid:a:agentId`) key on hx.session_agents under their parent, so an
 *  already-indexed lane isn't mistaken for an orphan and re-ingested every sweep. */
async function keyExists(db: HxDb, key: SessionKey): Promise<boolean> {
  const laneIdx = key.sessionId.indexOf(AGENT_LANE);
  if (laneIdx < 0) {
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(
        and(
          eq(hxUsers.externalId, key.userId),
          eq(hxSessions.family, key.family),
          eq(hxSessions.sessionId, key.sessionId),
          isNull(hxSessions.deletedAt),
          INDEXED,
        ),
      )
      .limit(1);
    return row != null;
  }
  const baseSid = key.sessionId.slice(0, laneIdx);
  const agentId = key.sessionId.slice(laneIdx + AGENT_LANE.length);
  const [row] = await db
    .select({ id: hxSessionAgents.id })
    .from(hxSessionAgents)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(
      and(
        eq(hxUsers.externalId, key.userId),
        eq(hxSessions.family, key.family),
        eq(hxSessions.sessionId, baseSid),
        eq(hxSessionAgents.agentExternalId, agentId),
        isNull(hxSessions.deletedAt),
        isNull(hxSessionAgents.deletedAt),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * One reconcile pass: re-index every row-less canonical, then correct existing
 * fallback/empty titles. Never throws (per-session failures are counted +
 * logged). Returns per-pass stats.
 */
export async function reconcileOrphans(
  db: HxDb,
  store: SessionStore,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const delay = opts.batchDelayMs ?? 200;
  const res: ReconcileResult = {
    scanned: 0,
    orphans: 0,
    restored: 0,
    skippedTombstoned: 0,
    deferred: 0,
    errors: 0,
    titlesCorrected: 0,
    staleIndexes: 0,
  };

  // Fast bulk gate: the natural keys the fortress already has a row for — parent
  // sessions and agent lanes alike, so neither is re-ingested once indexed.
  const parents = await db
    .select({
      ext: hxUsers.externalId,
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      bytesUploaded: hxSessions.bytesUploaded,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(isNull(hxSessions.deletedAt), INDEXED));
  const have = new Set(parents.map((r) => `${r.ext}/${r.family}/${r.sessionId}`));
  // What each indexed PARENT was built from, so a canonical that has grown past
  // its index can be recognised. Lanes stay existence-only for now.
  const indexedBytes = new Map(
    parents.map((r) => [`${r.ext}/${r.family}/${r.sessionId}`, Number(r.bytesUploaded ?? 0)]),
  );
  const agents = await db
    .select({
      ext: hxUsers.externalId,
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      agentId: hxSessionAgents.agentExternalId,
    })
    .from(hxSessionAgents)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(isNull(hxSessions.deletedAt), isNull(hxSessionAgents.deletedAt)));
  for (const r of agents) have.add(`${r.ext}/${r.family}/${r.sessionId}${AGENT_LANE}${r.agentId}`);

  const keys: CanonicalEntry[] = await store.listAllCanonicalKeys();
  // A parent (`baseSid`) sorts before its lanes (`baseSid:a:…`), so when both are
  // orphaned the parent is fully re-ingested (turns + real title) before a lane's
  // ingestAgentCommit would create a title-less parent stub that shadows it.
  keys.sort((a, b) => {
    const ka = `${a.userId}/${a.family}/${a.sessionId}`;
    const kb = `${b.userId}/${b.family}/${b.sessionId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Base session keys whose PARENT re-ingest threw this pass. ingestAgentCommit
  // inserts a title/turn-less parent stub when the parent row is absent, and that
  // stub would then enter the `have`/keyExists gate and block the parent's real
  // re-ingest forever (permanent content loss). So if a parent failed this pass,
  // defer its agent lanes — the parent (still orphaned) retries next sweep first.
  const failedParents = new Set<string>();
  for (const key of keys) {
    res.scanned += 1;
    if (opts.maxOrphans != null && opts.maxOrphans > 0 && res.restored >= opts.maxOrphans) break;
    const natural = `${key.userId}/${key.family}/${key.sessionId}`;
    // Set when this entry is being rebuilt because its index is BEHIND its
    // canonical rather than missing. The row exists by definition in that case,
    // so the ingest-time existence re-check below must not veto the repair.
    let staleRepair = false;
    if (have.has(natural)) {
      // The row exists — but does it cover the whole transcript? An index that is
      // BEHIND its canonical (a chunk whose commit failed while earlier ones
      // landed) is invisible to an existence check, and no sweep would ever find
      // it. Byte counts are only compared when the store reported one.
      const canonicalBytes = key.bytes;
      if (canonicalBytes == null || key.sessionId.includes(AGENT_LANE)) continue;
      if (indexedBytes.get(natural) === canonicalBytes) continue;
      res.staleIndexes += 1;
      if (!opts.repairStaleIndexes) continue;
      staleRepair = true; // fall through: rebuild it from the whole canonical
    }
    const laneIdx = key.sessionId.indexOf(AGENT_LANE);
    const baseSid = laneIdx >= 0 ? key.sessionId.slice(0, laneIdx) : key.sessionId;
    const baseKey = `${key.userId}/${key.family}/${baseSid}`;
    if (laneIdx >= 0 && failedParents.has(baseKey)) {
      res.deferred += 1; // parent failed this pass → defer the lane to the next sweep
      continue;
    }
    res.orphans += 1;
    try {
      // Re-check at ingest time so we don't redundantly rebuild a row that
      // Component C or a live upload created since the bulk gate was read
      // (idempotent, avoids wasted re-embeds). A stale repair is the one case
      // where the row is SUPPOSED to be there — skipping the check is the point.
      if (!staleRepair && (await keyExists(db, key))) continue;
      if (await isSessionDeleted(db, key.userId, key.sessionId)) {
        res.skippedTombstoned += 1;
        continue;
      }
      const chunkText = await store.readCanonicalText(key);
      const base = {
        chunkId: "reconcile",
        replace: true as const,
        chunkText,
        totalBytes: Buffer.byteLength(chunkText),
        componentCount: 1,
        meta: null,
        attribution: {
          orgExternalId: null,
          projectExternalId: null,
          repoSlug: null,
          deviceId: null,
        },
        recovered: true as const,
        // The reconciler has already decided this row must be rebuilt (missing,
        // content-less, or behind its canonical), so the recovered-write guard —
        // which exists to stop a restore clobbering a LIVE upload — must yield.
        rebuild: true as const,
      };
      if (laneIdx >= 0) {
        // Agent lane → the parent session key + the agentId.
        await ingestAgentCommit(db, {
          ...base,
          key: { userId: key.userId, family: key.family, sessionId: baseSid },
          agentId: key.sessionId.slice(laneIdx + AGENT_LANE.length),
        });
      } else {
        await ingestCommit(db, { ...base, key });
      }
      res.restored += 1;
    } catch (err) {
      // A parse failure, a missing canonical, or a transient DB/store error must
      // never abort the pass — the session is retried on the next scan.
      res.errors += 1;
      if (laneIdx < 0) failedParents.add(baseKey); // parent threw → defer its lanes this pass
      opts.logger?.warn?.("reconciler: skipped one orphan", {
        err: sanitizeDbError(err),
        sessionId: key.sessionId,
        family: key.family,
      });
    }
    if (delay > 0) await sleep(delay);
  }

  if (opts.correctExistingTitles !== false) {
    // A failure here must not discard the orphan-restore stats already gathered.
    try {
      const tc = await correctTitles(db, store, { sleep, logger: opts.logger });
      res.titlesCorrected = tc.corrected;
    } catch (err) {
      opts.logger?.warn?.("reconciler: title correction pass failed", { err: sanitizeDbError(err) });
    }
  }

  return res;
}
