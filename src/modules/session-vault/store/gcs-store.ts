// GcsStore — a SessionStore backed by Google Cloud Storage.
//
// Two storage tricks the ingestion path relies on:
//   1. A V4 signed PUT URL lets hx-client upload a chunk directly to the bucket
//      without bytes ever flowing through workbench.
//   2. GCS Compose appends a freshly-uploaded staging chunk onto the canonical
//      session log server-side. Compose accumulates a componentCount capped at
//      1024; we rewrite-in-place at 800 so the counter resets — cheap on small
//      objects, and it never hits the wall.
//
// Config is injected (not read from env) so the same class serves let.ai's
// bucket AND a customer's bucket inside a self-hosted vault.

import { Storage, type StorageOptions, type Bucket } from "@google-cloud/storage";
import type {
  AppendOptions,
  ComposeResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
} from "./types.js";
import {
  metadataFromCanonicalObjectName,
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "./session-metadata.js";
import { artifactObject, canonicalObject, listPrefix, sessionPrefix, stagingObject } from "./keys.js";
import { maxCanonicalBytes } from "./limits.js";

export interface GcsStoreConfig {
  projectId: string;
  bucketName: string;
  /** Path to a service-account keyfile JSON. */
  keyFilename?: string;
  /** Inline service-account credentials (parsed JSON). */
  credentials?: StorageOptions["credentials"];
}

/** Rewrite-in-place once a composed object reaches this many components. */
const COMPACT_THRESHOLD = 800;

export class GcsStore implements SessionStore {
  private readonly storage: Storage;
  private readonly bucketName: string;
  private _bucket: Bucket | null = null;

  constructor(cfg: GcsStoreConfig) {
    const opts: StorageOptions = { projectId: cfg.projectId };
    if (cfg.keyFilename) {
      opts.keyFilename = cfg.keyFilename;
    } else if (cfg.credentials) {
      opts.credentials = cfg.credentials;
    }
    this.storage = new Storage(opts);
    this.bucketName = cfg.bucketName;
  }

  private bucket(): Bucket {
    if (!this._bucket) this._bucket = this.storage.bucket(this.bucketName);
    return this._bucket;
  }

  async signStagingUpload(key: SessionKey, chunkId: string): Promise<SignedUpload> {
    const objectName = stagingObject(key, chunkId);
    const expiresMs = Date.now() + 15 * 60 * 1000;
    const [url] = await this.bucket()
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: expiresMs,
        contentType: "application/x-ndjson",
      });
    return { url, objectName, expiresAt: new Date(expiresMs).toISOString() };
  }

  async readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    const file = this.bucket().file(stagingObject(key, chunkId));
    // M-9c · reject an oversized chunk from its metadata size BEFORE downloading it
    // (a hostile / buggy signed-URL upload could be arbitrarily large → OOM on the
    // download + re-parse). Fail-closed.
    const [meta] = await file.getMetadata();
    if (Number(meta.size ?? 0) > maxCanonicalBytes()) throw new Error("chunk_too_large");
    const [buf] = await file.download();
    return buf.toString("utf8");
  }

  async appendChunkToCanonical(
    key: SessionKey,
    chunkId: string,
    opts?: AppendOptions,
  ): Promise<ComposeResult> {
    const b = this.bucket();
    const canonical = b.file(canonicalObject(key));
    const staging = b.file(stagingObject(key, chunkId));

    const [canonicalExists] = await canonical.exists();
    // Replace (divergence repair) takes the same promote-staging path as a
    // first chunk — copy overwrites whatever the canonical held.
    if (!canonicalExists || opts?.replace) {
      await staging.copy(canonical);
      await staging.delete().catch(() => {});
      const [meta] = await canonical.getMetadata();
      return {
        totalBytes: Number(meta.size ?? 0),
        componentCount: Number(meta.componentCount ?? 1),
      };
    }

    await b.combine([canonical, staging], canonical);
    await staging.delete().catch(() => {});

    let [meta] = await canonical.getMetadata();
    const componentCount = Number(meta.componentCount ?? 1);

    if (componentCount >= COMPACT_THRESHOLD) {
      const tmpName = `${sessionPrefix(key)}/.compact-${Date.now()}.jsonl`;
      const tmp = b.file(tmpName);
      await canonical.copy(tmp);
      await tmp.copy(canonical);
      await tmp.delete().catch(() => {});
      [meta] = await canonical.getMetadata();
      return {
        totalBytes: Number(meta.size ?? 0),
        componentCount: Number(meta.componentCount ?? 1),
      };
    }

    return { totalBytes: Number(meta.size ?? 0), componentCount };
  }

  async statCanonical(key: SessionKey): Promise<number | null> {
    try {
      const [meta] = await this.bucket().file(canonicalObject(key)).getMetadata();
      return Number(meta.size ?? 0);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    const objectName = canonicalObject(key);
    const expiresMs = Date.now() + 5 * 60 * 1000;
    const [url] = await this.bucket()
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresMs,
      });
    return { url, expiresAt: new Date(expiresMs).toISOString() };
  }

  async readCanonicalText(key: SessionKey): Promise<string> {
    const [buf] = await this.bucket().file(canonicalObject(key)).download();
    return buf.toString("utf8");
  }

  async writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    await this.bucket()
      .file(artifactObject(key, name))
      .save(text, { contentType: "application/json", resumable: false });
  }

  async readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    try {
      const [buf] = await this.bucket().file(artifactObject(key, name)).download();
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  async listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    const [files] = await this.bucket().getFiles({ prefix: listPrefix(userId) });
    const out: SessionMetadata[] = [];
    const seen = new Set<string>();
    const canonicalFallbacks: SessionMetadata[] = [];
    for (const file of files) {
      if (file.name.endsWith(`/${SESSION_METADATA_ARTIFACT}`)) {
        const raw = await file.download().catch(() => null);
        if (!raw) continue;
        const parsed = parseSessionMetadata(JSON.parse(raw[0].toString("utf8")));
        if (parsed) {
          seen.add(`${parsed.family}/${parsed.sessionId}`);
          out.push(parsed);
        }
        continue;
      }
      const [metadata] = await file.getMetadata().catch(() => []);
      const updatedAt =
        typeof metadata?.updated === "string" ? metadata.updated : new Date().toISOString();
      const fallback = metadataFromCanonicalObjectName(
        userId,
        file.name,
        Number(metadata?.size ?? 0),
        updatedAt,
      );
      if (fallback) canonicalFallbacks.push(fallback);
    }
    for (const fallback of canonicalFallbacks) {
      if (!seen.has(`${fallback.family}/${fallback.sessionId}`)) out.push(fallback);
    }
    return out;
  }

  async selfTest(): Promise<void> {
    const file = this.bucket().file(`.session-vault/selftest-${Date.now()}.txt`);
    await file.save("ok", { contentType: "text/plain", resumable: false });
    const [buf] = await file.download();
    if (buf.toString("utf8") !== "ok") throw new Error("self-test readback mismatch");
    await file.delete().catch(() => {});
  }
}
