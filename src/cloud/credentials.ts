import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CloudCredential {
  orgId: string;
  fortressId: string;
  credential: string;
}

export interface CredentialStore {
  load(): Promise<CloudCredential | null>;
  save(credential: CloudCredential): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly credentialPath: string) {}

  async load(): Promise<CloudCredential | null> {
    let contents: string;
    try {
      contents = await readFile(this.credentialPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw invalidCredentials("unable to read credentials.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidCredentials("malformed JSON");
    }

    return parseCredential(value);
  }

  async save(credential: CloudCredential): Promise<void> {
    const value = parseCredential(credential);
    await mkdir(path.dirname(this.credentialPath), { recursive: true });
    const temporaryPath = `${this.credentialPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.credentialPath);
  }
}

function parseCredential(value: unknown): CloudCredential {
  if (!isRecord(value)) throw invalidCredentials("root must be an object");
  const orgId = requireNonEmptyString(value.orgId, "orgId");
  const fortressId = requireNonEmptyString(value.fortressId, "fortressId");
  const credential = requireNonEmptyString(value.credential, "credential");
  return { orgId, fortressId, credential };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCredentials(`${field} must be a non-empty string`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCredentials(reason: string): Error {
  return new Error(`Invalid Fortress credentials: ${reason}`);
}
