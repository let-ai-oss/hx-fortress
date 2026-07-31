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
