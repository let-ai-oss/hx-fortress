// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

export interface FortressIdentity {
  version: string;
  protocolVersion: number;
  /** Storage backend of the session-vault module, if configured. */
  storageKind?: "gcs" | "s3";
  bucketRegion?: string;
  bucket?: string;
}
