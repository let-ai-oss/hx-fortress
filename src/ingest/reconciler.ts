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
import { and, eq, gt, isNull, sql as dsql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessionAgents, hxSessions } from "../host/postgres/schema/sessions";
import { hxTurns } from "../host/postgres/schema/transcript";
import { hxUsers } from "../host/postgres/schema/dimensions";
import type { CanonicalEntry, SessionKey, SessionStore } from "../modules/session-vault/store/types";
import { correctTitles } from "./correct-titles";
import { isSessionDeleted } from "./delete";
import { IndexAdvancedError, ingestAgentCommit, ingestCommit } from "./ingest";

const AGENT_LANE = ":a:";

export interface ReconcileOptions {
  /** Delay between orphan re-ingests, ms — paces store I/O + the embed queue. */
  batchDelayMs?: number;
  /** Cap on orphans re-ingested this pass (0/undefined = no cap). */
  maxOrphans?: number;
  /** Also run the title corrective pass (default true). */
  correctExistingTitles?: boolean;
  /** Re-ingest sessions whose indexed byte count no longer matches their
   *  canonical. Default TRUE — a session the fortress holds but has only half
   *  indexed is exactly what the guarantor exists to repair. The pass counts them
   *  either way, so turning this off leaves detection intact. */
  repairStaleIndexes?: boolean;
  /** Append only the missing tail instead of rebuilding the whole session, when
   *  the index is cleanly behind its canonical. Default true. Every tail repair
   *  is VERIFIED and escalated to a full rebuild if it did not land perfectly, so
   *  turning this off is a performance choice, never a correctness one. */
  repairTails?: boolean;
  /** Refuse to repair when the stale fraction exceeds this share of the corpus
   *  (default 0.25). A correct byte comparison flags a minority; a BROKEN one
   *  flags nearly everything, and mass re-ingest is the one outcome that must
   *  never happen by accident. The pass logs and reports instead. */
  staleRepairCeiling?: number;
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
  /** Repairs that appended only the missing tail. */
  repairedTail: number;
  /** Repairs that rebuilt the whole session from the canonical. */
  repairedFull: number;
  /** Tail repairs whose post-repair verification failed and were escalated to a
   *  full rebuild. A persistently non-zero value means the incremental path is
   *  mis-slicing and should be disabled (FORTRESS_GUARANTOR_TAIL_REPAIR=false). */
  verifyFallbacks: number;
  /** Sessions STILL not fully indexed after a full rebuild — the only outcome
   *  that leaves damage behind. Each one is logged with its id at error level. */
  integrityFailures: number;
  /** Tail repairs abandoned because a live commit advanced the lane while the
   *  sweep was working. Not damage and not an error — the live write is the more
   *  current truth, and the next pass re-checks. */
  liveRaces: number;
  /** Sessions whose PARENT lane has a hole in its seq — turns missing from the
   *  MIDDLE, which a byte comparison cannot see (bytes_uploaded still matches the
   *  canonical). Counted and repaired by full rebuild; a hole cannot be appended
   *  away. */
  gappedLanes: number;
  /** Sessions whose row exists but whose indexed byte count differs from the
   *  canonical the store holds — an index that is BEHIND its transcript, which
   *  the existence-only scan cannot see. Counted always; repaired only when
   *  repairStaleIndexes is on. */
  staleIndexes: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Proof that a session's PARENT lane is whole, not merely present.
 *
 *  Two independent facts, because either alone can be satisfied by damaged data:
 *  the row must claim the canonical's full byte count, AND the lane's seq must be
 *  dense (insertTurns assigns 0,1,2… after max(seq), so count === max+1 exactly
 *  when nothing is missing in the middle). A tail repair that mis-sliced shows up
 *  as a byte mismatch; a lost chunk in the middle shows up as a seq hole. */
async function verifyLane(
  db: HxDb,
  key: SessionKey,
  canonicalBytes: number | null,
  store?: SessionStore,
): Promise<{ ok: boolean; bytes: number; turns: number; dense: boolean }> {
  // Re-measure the canonical NOW. The size read at scan time can be minutes old,
  // and for a live session it is already wrong by the time a repair finishes.
  if (store) {
    try {
      const fresh = await store.statCanonical(key);
      if (fresh != null) canonicalBytes = fresh;
    } catch {
      // keep the scan-time size — a stat failure must not fail the verification
    }
  }
  const [row] = await db
    .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(
      and(
        eq(hxUsers.externalId, key.userId),
        eq(hxSessions.family, key.family),
        eq(hxSessions.sessionId, key.sessionId),
        isNull(hxSessions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, bytes: 0, turns: 0, dense: false };
  const [agg] = await db
    .select({
      n: dsql<number>`count(*)::int`,
      maxSeq: dsql<number>`coalesce(max(${hxTurns.seq}), -1)::int`,
    })
    .from(hxTurns)
    .where(and(eq(hxTurns.sessionId, row.id), isNull(hxTurns.agentId)));
  const turns = Number(agg?.n ?? 0);
  const dense = turns === Number(agg?.maxSeq ?? -1) + 1;
  const bytes = Number(row.bytes ?? 0);
  // A session that is still being written grows UNDER the sweep: a live chunk can
  // land between the repair and this check, leaving the row legitimately AHEAD of
  // whatever the canonical measured when the pass started. Complete means "covers
  // the canonical", not "equals a number captured minutes ago" — so >= passes, and
  // only genuinely BEHIND counts as incomplete.
  const bytesOk = canonicalBytes == null || bytes >= canonicalBytes;
  return { ok: bytesOk && dense, bytes, turns, dense };
}

/** Below this many stale sessions the ceiling never applies: a handful of rows
 *  is a repair job, not a stampede, and refusing it would strand small fortresses
 *  permanently. */
const STALE_CEILING_MIN_COUNT = 50;

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
    gappedLanes: 0,
    liveRaces: 0,
    repairedTail: 0,
    repairedFull: 0,
    verifyFallbacks: 0,
    integrityFailures: 0,
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

  // Turns missing from the MIDDLE of a lane are invisible to the byte
  // comparison: bytes_uploaded still matches the canonical, so the session looks
  // complete while it is not. insertTurns assigns seq densely from 0, so
  // count <> max(seq)+1 is exactly a hole. One grouped aggregate over the unique
  // (session_id, agent_id, seq) index answers it for the whole corpus.
  const gapped = new Set<string>();
  try {
    const holes = await db
      .select({ ext: hxUsers.externalId, family: hxSessions.family, sessionId: hxSessions.sessionId })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .innerJoin(hxTurns, and(eq(hxTurns.sessionId, hxSessions.id), isNull(hxTurns.agentId)))
      .where(isNull(hxSessions.deletedAt))
      .groupBy(hxUsers.externalId, hxSessions.family, hxSessions.sessionId)
      .having(dsql`count(*) <> max(${hxTurns.seq}) + 1`);
    for (const h of holes) gapped.add(`${h.ext}/${h.family}/${h.sessionId}`);
  } catch (err) {
    // Never let the integrity sweep take the whole pass down with it.
    opts.logger?.warn?.("reconciler: seq-gap scan failed", { err: sanitizeDbError(err) });
  }
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

  // Decide ONCE, before touching anything, whether stale repair runs this pass.
  // The comparison is cheap (both sides are already in memory), and knowing the
  // total up front is what makes the ceiling meaningful: a byte comparison that
  // regresses flags nearly the whole corpus, and re-ingesting all of it would be
  // far worse than the damage being repaired.
  const staleTotal = keys.reduce((n, k) => {
    if (k.bytes == null || k.sessionId.includes(AGENT_LANE)) return n;
    const nat = `${k.userId}/${k.family}/${k.sessionId}`;
    if (!have.has(nat)) return n;
    return (indexedBytes.get(nat) ?? 0) < k.bytes ? n + 1 : n;
  }, 0);
  const ceiling = opts.staleRepairCeiling ?? 0.25;
  const wantRepair = opts.repairStaleIndexes ?? true;
  // The ceiling guards against ONE thing: a byte comparison that regressed and
  // now flags the whole corpus, where repairing would re-ingest everything. A
  // ratio alone cannot express that — on a small fortress two stale sessions out
  // of three read as 67% and would be refused forever, leaving exactly the
  // sessions the guarantor exists to fix. So the ratio only applies once the
  // absolute count is large enough for "mass re-ingest" to mean anything.
  const repairStale =
    wantRepair &&
    (staleTotal < STALE_CEILING_MIN_COUNT ||
      keys.length === 0 ||
      staleTotal / keys.length <= ceiling);
  if (wantRepair && !repairStale) {
    opts.logger?.warn?.("reconciler: stale-index repair SKIPPED — implausible share of the corpus", {
      staleTotal,
      scanned: keys.length,
      ceiling,
    });
  }
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
    let alreadyIndexedBytes = 0;
    if (have.has(natural)) {
      // The row exists — but does it cover the whole transcript? An index that is
      // BEHIND its canonical (a chunk whose commit failed while earlier ones
      // landed) is invisible to an existence check, and no sweep would ever find
      // it. Byte counts are only compared when the store reported one.
      const canonicalBytes = key.bytes ?? null;
      if (key.sessionId.includes(AGENT_LANE)) continue;
      const holed = gapped.has(natural);
      if (holed) res.gappedLanes += 1;
      // Only BEHIND is damage. A live session can legitimately run ahead of the
      // size captured when this pass started, and rebuilding it for that would
      // re-index a healthy session every sweep — churn that looks like repair.
      const behind =
        canonicalBytes != null && (indexedBytes.get(natural) ?? 0) < canonicalBytes;
      if (!holed && !behind) continue;
      if (behind) res.staleIndexes += 1;
      if (!repairStale) continue;
      staleRepair = true;
      // A hole in the middle cannot be appended away — force the full rebuild.
      alreadyIndexedBytes = holed ? 0 : (indexedBytes.get(natural) ?? 0);
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
        res.restored += 1;
        res.repairedFull += 1;
      } else {
        const canonicalBytes = key.bytes ?? Buffer.byteLength(chunkText);

        // FAST PATH — append just the missing tail. Only when the index is
        // cleanly behind: a positive prefix, strictly shorter than the canonical,
        // ending exactly on a record boundary. JSONL means a prefix that does not
        // end at a newline would slice a record in half, and half a record is the
        // gap this must never create — so that case takes the slow path instead.
        let landed = false;
        const buf = Buffer.from(chunkText, "utf8");
        const canAppendTail =
          (opts.repairTails ?? true) &&
          staleRepair &&
          alreadyIndexedBytes > 0 &&
          alreadyIndexedBytes < buf.length &&
          buf[alreadyIndexedBytes - 1] === 0x0a;
        if (canAppendTail) {
          let advanced = false;
          try {
            await ingestCommit(db, {
              ...base,
              key,
              chunkId: "reconcile-tail", // distinguishable in hx.ingest_events
              replace: false,
              chunkText: buf.subarray(alreadyIndexedBytes).toString("utf8"),
              totalBytes: canonicalBytes,
              // …only if the lane is still exactly where the slice was cut.
              expectIndexedBytes: alreadyIndexedBytes,
            });
          } catch (err) {
            if (!(err instanceof IndexAdvancedError)) throw err;
            // A live commit beat us to it. Never append from a stale offset —
            // that duplicates turns, and a duplicated lane is still dense and
            // still covers the canonical, so nothing downstream would catch it.
            advanced = true;
            res.liveRaces += 1;
            opts.logger?.info?.("reconciler: session advanced under the sweep — deferring to the live write", {
              sessionId: key.sessionId,
              family: key.family,
              slicedFrom: err.expected,
              nowIndexed: err.actual,
            });
          }
          if (advanced) { if (delay > 0) await sleep(delay); continue; }
          // VERIFY — never trust the fast path. Bytes prove it covers the whole
          // canonical; seq density proves it left no hole behind.
          const v = await verifyLane(db, key, canonicalBytes, store);
          if (v.ok) {
            landed = true;
            res.repairedTail += 1;
          } else {
            res.verifyFallbacks += 1;
            opts.logger?.warn?.("reconciler: tail repair did not verify — rebuilding in full", {
              sessionId: key.sessionId,
              family: key.family,
              indexedBytes: v.bytes,
              canonicalBytes,
              turns: v.turns,
              dense: v.dense,
            });
          }
        }

        // SLOW PATH — rebuild the whole lane from the canonical. Either the tail
        // was not safely sliceable, or it was and did not verify.
        if (!landed) {
          await ingestCommit(db, { ...base, key });
          const v = await verifyLane(db, key, canonicalBytes, store);
          if (v.ok) {
            res.repairedFull += 1;
          } else {
            // The one outcome that leaves damage behind. Named loudly, with the
            // id, so it is greppable in logs and joinable in the database.
            res.integrityFailures += 1;
            opts.logger?.warn?.("reconciler: SESSION STILL INCOMPLETE after a full rebuild", {
              sessionId: key.sessionId,
              family: key.family,
              indexedBytes: v.bytes,
              canonicalBytes,
              turns: v.turns,
              dense: v.dense,
            });
          }
        }
        res.restored += 1;
      }
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
