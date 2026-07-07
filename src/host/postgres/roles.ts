// De-superuser least-privilege role split (embedded Postgres): per-install
// generated passwords for the three DB roles the fortress uses —
//   • fortress   — the bootstrap superuser (DDL, migrations, extensions, role mgmt)
//   • hx_app_rw  — the ingest/embed DML role (no DDL, no superuser)
//   • hx_app_ro  — the MCP read-tool role (SELECT only, via hx_readonly)
//
// The secrets are minted once per install and persisted 0600 next to the pgdata
// under the fortress root, so they survive restarts. They MUST be preserved
// alongside the data dir: an existing (already-hardened, scram) cluster whose
// roles.json is lost cannot be re-authenticated automatically — recovery is an
// operator action. In the normal case roles.json and pgdata live under the same
// FORTRESS_ROOT and persist together.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RoleSecrets {
  /** Password for the `fortress` bootstrap superuser. */
  super: string;
  /** Password for the `hx_app_ro` SELECT-only role. */
  appRo: string;
  /** Password for the `hx_app_rw` DML role. */
  appRw: string;
}

/** A full, non-empty triple. A partial/corrupt file is treated as absent. */
function isValidSecrets(value: unknown): value is RoleSecrets {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.super === "string" && v.super.length > 0 &&
    typeof v.appRo === "string" && v.appRo.length > 0 &&
    typeof v.appRw === "string" && v.appRw.length > 0
  );
}

/** 24 random bytes as lowercase hex — 48 URL-safe chars ([0-9a-f]), so the value
 *  can be embedded in a `postgresql://user:pw@host` DSN with no escaping. */
function generateSecret(): string {
  return randomBytes(24).toString("hex");
}

/** Persist the secrets 0600 via a temp file + chmod + atomic rename, so a reader
 *  never observes a partially-written file and the bytes are never world-readable. */
async function writeSecrets(secretsPath: string, secrets: RoleSecrets): Promise<void> {
  // 0700 the containing dir so the role passwords (0600 files) sit in an owner-only
  // directory — a defense-in-depth pair with the file mode below.
  await mkdir(path.dirname(secretsPath), { recursive: true, mode: 0o700 });
  const tmp = `${secretsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(secrets), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, secretsPath);
}

/** Read the persisted role secrets, or mint + persist a fresh triple when the
 *  file is absent or invalid. Idempotent: once written, every later boot returns
 *  the same secrets. */
export async function ensureRoleSecrets(secretsPath: string): Promise<RoleSecrets> {
  if (existsSync(secretsPath)) {
    try {
      const parsed = JSON.parse(await readFile(secretsPath, "utf8")) as unknown;
      if (isValidSecrets(parsed)) {
        return { super: parsed.super, appRo: parsed.appRo, appRw: parsed.appRw };
      }
    } catch {
      // Corrupt/partial file — fall through and regenerate. (On an already-
      // hardened cluster this is a recovery edge case; see the file header.)
    }
  }
  const secrets: RoleSecrets = {
    super: generateSecret(),
    appRo: generateSecret(),
    appRw: generateSecret(),
  };
  await writeSecrets(secretsPath, secrets);
  return secrets;
}
