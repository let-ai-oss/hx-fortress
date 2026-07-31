// Moving a fortress's object storage to another bucket, without losing a write.
//
// The hard part is not the copy. It is the CUT: the moment credentials.json
// stops naming the old bucket and starts naming the new one, while clients are
// uploading. Everything below exists to make that moment provably quiet, and to
// keep it short enough that a paused fortress is a hiccup rather than an outage.
//
// The order, and why each step is where it is:
//
//   COPY, THEN DELTA, WHILE INGEST RUNS. The bulk copy takes as long as it
//   takes; nothing is held during it. Repeated delta passes then narrow the set
//   of objects that changed since, so the amount of work left to do inside the
//   pause approaches zero before anything is armed.
//
//   THE DRAIN PHASE COMES BEFORE THE PAUSE. A presigned PUT lands in the bucket
//   directly, invisible to this process — so a pause cannot stop it and a
//   counter cannot see it. The drain engages the short-TTL floor for NEW
//   signatures and then keeps running delta passes until every long-lived
//   signature minted before it has expired. Only then is a pause armed, which
//   is what bounds arm→swap to seconds rather than to the staging TTL. Ingest
//   keeps running throughout: the drain costs latency on nobody.
//
//   THE BARRIER PROVES QUIET; THE FENCE PROVES IT IS STILL TRUE. The barrier
//   waits for in-flight work AND outstanding signatures. The fence re-checks the
//   pause deadline immediately before the swap, because a barrier that took
//   longer than expected can hand back a "quiet" that the gate has already
//   stopped enforcing.
//
//   THE SOURCE IS NEVER DELETED. Not at the end, not on success, not as
//   cleanup. The old bucket IS the rollback, and a migration that removed it
//   would be a migration nobody can undo. There is no delete call against the
//   source anywhere in this file, and a test asserts the absence rather than
//   trusting the sentence.

import { createHash } from "node:crypto";

import { awaitQuiesced, type IngestQuiesce } from "./pause-gate";
import { STAGING_PUT_TTL_S } from "../modules/session-vault/store/limits";
import type { SessionKey, SessionStore } from "../modules/session-vault/store/types";

/** What a run is allowed to do. `plan` writes nothing at all; `copy` moves the
 *  objects and stops before the cut; `switch` goes all the way. */
export type MigrationMode = "plan" | "copy" | "switch";

export type MigrationPhase =
  | "planning"
  | "provisioning"
  | "copying"
  | "delta"
  | "draining"
  | "quiescing"
  | "switching"
  | "verifying"
  | "done"
  | "aborted";

/** The sidecar names a session can carry. Copied alongside the canonical: an
 *  object that exists in the source and not in the target after the cut is a
 *  loss, whatever its name. */
export const MIGRATION_ARTIFACTS: readonly string[] = ["session.json", "tasks.json", "plan.json"];

/** How long the pause is armed for the cut. Deliberately far inside the daemon's
 *  own pause cap: this is a barrier plus a final delta, not a maintenance
 *  window. */
export const SWAP_PAUSE_MS = 5 * 60_000;

/** How long the barrier may wait for quiet before the run gives up and resumes
 *  without swapping. */
export const BARRIER_MS = 2 * 60_000;

/** The margin the pre-swap fence demands. A swap that begins with less pause
 *  left than this can finish after writes have reopened. */
export const FENCE_MARGIN_MS = 30_000;

/** Delta passes before the engine stops narrowing and moves on. A source under
 *  constant write never converges to zero, and the drain plus the pause are what
 *  close the remaining gap. */
export const MAX_DELTA_PASSES = 8;

export interface MigrationEvent {
  phase: MigrationPhase;
  message: string;
  copied?: number;
  total?: number;
  bytes?: number;
}

export interface CopiedObject {
  key: SessionKey;
  checksum: string;
  bytes: number;
}

export interface MigrationResult {
  mode: MigrationMode;
  phase: MigrationPhase;
  sessionsTotal: number;
  sessionsCopied: number;
  bytesCopied: number;
  deltaPasses: number;
  switched: boolean;
  /** The credentials version the swap wrote, when it swapped. */
  version: number | null;
  aborted: string | null;
}

export interface MigrationDeps {
  mode: MigrationMode;
  /** The LIVE store — pause-gated, and the one clients are writing to. */
  source: SessionStore;
  /** The candidate, built directly from the new credentials. Deliberately NOT
   *  pause-gated: its self-test writes a probe object, and the source's pause is
   *  no reason to refuse a write to a bucket nobody is reading yet. */
  target: SessionStore;
  /** Sessions this fortress has permanently deleted. Replayed against the
   *  target, because a copy made before a delete would otherwise resurrect it. */
  tombstones: () => Promise<SessionKey[]>;
  quiesce: IngestQuiesce;
  /** Engage (or release) the short-TTL floor for new staging signatures. */
  armDrain: (on: boolean) => void;
  /** Arm the ingest pause; returns the episode id the resume needs. */
  armPause: (until: Date, reason: string) => Promise<string>;
  resumeIngest: (episodeId: string) => Promise<void>;
  /** Write the new storage block into credentials.json through the single CAS
   *  door, and return the version it advanced to. */
  swapCredentials: () => Promise<number>;
  /** Re-bind the live store onto the swapped credentials. The SAME factory
   *  init() uses — a bare backend here would be a store with no pause gate, no
   *  deadlines and no rebuild policy, from the cut onward. */
  rebindStore: () => Promise<void>;
  /** Record one copied session, so a resume can skip it. */
  recordCopied?: (object: CopiedObject) => Promise<void>;
  /** Sessions a previous run already proved. Skipped unless the target
   *  disagrees. */
  alreadyCopied?: () => Promise<ReadonlySet<string>>;
  onEvent?: (event: MigrationEvent) => void;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  artifacts?: readonly string[];
  swapPauseMs?: number;
  barrierMs?: number;
  maxDeltaPasses?: number;
}

export function sessionRef(key: SessionKey): string {
  return [key.userId, key.family, key.sessionId].join("/");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Copy one session, and prove it landed.
 *
 * The checksum is taken from what the TARGET returns, not from what was sent: a
 * write that silently truncated, or a bucket that accepted and stored something
 * else, is exactly the failure a migration must not carry forward. A mismatch
 * throws, and the run aborts rather than continuing over a target it can no
 * longer trust.
 */
export async function copySession(
  source: SessionStore,
  target: SessionStore,
  key: SessionKey,
  artifacts: readonly string[] = MIGRATION_ARTIFACTS,
): Promise<CopiedObject> {
  const text = await source.readCanonicalText(key);
  await target.writeCanonicalText(key, text);
  const landed = await target.readCanonicalText(key);
  const checksum = sha256(text);
  if (sha256(landed) !== checksum) {
    throw new Error(
      `checksum mismatch after copying ${sessionRef(key)} — the target holds different bytes`,
    );
  }
  for (const name of artifacts) {
    const artifact = await source.readArtifactText(key, name).catch(() => null);
    if (artifact === null) continue;
    await target.writeArtifact(key, name, artifact);
  }
  return { key, checksum, bytes: Buffer.byteLength(text) };
}

/**
 * Run one storage migration.
 *
 * Idempotent by construction: every phase re-derives its work from the two
 * stores rather than from where the last run stopped, so a resumed run copies
 * what is missing and skips what is already proven.
 */
export async function runStorageMigration(deps: MigrationDeps): Promise<MigrationResult> {
  const clock = deps.clock ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const artifacts = deps.artifacts ?? MIGRATION_ARTIFACTS;
  const emit = (event: MigrationEvent): void => deps.onEvent?.(event);

  const result: MigrationResult = {
    mode: deps.mode,
    phase: "planning",
    sessionsTotal: 0,
    sessionsCopied: 0,
    bytesCopied: 0,
    deltaPasses: 0,
    switched: false,
    version: null,
    aborted: null,
  };

  const plan = await deps.source.listAllCanonicalKeys();
  result.sessionsTotal = plan.length;
  emit({ phase: "planning", message: `${plan.length} session(s) to move`, total: plan.length });
  if (deps.mode === "plan") {
    result.phase = "done";
    return result;
  }

  // The target's OWN self-test, before anything is copied into it. Exempt from
  // the source's pause gate by construction — this store is not that store.
  result.phase = "provisioning";
  emit({ phase: "provisioning", message: "proving the target bucket accepts a write" });
  await deps.target.selfTest();

  const done = new Set(await (deps.alreadyCopied?.() ?? Promise.resolve(new Set<string>())));

  const copyMissing = async (keys: readonly SessionKey[], phase: MigrationPhase): Promise<number> => {
    let copied = 0;
    for (const key of keys) {
      const ref = sessionRef(key);
      if (done.has(ref)) {
        // Proven by a previous run — but only if the target still agrees. A
        // record without an object is a record about a bucket somebody emptied.
        const bytes = await deps.target.statCanonical(key);
        if (bytes !== null) continue;
      }
      const object = await copySession(deps.source, deps.target, key, artifacts);
      done.add(ref);
      copied += 1;
      result.sessionsCopied += 1;
      result.bytesCopied += object.bytes;
      await deps.recordCopied?.(object);
      emit({
        phase,
        message: `copied ${ref}`,
        copied: result.sessionsCopied,
        total: result.sessionsTotal,
        bytes: result.bytesCopied,
      });
    }
    return copied;
  };

  result.phase = "copying";
  await copyMissing(plan, "copying");

  /** One narrowing pass: whatever the source has that the target does not. */
  const deltaPass = async (phase: MigrationPhase): Promise<number> => {
    result.deltaPasses += 1;
    const keys = await deps.source.listAllCanonicalKeys();
    result.sessionsTotal = Math.max(result.sessionsTotal, keys.length);
    const missing: SessionKey[] = [];
    for (const key of keys) {
      if (await deps.target.statCanonical(key)) continue;
      missing.push(key);
    }
    if (missing.length > 0) {
      // Re-copied because the target lacks them, whatever a previous run
      // recorded.
      for (const key of missing) done.delete(sessionRef(key));
      await copyMissing(missing, phase);
    }
    return missing.length;
  };

  result.phase = "delta";
  const maxPasses = deps.maxDeltaPasses ?? MAX_DELTA_PASSES;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    emit({ phase: "delta", message: `delta pass ${pass + 1}` });
    if ((await deltaPass("delta")) === 0) break;
  }

  if (deps.mode === "copy") {
    result.phase = "done";
    emit({ phase: "done", message: "objects copied; credentials still name the source bucket" });
    return result;
  }

  // ── The drain: run off every signature the bucket will still honour ────────
  result.phase = "draining";
  deps.armDrain(true);
  try {
    // Read AFTER arming, so a signature minted in the same instant is included.
    const runOff = deps.quiesce.signatureFloor.getTime();
    emit({
      phase: "draining",
      message:
        runOff > clock().getTime()
          ? `waiting out signatures valid until ${new Date(runOff).toISOString()}`
          : "no long-lived signature outstanding",
    });
    // Deltas keep running through the run-off, so the work left inside the pause
    // stays small. Ingest is untouched: nothing is armed yet.
    while (clock().getTime() < runOff) {
      await deltaPass("draining");
      await sleep(1_000);
    }

    // ── The pause, the barrier and the fence ────────────────────────────────
    result.phase = "quiescing";
    const pauseMs = deps.swapPauseMs ?? SWAP_PAUSE_MS;
    const pausedUntil = new Date(clock().getTime() + pauseMs);
    const episode = await deps.armPause(pausedUntil, "storage migration swap");
    try {
      const barrierDeadline = new Date(
        Math.min(pausedUntil.getTime(), clock().getTime() + (deps.barrierMs ?? BARRIER_MS)),
      );
      emit({ phase: "quiescing", message: "waiting for in-flight writes and signatures" });
      const quiet = await awaitQuiesced({
        quiesce: deps.quiesce,
        deadline: barrierDeadline,
        clock,
        sleep,
      });
      if (!quiet) {
        result.phase = "aborted";
        result.aborted =
          "the store did not go quiet before the barrier deadline — nothing was switched";
        return result;
      }

      // The final delta and the tombstone replay run INSIDE the pause, where the
      // source cannot change under them.
      await deltaPass("quiescing");
      await replayTombstones(deps, emit);

      // The fence. Between the barrier and here, time passed; if the pause is
      // close to lapsing, the swap would land after writes reopened.
      if (pausedUntil.getTime() - clock().getTime() < FENCE_MARGIN_MS) {
        result.phase = "aborted";
        result.aborted =
          "the pause window was nearly spent before the swap could start — nothing was switched";
        return result;
      }

      // ── The cut ────────────────────────────────────────────────────────────
      result.phase = "switching";
      emit({ phase: "switching", message: "pointing this fortress at the target bucket" });
      result.version = await deps.swapCredentials();
      await deps.rebindStore();
      result.switched = true;

      result.phase = "verifying";
      const missing = await verifyTarget(deps);
      if (missing.length > 0) {
        // The swap already happened, so this is a report and not a rollback: the
        // source is untouched and still holds everything, which is what makes
        // going back a credentials change rather than a recovery.
        result.aborted = `${missing.length} session(s) are not readable in the new bucket: ${missing
          .slice(0, 5)
          .map(sessionRef)
          .join(", ")}`;
      }
      result.phase = "done";
      emit({ phase: "done", message: "the fortress is serving from the target bucket" });
      return result;
    } finally {
      await deps.resumeIngest(episode).catch(() => {});
    }
  } finally {
    deps.armDrain(false);
  }
}

/**
 * Replay permanent deletes against the target.
 *
 * A session deleted after its copy was made is present in the target and absent
 * from the source, which is a resurrection: the delete happened, and the cut
 * would undo it. Run before the final delta AND inside the pause, because a
 * delete can land between the two.
 */
async function replayTombstones(
  deps: MigrationDeps,
  emit: (event: MigrationEvent) => void,
): Promise<number> {
  const tombstones = await deps.tombstones();
  let removed = 0;
  for (const key of tombstones) {
    if ((await deps.target.statCanonical(key)) === null) continue;
    // Against the TARGET only. The source keeps whatever it keeps.
    await deps.target.deleteSession(key);
    removed += 1;
    emit({ phase: "quiescing", message: `replayed a permanent delete onto the target: ${sessionRef(key)}` });
  }
  return removed;
}

/** Everything the source holds that the new binding cannot read. Re-listed
 *  rather than taken from the run's own counters: the question is what the
 *  fortress can serve now, and only the bucket can answer it. */
async function verifyTarget(deps: MigrationDeps): Promise<SessionKey[]> {
  const keys = await deps.source.listAllCanonicalKeys();
  const missing: SessionKey[] = [];
  for (const key of keys) {
    if ((await deps.target.statCanonical(key)) === null) missing.push(key);
  }
  return missing;
}

/** The staging TTL a drain has to run off, stated where the engine reads it so
 *  the two cannot drift. */
export const DRAIN_RUNOFF_S = STAGING_PUT_TTL_S;
