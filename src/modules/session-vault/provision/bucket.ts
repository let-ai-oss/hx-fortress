// Bucket existence checks + secure create, via the operator's own gcloud/aws.
// Created buckets block public access by default — transcripts must never be
// world-readable.

import { capture } from "./exec.js";

type Log = (m: string) => void;

// ── GCS ──────────────────────────────────────────────────────────────────────

export async function gcsBucketExists(bucket: string): Promise<boolean> {
  const r = await capture("gcloud", [
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    "--format=value(name)",
  ]);
  return r.ok;
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
