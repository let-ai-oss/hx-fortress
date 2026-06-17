import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Persists the org Ed25519 public key (base64url) the hub pushes over the
 *  tunnel, so the gateway can verify capability tokens offline across restarts. */
export class FileSigningKeyStore {
  constructor(private readonly keyPath: string) {}

  async load(): Promise<string | null> {
    try {
      const raw = (await readFile(this.keyPath, "utf8")).trim();
      return raw.length > 0 ? raw : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(publicKeyB64url: string): Promise<void> {
    await mkdir(path.dirname(this.keyPath), { recursive: true });
    const tmp = `${this.keyPath}.${process.pid}.tmp`;
    await writeFile(tmp, publicKeyB64url, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.keyPath);
  }
}
