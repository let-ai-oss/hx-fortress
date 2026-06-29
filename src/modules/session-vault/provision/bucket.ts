// Bucket existence checks + secure create, via the operator's own gcloud/aws.
// Created buckets block public access by default — transcripts must never be
// world-readable.

import { capture, type RunResult } from "./exec.js";

type Log = (m: string) => void;

// ── GCS ──────────────────────────────────────────────────────────────────────

export interface BucketProbe {
  exists: boolean;
  /** Set when the describe failed for a reason *other* than the bucket being
   *  absent — auth, missing permissions, or a wrong quota/billing project. The
   *  wizard surfaces this instead of misreporting the bucket as "not found". */
  error?: string;
}

/** Args for the existence probe. `--project` scopes the request to the project
 *  the operator chose; without it gcloud uses the active config project as the
 *  quota project, so a bucket living elsewhere is misreported as missing
 *  (MC-2412). */
export function gcsDescribeArgs(bucket: string, project: string): string[] {
  return [
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    `--project=${project}`,
    "--format=value(name)",
  ];
}

/** A genuinely-missing bucket surfaces as a 404 / "not found". Any other failure
 *  (401/403/quota-project) is a distinct problem we must not relabel as
 *  not-found — that conflation is what made an accessible bucket look missing. */
export function classifyBucketProbe(r: RunResult): BucketProbe {
  if (r.ok) return { exists: true };
  if (/\b404\b|not found|does not exist/i.test(r.stderr)) return { exists: false };
  return { exists: false, error: r.stderr || "gcloud storage buckets describe failed" };
}

export async function gcsBucketExists(bucket: string, project: string): Promise<BucketProbe> {
  return classifyBucketProbe(await capture("gcloud", gcsDescribeArgs(bucket, project)));
}

export interface GcsBucketOpts {
  bucket: string;
  project: string;
  location: string;
  kmsKey?: string;
}

export function gcsCreateCommand(o: GcsBucketOpts): string {
  return `gcloud storage buckets create gs://${o.bucket} --project=${o.project} --location=${o.location} --uniform-bucket-level-access --public-access-prevention=enforced`;
}

export async function createGcsBucket(o: GcsBucketOpts, log: Log): Promise<boolean> {
  const args = [
    "storage",
    "buckets",
    "create",
    `gs://${o.bucket}`,
    `--project=${o.project}`,
    `--location=${o.location}`,
    "--uniform-bucket-level-access",
    "--public-access-prevention=enforced",
  ];
  if (o.kmsKey) args.push(`--default-encryption-key=${o.kmsKey}`);
  const r = await capture("gcloud", args);
  if (!r.ok) {
    log(`Bucket creation failed: ${r.stderr || "unknown error"}`);
    return false;
  }
  // Defense in depth: versioning + soft-delete retention.
  await capture("gcloud", ["storage", "buckets", "update", `gs://${o.bucket}`, "--versioning"]);
  await capture("gcloud", [
    "storage",
    "buckets",
    "update",
    `gs://${o.bucket}`,
    "--soft-delete-duration=7d",
  ]);
  return true;
}

// ── S3 ───────────────────────────────────────────────────────────────────────

export async function s3BucketExists(bucket: string, region: string): Promise<boolean> {
  const r = await capture("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region]);
  return r.ok;
}

export interface S3BucketOpts {
  bucket: string;
  region: string;
  /** Customer-managed KMS key ARN/ID → SSE-KMS. Absent → SSE-S3 (AES256). */
  kmsKey?: string;
}

export function s3CreateCommand(o: S3BucketOpts): string {
  const loc =
    o.region === "us-east-1" ? "" : ` --create-bucket-configuration LocationConstraint=${o.region}`;
  return `aws s3api create-bucket --bucket ${o.bucket} --region ${o.region}${loc}`;
}

export async function createS3Bucket(o: S3BucketOpts, log: Log): Promise<boolean> {
  const args = ["s3api", "create-bucket", "--bucket", o.bucket, "--region", o.region];
  // us-east-1 rejects an explicit LocationConstraint.
  if (o.region !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${o.region}`);
  }
  const r = await capture("aws", args);
  if (!r.ok) {
    log(`Bucket creation failed: ${r.stderr || "unknown error"}`);
    return false;
  }
  await capture("aws", [
    "s3api",
    "put-public-access-block",
    "--bucket",
    o.bucket,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  ]);
  await capture("aws", [
    "s3api",
    "put-bucket-versioning",
    "--bucket",
    o.bucket,
    "--versioning-configuration",
    "Status=Enabled",
  ]);
  const encryption = o.kmsKey
    ? `{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"${o.kmsKey}"}}]}`
    : '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}';
  await capture("aws", [
    "s3api",
    "put-bucket-encryption",
    "--bucket",
    o.bucket,
    "--server-side-encryption-configuration",
    encryption,
  ]);
  return true;
}
