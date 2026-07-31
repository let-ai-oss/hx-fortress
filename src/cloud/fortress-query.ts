// Bounded questions the daemon asks the hub, and the cache that keeps the answer
// honest between asks.
//
// Two facts the fortress cannot establish alone: how ingest is currently reaching
// it (the hub decides whether traffic goes over the reverse tunnel or straight at
// the gateway), and whether a historical let.ai copy exists for a session. Both
// have to be asked for, over the one connection there is.
//
// EVERY failure mode collapses to "unavailable", and that is load-bearing. A hub
// too old to understand the question simply never answers — no error frame, no
// close, just silence — so a request that could hang would hang forever on every
// fortress talking to an unupgraded hub, and one that defaulted to a value would
// report a routing posture nobody asserted. Unavailable is the only answer that
// is true in all three cases (timeout, transport gone, old hub), and downstream
// it renders as NOT CHECKED rather than as a clean verdict.
//
// The envelope types are declared here rather than imported: the protocol package
// places the three fortressQuery frames on the hub→fortress union, while the
// asking side is the daemon. The discriminators and the payload types below are
// the package's, so the bytes on the wire are the ones it names.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FortressQueryPayload, FortressQueryResultPayload } from "../protocol";

/** How long one question may stay outstanding. Well inside any caller's own
 *  budget: an unanswered query must degrade to "unavailable" while the caller is
 *  still there to render it. */
export const FORTRESS_QUERY_TIMEOUT_MS = 10_000;

/** Concurrent questions allowed. The audit path already serializes its batches;
 *  this bounds everything else, so a stuck hub cannot accumulate promises. */
export const MAX_IN_FLIGHT_QUERIES = 8;

export interface FortressQueryFrame {
  t: "fortressQuery";
  id: string;
  query: FortressQueryPayload;
}

export interface FortressQueryResultFrame {
  t: "fortressQueryResult";
  id: string;
  result: FortressQueryResultPayload;
}

export interface FortressQueryErrorFrame {
  t: "fortressQueryError";
  id: string;
  error: string;
}

export type FortressQueryAnswerFrame = FortressQueryResultFrame | FortressQueryErrorFrame;

export function isFortressQueryAnswer(frame: { t: string }): frame is FortressQueryAnswerFrame {
  return frame.t === "fortressQueryResult" || frame.t === "fortressQueryError";
}

/** Distinguishable from a hub that answered "no": a caller must never render an
 *  absent answer as a negative one. */
export class FortressQueryUnavailable extends Error {
  constructor(
    readonly cause_: "timeout" | "offline" | "closed" | "saturated" | "error",
    detail?: string,
  ) {
    super(detail ? `fortress query unavailable (${cause_}): ${detail}` : `fortress query unavailable (${cause_})`);
    this.name = "FortressQueryUnavailable";
  }
}

interface Pending {
  resolve: (result: FortressQueryResultPayload) => void;
  reject: (err: FortressQueryUnavailable) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates outbound questions with inbound answers.
 *
 * Held OUTSIDE the socket so a reconnect can drain it: a promise waiting on a
 * socket that no longer exists is a caller blocked until its own timeout, and on
 * the audit path that is a run that never finishes.
 */
export class FortressQueryRegistry {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  get inFlight(): number {
    return this.pending.size;
  }

  /** Registers a question and returns its correlation id plus the answer promise.
   *  The caller sends the frame; this owns everything after that. */
  open(timeoutMs = FORTRESS_QUERY_TIMEOUT_MS): {
    id: string;
    answer: Promise<FortressQueryResultPayload>;
  } {
    if (this.pending.size >= MAX_IN_FLIGHT_QUERIES) {
      return {
        id: "",
        answer: Promise.reject(new FortressQueryUnavailable("saturated")),
      };
    }
    const id = `fq-${Date.now().toString(36)}-${(this.counter += 1).toString(36)}`;
    const answer = new Promise<FortressQueryResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The silent-old-hub case lands here, and it is the common one during a
        // staged rollout — never an error, never a hang.
        reject(new FortressQueryUnavailable("timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    return { id, answer };
  }

  /** Deliver an answer. Unknown ids are dropped: a late reply to a question that
   *  already timed out must not resolve a promise nobody holds. */
  settle(frame: FortressQueryAnswerFrame): boolean {
    const pending = this.pending.get(frame.id);
    if (!pending) return false;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.t === "fortressQueryError") {
      pending.reject(new FortressQueryUnavailable("error", frame.error));
    } else {
      pending.resolve(frame.result);
    }
    return true;
  }

  /** Fail everything outstanding. Called on close and on reconnect — the hub on
   *  the other side of a new socket has no memory of the old ids. */
  drain(reason: "closed" | "offline"): number {
    const count = this.pending.size;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new FortressQueryUnavailable(reason));
    }
    return count;
  }
}

// -- The routing-posture cache ------------------------------------------------

export interface RoutingPostureSnapshot {
  fetchedAt: string;
  /** Present when the hub answered. */
  data?: FortressQueryResultPayload["routingPosture"];
  /** Present when it did not, with the reason. */
  unavailable?: string;
}

/** Older than this and the answer is reported as stale rather than current. The
 *  console renders the timestamp either way — an asOf a reader can check beats a
 *  freshness verdict they cannot. */
export const POSTURE_STALE_AFTER_MS = 15 * 60_000;

/** How often the daemon re-asks. Comfortably inside the staleness window, so a
 *  single lost answer never ages the snapshot out. */
export const POSTURE_REFRESH_MS = 5 * 60_000;

/** The one place the snapshot lives. Under runtime/, which the daemon owns and
 *  the console only reads. */
export function routingPosturePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "routing-posture.json");
}

export type PostureFreshness = "fresh" | "stale" | "unavailable" | "never-fetched";

export function postureFreshness(
  snapshot: RoutingPostureSnapshot | null,
  now = Date.now(),
): PostureFreshness {
  if (!snapshot) return "never-fetched";
  if (!snapshot.data) return "unavailable";
  const at = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(at)) return "unavailable";
  return now - at > POSTURE_STALE_AFTER_MS ? "stale" : "fresh";
}

/**
 * The audit verdict's qualification line.
 *
 * There is deliberately no clean "unqualified" without a posture: a run that
 * could not establish how ingest is routed has not checked the cloud-only
 * sessions, and saying otherwise would report a pass the run never earned.
 */
export function postureQualification(
  snapshot: RoutingPostureSnapshot | null,
  cloudOnlySessions: number,
  now = Date.now(),
): string {
  const freshness = postureFreshness(snapshot, now);
  if (freshness === "unavailable" || freshness === "never-fetched") {
    return "unqualified — posture unavailable, cloud-only sessions not checked";
  }
  if (cloudOnlySessions > 0) return `qualified (${cloudOnlySessions} cloud-only)`;
  return `unqualified (posture asOf ${snapshot?.fetchedAt ?? "unknown"})`;
}

/** Reads and writes runtime/routing-posture.json. Under runtime/, which is 0700
 *  and daemon-owned, so the console reads a file a Postgres-role adversary cannot
 *  reach. */
export class RoutingPostureCache {
  constructor(private readonly file: string) {}

  async read(): Promise<RoutingPostureSnapshot | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!raw || typeof raw !== "object") return null;
      const value = raw as Record<string, unknown>;
      if (typeof value.fetchedAt !== "string") return null;
      return {
        fetchedAt: value.fetchedAt,
        ...(value.data && typeof value.data === "object"
          ? { data: value.data as RoutingPostureSnapshot["data"] }
          : {}),
        ...(typeof value.unavailable === "string" ? { unavailable: value.unavailable } : {}),
      };
    } catch {
      return null;
    }
  }

  async write(snapshot: RoutingPostureSnapshot): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Record an unavailable answer WITH its timestamp. Leaving the previous good
   *  snapshot in place would let a stale posture pass as current forever. */
  async recordUnavailable(reason: string, now = new Date()): Promise<void> {
    await this.write({ fetchedAt: now.toISOString(), unavailable: reason });
  }
}
