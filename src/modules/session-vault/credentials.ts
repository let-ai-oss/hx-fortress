// ~/.let/session-vault/credentials.json holds the storage-backend credentials
// for one Session Vault: the bucket name and the inline GCS/S3 keys that read
// and write the organization's own bucket. Atomic-write (tmp + rename),
// chmod 600.
//
// Enrollment identity (orgId, fortressId, credential) is Fortress-owned and
// lives under ~/.let/fortress/ — it never appears in this file. Bucket
// credentials are module-local and never leave the host.

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
  // 0700 the vault home so the 0600 credentials.json sits in an owner-only dir.
  await mkdir(VAULT_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, CREDENTIALS_PATH);
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
  };
}
