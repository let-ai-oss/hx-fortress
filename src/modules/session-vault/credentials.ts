// ~/.let/session-vault/credentials.json is the single state file for a Session
// Vault: the storage backend + the inline credentials that read/write the
// organization's own bucket, plus the let.ai tunnel identity issued at
// enrollment. Atomic-write (tmp + rename), chmod 600.
//
// Storage credentials live ONLY in this file, on this host — they are never
// transmitted to let.ai. A Session Vault install is exactly two files: the
// hx-session-vault binary and this credentials.json.

import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** Identity issued by let.ai at enrollment; written back into this file so a
 *  later `start` reconnects without a fresh token. */
export interface LetaiIdentity {
  hubUrl: string;
  orgId?: string;
  vaultId?: string;
  cred?: string;
  /** A not-yet-consumed enrollment token persisted by the wizard's manual path,
   *  so `hx-session-vault start` can finish enrollment after the storage block
   *  is filled in. Cleared once enrollment succeeds. */
  pendingToken?: string;
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
  /** let.ai tunnel identity (hub URL always; ids + cred after enrollment). */
  letai: LetaiIdentity;
}

export const VAULT_HOME = path.join(os.homedir(), ".let", "session-vault");
const CREDENTIALS_PATH = path.join(VAULT_HOME, "credentials.json");

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function vaultHome(): string {
  return VAULT_HOME;
}

export async function readVaultCredentials(): Promise<VaultCredentials | null> {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as VaultCredentials;
  } catch {
    return null;
  }
}

export async function writeVaultCredentials(creds: VaultCredentials): Promise<void> {
  await mkdir(VAULT_HOME, { recursive: true });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, CREDENTIALS_PATH);
  // rename preserves the tmp mode, but chmod again in case the file pre-existed
  // with looser perms.
  await chmod(CREDENTIALS_PATH, 0o600).catch(() => {});
}

/** A secret-free view for `status` / logs. Never prints private keys or S3
 *  secrets; the service-account email and bucket are identifiers, not secrets. */
export function redactCredentials(c: VaultCredentials): Record<string, unknown> {
  return {
    store: c.store,
    bucket: c.bucket,
    region: c.region ?? null,
    projectId: c.projectId ?? null,
    identity:
      c.store === "gcs"
        ? c.gcs?.client_email ?? "application-default credentials"
        : c.s3
          ? "inline access key"
          : "AWS default credential chain",
    enrolled: Boolean(c.letai.vaultId && c.letai.cred),
    hubUrl: c.letai.hubUrl,
    orgId: c.letai.orgId ?? null,
    vaultId: c.letai.vaultId ?? null,
  };
}
