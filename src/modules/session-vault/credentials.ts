// ~/.let/session-vault/credentials.json holds the storage-backend credentials
// for one Session Vault: the bucket name and the inline GCS/S3 keys that read
// and write the organization's own bucket. Atomic-write (tmp + rename),
// chmod 600.
//
// Enrollment identity (orgId, fortressId, credential) is Fortress-owned and
// lives under ~/.let/hx-fortress/ — it never appears in this file. Bucket
// credentials are module-local and never leave the host.
//
// PATH RESOLUTION IS LAZY, END TO END. There is deliberately no module-level
// constant for the home or the file: resolving either at import time captures
// whatever HOME happened to hold when the module first loaded, which is wrong
// for a test that changes it, for a service that starts before its environment
// is complete, and for any caller that re-homes the process. Every exported
// function routes through `credentialsPath()`, which reads HOME on each call.
//
// WRITES ARE SERIALIZED. Since the console reads this file live and the daemon
// rewrites it on a rotation, concurrent writers would otherwise interleave a
// partial credential set. Writers take an O_EXCL lock and advance a monotonic
// `version`, which is also how the console knows to drop its cached copy.

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

export type VaultStorageKind = "gcs" | "s3";

/** A GCP service-account key JSON (the file GCP hands out), inlined. */
export interface GcsServiceAccountKey {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  token_uri?: string;
  [k: string]: unknown;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface VaultCredentials {
  store: VaultStorageKind;
  bucket: string;
  /** GCS location / S3 region. */
  region?: string;
  /** GCS project id (required for gcs). */
  projectId?: string;
  /** S3-compatible endpoint (MinIO, R2, …). */
  endpoint?: string;
  /** Path-style addressing for S3-compatible endpoints. */
  forcePathStyle?: boolean;
  /** Inline GCP service-account key. Absent → Application Default Credentials. */
  gcs?: GcsServiceAccountKey;
  /** Inline S3 access key. Absent → AWS default credential chain. */
  s3?: S3Credentials;
  /** OpenAI API key for the embed worker (MC-2465). Kept here — the fortress's
   *  0600 secret store — so `host` can create vector embeddings without an env
   *  var; it never leaves this host. FORTRESS_OPENAI_API_KEY (env) overrides it. */
  openaiApiKey?: string;
  /** Monotonic write counter. ABSENT means 0: every fortress enrolled before
   *  this field existed holds a version-less file, and readVaultCredentials
   *  returns null on any parse failure (which stops ingest), so a strict CAS
   *  that refused a version-less file would break the first rotation on every
   *  one of them. The first writer under the lock stamps 1 in place. */
  version?: number;
}

/** The operator's home, resolved at CALL time.
 *
 *  `$HOME` is consulted first and `os.homedir()` only as a fallback: under Bun
 *  the latter reads the passwd entry, so a process re-homed after start (a
 *  container that sets HOME in its entrypoint, a test) would keep writing to
 *  the wrong directory — silently, since both paths exist. */
function homeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}

export function vaultHome(): string {
  return path.join(homeDir(), ".let", "session-vault");
}

export function credentialsPath(): string {
  return path.join(vaultHome(), "credentials.json");
}

/** An absent `version` reads as 0 — see the field comment. */
export function credentialsVersion(creds: VaultCredentials | null): number {
  const v = creds?.version;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

export async function readVaultCredentials(): Promise<VaultCredentials | null> {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as VaultCredentials;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, creds: VaultCredentials): Promise<void> {
  // 0700 the vault home so the 0600 credentials.json sits in an owner-only dir.
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
}

export async function writeVaultCredentials(creds: VaultCredentials): Promise<void> {
  await writeAtomic(credentialsPath(), creds);
}

// ── Single-writer protocol ──────────────────────────────────────────────────

/** Identifies THIS process in the lock file, so a stale lock names its owner. */
const BOOT_ID = randomUUID();

/** A lock older than this is treated as abandoned by a killed writer. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for a live lock before giving up. */
const LOCK_WAIT_MS = 5_000;
/** CAS attempts before the write fails loudly. Retrying forever would turn a
 *  contended rotation into a hang with no audit record. */
const MAX_CAS_RETRIES = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lockPath(): string {
  return `${credentialsPath()}.lock`;
}

async function acquireLock(waitMs = LOCK_WAIT_MS): Promise<void> {
  const file = lockPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, bootId: BOOT_ID }), {
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A killed writer leaves its lock behind. Break it once it is provably
      // older than any real critical section — a lock nobody can clear blocks
      // sign-in and every CLI verb, which is worse than the race it prevents.
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("credentials.json is locked by another writer", { cause: err });
      }
      await sleep(50);
    }
  }
}

async function releaseLock(): Promise<void> {
  await unlink(lockPath()).catch(() => {});
}

export interface CredentialsUpdate {
  credentials: VaultCredentials;
  version: number;
}

/**
 * The ONLY door for mutating credentials.json.
 *
 * Takes the lock, hands the caller the current contents, and writes the result
 * back with `version` advanced by one — re-reading immediately before the
 * rename so a writer that ignored the lock is caught rather than overwritten.
 * A version-less file (every fortress enrolled before the field existed) reads
 * as 0 and is stamped 1 in place, preserving every other field.
 */
export async function updateVaultCredentials(
  mutate: (current: VaultCredentials | null) => VaultCredentials | Promise<VaultCredentials>,
): Promise<CredentialsUpdate> {
  let lastConflict = 0;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    await acquireLock();
    try {
      const current = await readVaultCredentials();
      const expected = credentialsVersion(current);
      const next = await mutate(current);
      const confirm = credentialsVersion(await readVaultCredentials());
      if (confirm !== expected) {
        lastConflict = confirm;
        continue;
      }
      const version = expected + 1;
      await writeAtomic(credentialsPath(), { ...next, version });
      return { credentials: { ...next, version }, version };
    } finally {
      await releaseLock();
    }
  }
  throw new Error(
    `credentials.json write lost ${MAX_CAS_RETRIES} version races (last observed version ${lastConflict})`,
  );
}

// ── Views ───────────────────────────────────────────────────────────────────

/** What the console process is given: the STORAGE block, minus every secret it
 *  has no signing use for. Signing HEAD/LIST/GetBucketVersioning needs exactly
 *  s3.secretAccessKey / gcs.private_key, so those stay — which is the residual
 *  stated plainly in the security notes: the console holds a bucket-WRITE
 *  capable key, because the fortress has one credential for reads and writes. */
export function storeCredentialsForConsole(c: VaultCredentials): VaultCredentials {
  const store = { ...c };
  delete store.openaiApiKey;
  return store;
}

/** A secret-free view for `status` / logs. Never prints private keys or S3
 *  secrets; the service-account email and bucket are identifiers, not secrets. */
export function redactCredentials(c: VaultCredentials): Record<string, unknown> {
  return {
    store: c.store,
    bucket: c.bucket,
    region: c.region ?? null,
    projectId: c.projectId ?? null,
    version: credentialsVersion(c),
    identity:
      c.store === "gcs"
        ? c.gcs?.client_email ?? "application-default credentials"
        : c.s3
          ? "inline access key"
          : "AWS default credential chain",
  };
}

/**
 * A live reader for the console: re-reads only when the file's identity or
 * mtime moved, and NEVER serves a cached copy across a version bump. The daemon
 * bumps the version when it rotates, so the console picks up new credentials
 * with no restart — and a stale copy would have it signing with a key that has
 * already been revoked at the provider.
 */
export class LiveCredentialsReader {
  private cached: VaultCredentials | null = null;
  private signature: string | null = null;

  async read(): Promise<VaultCredentials | null> {
    const file = credentialsPath();
    const info = await stat(file).catch(() => null);
    if (!info) {
      this.cached = null;
      this.signature = null;
      return null;
    }
    const signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    if (this.cached && this.signature === signature) return this.cached;
    const fresh = await readVaultCredentials();
    this.cached = fresh;
    this.signature = fresh ? signature : null;
    return fresh;
  }

  get version(): number {
    return credentialsVersion(this.cached);
  }
}
