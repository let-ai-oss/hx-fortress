// The durable park for post-commit artifact writes refused by the pause gate.
//
// A commit accepted one second before a pause has already answered the device;
// its deferred session-metadata write then meets a closed gate. Dropping it
// would silently lose the metadata the commit promised, and re-enqueueing it
// would stall the post-commit chain the quiesce barrier is waiting on — so the
// entry PARKS here (0600, append-only) and its chain entry RESOLVES. The park
// is drained after resume.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionKey } from "../modules/session-vault/store/types";

export interface ParkedArtifact {
  key: SessionKey;
  name: string;
  text: string;
  parkedAt: string;
}

export async function parkArtifact(filePath: string, entry: ParkedArtifact): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function readParkedArtifacts(filePath: string): Promise<ParkedArtifact[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: ParkedArtifact[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ParkedArtifact);
    } catch {
      // A torn final line from a crash mid-append; the write it described was
      // never acknowledged as parked, so there is nothing to replay.
    }
  }
  return out;
}

export interface ReplayResult {
  replayed: number;
  failed: number;
}

/**
 * Replay every parked write, then truncate.
 *
 * The park file is rotated aside FIRST, so a write that arrives during the
 * replay lands in a fresh file instead of being truncated away with the ones
 * just drained. Entries that fail again are appended back — a failed replay
 * must not be lost either.
 */
export async function drainParkedArtifacts(
  filePath: string,
  write: (entry: ParkedArtifact) => Promise<void>,
): Promise<ReplayResult> {
  const draining = `${filePath}.draining`;
  try {
    await rename(filePath, draining);
  } catch {
    return { replayed: 0, failed: 0 };
  }
  const entries = await readParkedArtifacts(draining);
  let replayed = 0;
  const stillFailing: ParkedArtifact[] = [];
  for (const entry of entries) {
    try {
      await write(entry);
      replayed += 1;
    } catch {
      stillFailing.push(entry);
    }
  }
  for (const entry of stillFailing) await parkArtifact(filePath, entry);
  await writeFile(draining, "", { mode: 0o600 }).catch(() => {});
  return { replayed, failed: stillFailing.length };
}

/**
 * When the park is owed a drain.
 *
 * A LATCH, not a paused→open edge. An edge can only be observed when a pause
 * ends by an explicit resume: the daemon's cached pause answers against the
 * clock, so a pause that lapses on its own deadline is already open the next
 * time anything looks — the edge test reads false at exactly the expiry it
 * exists to catch, and the parked write is stranded with no surface that would
 * ever mention it again. The entries are metadata for commits already
 * acknowledged to a device, so "stranded" means the fortress permanently holds
 * less than it told the device it had.
 *
 * Starts OWED, because a daemon restarted mid-pause has no edge to observe
 * either, and clears only on a drain that left nothing behind.
 */
export class ParkReplayLatch {
  private owed = true;

  /** Whether a drain is owed right now, given what the gate is doing. */
  due(paused: boolean): boolean {
    if (paused) {
      this.owed = true;
      return false;
    }
    return this.owed;
  }

  /** Record what a drain left behind. Anything still failing stays owed, so the
   *  next pass retries it rather than forgetting it. */
  settle(failed: number): void {
    if (failed === 0) this.owed = false;
  }
}
