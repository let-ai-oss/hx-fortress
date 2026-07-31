// The 0600 files under <root>/runtime/ that carry state a Postgres-role
// adversary must not be able to write.
//
// Two of them are security anchors rather than caches:
//   • the in-flight command file decides which running rows may be re-driven
//     after a crash — the filesystem is the medium the SQL adversary cannot
//     reach, which is exactly why no id-string predicate replaces it;
//   • the first-observed-pause file bounds how long a pause can hold the
//     store-write gate closed, and is the SOLE such bound on an external
//     Postgres, where no role split exists to grant against.

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── In-flight commands ──────────────────────────────────────────────────────

/**
 * Command ids this daemon claimed and has not yet driven to a terminal state.
 * Written AT CLAIM TIME, before execution starts, and removed on the terminal
 * transition — so after a crash the file is precisely the set of rows this
 * process was actually working on.
 *
 * There is deliberately no "own instance id" alternative: a per-boot id makes
 * the daemon's own crashed rows unrecognizable, and a persisted one is readable
 * through SELECT by the very role the fence defends against, who could then
 * stamp it onto a planted row. `claimed_by` stays observability-only for the
 * same reason.
 */
export async function readInFlight(filePath: string): Promise<Set<string>> {
  const parsed = await readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((v): v is string => typeof v === "string"));
}

export async function addInFlight(filePath: string, id: string): Promise<void> {
  const ids = await readInFlight(filePath);
  if (ids.has(id)) return;
  ids.add(id);
  await writePrivateJson(filePath, [...ids]);
}

export async function removeInFlight(filePath: string, id: string): Promise<void> {
  const ids = await readInFlight(filePath);
  if (!ids.delete(id)) return;
  await writePrivateJson(filePath, [...ids]);
}

// ── Pause anchor ────────────────────────────────────────────────────────────

export interface PauseAnchor {
  /** When this daemon FIRST observed the current pause episode (ISO 8601). */
  firstObservedAt: string;
}

export async function readPauseAnchor(filePath: string): Promise<PauseAnchor | null> {
  const parsed = await readJson<Partial<PauseAnchor>>(filePath);
  return typeof parsed?.firstObservedAt === "string"
    ? { firstObservedAt: parsed.firstObservedAt }
    : null;
}

/** Stamp the anchor if this is a NEW episode; keep it otherwise. A pause that
 *  is merely still running must not keep pushing its own bound forward. */
export async function stampPauseAnchor(filePath: string, at: Date): Promise<PauseAnchor> {
  const existing = await readPauseAnchor(filePath);
  if (existing) return existing;
  const anchor: PauseAnchor = { firstObservedAt: at.toISOString() };
  await writePrivateJson(filePath, anchor);
  return anchor;
}

/** Cleared on resume, so a later episode can never anchor to an earlier one. */
export async function clearPauseAnchor(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}
