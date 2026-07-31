// Wiring one storage migration to a live fortress: its two buckets, its pause
// plane, its credentials file and its run record.
//
// Kept apart from the engine for the reason the audit runner is: the engine's
// ORDER — copy, delta, drain, barrier, fence, cut — is the part that has to be
// provable, and it stays testable without a bucket, a database or a credential.
//
// Three commands, one lifecycle:
//
//   ARM copies, then engages the short-TTL floor. It is where the long work
//   happens and where nothing is held: ingest runs at full speed throughout, and
//   the floor engages only at the END, so the signatures minted at the old TTL
//   run off while the operator reads the result rather than inside the swap.
//
//   SWAP is the cut, and it is short by construction because ARM already paid
//   for the run-off. It refuses rather than cuts whenever the store did not go
//   quiet or the pause was nearly spent.
//
//   RESUME is the way back out: it releases the floor and clears the pause
//   episode, whether or not anything was switched. Resuming an interrupted COPY
//   is not this — that is ARM again, which re-derives its work from the two
//   buckets and skips what the target already holds.
//
// THE FLOOR HAS ONE OWNER. The engine may raise it and never lowers it: a swap
// that refused is a swap the operator will retry, and lowering the floor would
// charge that retry the whole staging TTL a second time. It is lowered here, on
// a completed cut and on resume. It also lives in memory, so a daemon restart
// clears it — which is the bound on an arm nobody ever followed up.

import { sql } from "drizzle-orm";

import { armPause, readCurrentEpisode, resumeIngest } from "./ingest-control-db";
import {
  copiedSessions,
  findResumableRun,
  noteMigrationPhase,
  recordCopiedObject,
  saveMigrationRun,
  startMigrationRun,
} from "./migration-store";
import { runStorageMigration, type MigrationDeps, type MigrationResult } from "./migration";
import { envManagedRefusal } from "./rotation";
import {
  readVaultCredentials,
  updateVaultCredentials,
  type VaultCredentials,
} from "../modules/session-vault/credentials";
import type { IngestQuiesce } from "./pause-gate";
import type { HxDb } from "../host/postgres/db";
import type { ScopedLogger } from "../host/types";
import type { SessionKey, SessionStore } from "../modules/session-vault/store/types";

/** The three commands a console can send. Not the engine's phases: those name
 *  where one run got to, these name what the operator asked for. */
export const MIGRATION_COMMANDS = ["arm", "swap", "resume"] as const;
export type MigrationCommand = (typeof MIGRATION_COMMANDS)[number];

export function isMigrationCommand(value: unknown): value is MigrationCommand {
  return typeof value === "string" && (MIGRATION_COMMANDS as readonly string[]).includes(value);
}

export interface MigrationRunnerDeps {
  db: () => HxDb | null;
  /** The LIVE binding — pause-gated, and the one clients are writing to. */
  store: () => SessionStore | null;
  /** Build the candidate from the target credentials. The DIRECT backend, not
   *  the serving one: this store is written by the migration alone, and a
   *  wedge-escalating candidate could exit the daemon over a bucket nothing is
   *  serving from yet. */
  buildTarget: (credentials: VaultCredentials) => SessionStore;
  /** The counter and the signature floor the pre-swap barrier waits on. */
  quiesce: IngestQuiesce;
  /** Engage or release the short-TTL floor for NEW staging signatures. */
  setDrain: (on: boolean) => void;
  /** Swap the live store binding onto the swapped credentials — the SAME
   *  factory init() uses, so the gate, the deadlines and the rebuild policy
   *  survive the cut. */
  rebindStore: () => Promise<void>;
  /** The target's storage block, from the command's single-use file. Null when
   *  the reference was already consumed, expired or unreadable. */
  targetCredentials: () => Promise<VaultCredentials | null>;
  /** The process environment, for the env-managed refusal. */
  env: Record<string, string | undefined>;
  logger: ScopedLogger;
}

export interface MigrationCommandArgs {
  command: MigrationCommand;
  /** The target bucket the operator NAMED, as it reached the row. Checked
   *  against the credential file so the run record and the audit trail carry a
   *  bucket the secret actually points at. */
  target: string | null;
}

/** Sessions this fortress has permanently deleted. Replayed onto the target,
 *  because a copy taken before a delete would otherwise resurrect it: the
 *  tombstone refuses a re-UPLOAD and says nothing about an object a migration
 *  put there. */
export async function migrationTombstones(db: HxDb): Promise<SessionKey[]> {
  const result = await db.execute(
    sql`SELECT user_external_id AS "userId", family, session_id AS "sessionId"
          FROM hx.deleted_sessions`,
  );
  const raw: unknown = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows;
  const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return list.map((row) => ({
    userId: String(row.userId ?? ""),
    family: String(row.family ?? ""),
    sessionId: String(row.sessionId ?? ""),
  }));
}

/** What the operator reads back. Identifiers and counts only — a bucket name is
 *  a fact somebody needs; a key never is. */
export function describeMigration(result: MigrationResult, targetBucket: string): string {
  const moved =
    `${result.sessionsCopied} of ${result.sessionsTotal} session(s) copied to ${targetBucket}, ` +
    `${Math.round(result.bytesCopied / 1024)} KiB over ${result.deltaPasses} delta pass(es)`;
  if (!result.switched) {
    return result.aborted ? `${moved} — nothing was switched: ${result.aborted}` : moved;
  }
  const version = `credentials.json is at version ${result.version ?? 0}`;
  return result.aborted
    ? `switched to ${targetBucket} (${version}), but the new bucket did not verify: ${result.aborted}`
    : `switched to ${targetBucket}; ${version}; the source bucket is untouched and is the way back`;
}

/**
 * Run one storage-migration command against this fortress.
 *
 * Returns the sentence the console renders as the outcome, and throws with the
 * one it renders as the failure. Neither is invented by the console.
 */
export async function runMigrationCommand(
  deps: MigrationRunnerDeps,
  args: MigrationCommandArgs,
): Promise<string> {
  const db = deps.db();
  if (!db) {
    throw new Error("the fortress database is not available, so a migration cannot be recorded");
  }

  if (args.command === "resume") {
    deps.setDrain(false);
    const episode = await readCurrentEpisode(db);
    if (!episode || episode.resumedAt !== null) {
      return "staging signatures are back to their normal lifetime; no pause was armed";
    }
    await resumeIngest(db, episode.id);
    return `ingest resumed (episode ${episode.id}); staging signatures are back to their normal lifetime`;
  }

  // An env-managed fortress rebuilds credentials.json from the environment on
  // every boot, so the cut would be discarded by the next restart while the
  // objects sat in the new bucket. Refused BEFORE anything is copied: the point
  // is not to spend hours on a move that cannot land.
  if (deps.env.FORTRESS_STORAGE_BUCKET?.trim()) throw new Error(envManagedRefusal("storage"));

  const source = await readVaultCredentials();
  if (!source) {
    throw new Error("this fortress has no storage credentials yet — run the enroll wizard first");
  }
  const target = await deps.targetCredentials();
  if (!target) {
    throw new Error(
      "the migration target's credentials were already consumed, expired or unreadable — re-issue them",
    );
  }
  if (args.target && args.target !== target.bucket) {
    // The row names a bucket and the credential file names a bucket. A run whose
    // record disagrees with what it actually wrote is a record nobody can audit.
    throw new Error(
      `the requested target bucket (${args.target}) is not the one these credentials name`,
    );
  }
  if (target.store === source.store && target.bucket === source.bucket) {
    throw new Error("the target names the bucket this fortress already serves from");
  }
  const live = deps.store();
  if (!live) throw new Error("the object store is not initialized on this fortress");

  // One run per bucket PAIR, continued rather than restarted: what the arm
  // already proved is what the swap gets to skip.
  const runId =
    (await findResumableRun(db, { sourceBucket: source.bucket, targetBucket: target.bucket })) ??
    (await startMigrationRun(db, {
      mode: args.command,
      sourceBucket: source.bucket,
      targetBucket: target.bucket,
    }));

  let lastPhase = "";
  const engine: MigrationDeps = {
    // ARM stops before the cut by construction rather than by a flag checked
    // late: `copy` returns after the delta passes and never reaches the drain.
    mode: args.command === "arm" ? "copy" : "switch",
    source: live,
    target: deps.buildTarget(target),
    tombstones: () => migrationTombstones(db),
    quiesce: deps.quiesce,
    // Raise-only: see the latch note at the top of this file.
    armDrain: (on) => {
      if (on) deps.setDrain(true);
    },
    armPause: (until, reason) => armPause(db, { until, reason, armedBy: "storage migration" }),
    resumeIngest: (episodeId) => resumeIngest(db, episodeId),
    swapCredentials: async () => {
      // THE single door for credentials.json: the O_EXCL lock, the version CAS
      // and the version BUMP the console's live reader watches for. A direct
      // write here would race the rotation executor and the headless bootstrap,
      // and would leave the console signing with a key nobody honours any more.
      const written = await updateVaultCredentials((existing) => ({
        ...target,
        // The embedding key lives in the same file and belongs to neither
        // bucket. A whole-file write is exactly what would drop it.
        ...(existing?.openaiApiKey ? { openaiApiKey: existing.openaiApiKey } : {}),
      }));
      return written.version;
    },
    rebindStore: deps.rebindStore,
    recordCopied: (object) => recordCopiedObject(db, runId, object),
    alreadyCopied: () => copiedSessions(db, runId),
    onEvent: (event) => {
      if (event.phase !== lastPhase) {
        lastPhase = event.phase;
        // Best-effort and unawaited: the run's phase is how the console follows
        // along, and a database hiccup must not abort a migration mid-copy.
        void noteMigrationPhase(db, runId, event.phase).catch(() => {});
      }
      deps.logger.info("storage migration", {
        run: runId,
        phase: event.phase,
        message: event.message,
      });
    },
  };

  let result: MigrationResult;
  try {
    result = await runStorageMigration(engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The run stays OPEN: the objects already in the target are the expensive
    // part, and the next command has to be able to find them.
    await saveMigrationRun(db, runId, { result: null, error: message, finished: false }).catch(
      () => {},
    );
    throw error;
  }

  if (args.command === "arm") {
    // The floor engages HERE, after the copy rather than before it: the bulk
    // move runs at the normal signature lifetime, and the run-off it costs is
    // spent while the operator decides instead of inside the swap.
    deps.setDrain(true);
  } else if (result.switched) {
    // Cut over — there is nothing left for a barrier to wait out.
    deps.setDrain(false);
  }

  await saveMigrationRun(db, runId, {
    result,
    error: null,
    // Only a completed cut ends the run. A copy and a refused swap both leave it
    // open for the command that comes next.
    finished: result.switched,
  });
  const outcome = describeMigration(result, target.bucket);
  return args.command === "arm"
    ? `${outcome}; new staging signatures are short-lived — swap when ready`
    : outcome;
}
