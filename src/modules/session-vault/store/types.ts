// SessionStore — the storage abstraction behind hx-vision session blobs.
//
// One interface, several implementations, chosen per-org by ./index.ts:
//   • GcsStore         — Google Cloud Storage (let.ai's bucket, or a customer's)
//   • S3Store          — AWS S3 (added in P2)
//   • RemoteVaultStore — RPCs to a customer-hosted vault over the tunnel (P4)
//
// Call sites never touch a cloud SDK directly — they resolve a store and call
// these four methods. Object paths are identical across every implementation
// ({userId}/{family}/{sessionId}/…): org isolation lives at the bucket/store
// level, so a self-hosted vault's dedicated bucket needs no orgId in the path.

export interface SessionKey {
  userId: string;
  family: string;
  sessionId: string;
}

export interface SignedUpload {
  url: string;
  objectName: string;
  expiresAt: string;
}

export interface SignedDownload {
  url: string;
  expiresAt: string;
}

export interface ComposeResult {
  totalBytes: number;
  componentCount: number;
}

export interface AppendOptions {
  /** Overwrite the canonical with this chunk instead of appending. The client
   *  sends this on the first chunk of a from-zero (re)upload so a canonical
   *  that diverged from the device's source file — a wiped store, a lost
   *  client state file — converges back to the source instead of accreting
   *  duplicate or stale bytes. */
  replace?: boolean;
}

export interface SessionStore {
  /** Mint a signed PUT URL for a staging chunk. The caller PUTs raw NDJSON bytes. */
  signStagingUpload(key: SessionKey, chunkId: string): Promise<SignedUpload>;
  /** Read a freshly-uploaded staging chunk as UTF-8 text (used for indexing). */
  readChunkText(key: SessionKey, chunkId: string): Promise<string>;
  /** Append a staging chunk onto the canonical session log; returns new totals.
   *  With `opts.replace` the chunk REPLACES the canonical (divergence repair). */
  appendChunkToCanonical(key: SessionKey, chunkId: string, opts?: AppendOptions): Promise<ComposeResult>;
  /** Size of the canonical log in bytes, or null when it doesn't exist. Backs
   *  the sessions/verify divergence audit. */
  statCanonical(key: SessionKey): Promise<number | null>;
  /** Mint a signed GET URL for the canonical session log. */
  signCanonicalDownload(key: SessionKey): Promise<SignedDownload>;
  /** Read the full canonical session log as UTF-8 text (server-side read for
   *  agent tools / analytics). Remote vaults prefer a signed URL and fall back
   *  to streaming bytes over the tunnel when the bucket has no public egress. */
  readCanonicalText(key: SessionKey): Promise<string>;
  /** Write a small whole-file sidecar next to the session (e.g. "tasks.json",
   *  "plan.json"). Overwrites; not the chunk/compose path. */
  writeArtifact(key: SessionKey, name: string, text: string): Promise<void>;
  /** Read a sidecar artifact as UTF-8 text, or null if it doesn't exist. */
  readArtifactText(key: SessionKey, name: string): Promise<string | null>;
  /** Prove the bucket + credentials actually work: write→read→delete a
   *  throwaway probe object. Throws on any failure. Run at enroll time (so a
   *  bad bucket/permission surfaces immediately, not at the first session) and
   *  by the panel's "Send a test session". */
  selfTest(): Promise<void>;
}
