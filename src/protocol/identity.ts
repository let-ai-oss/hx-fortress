// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

export interface FortressIdentity {
  version: string;
  protocolVersion: number;
  /** Storage backend of the session-vault module, if configured. */
  storageKind?: "gcs" | "s3";
  bucketRegion?: string;
  bucket?: string;
  /** Public HTTPS base URL of this Fortress's own ingest gateway, when the
   *  operator has exposed one (FORTRESS_PUBLIC_URL). Absent → no direct ingest. */
  gatewayUrl?: string;
}
