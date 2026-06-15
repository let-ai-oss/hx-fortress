// The decline path is never a dead end: write a pre-filled credentials.json
// template (storage block left to complete) plus a SETUP.md with the exact
// commands. The enrollment token is persisted (locally, chmod 600) so Fortress
// can complete enrollment on first connect (T15).

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { VAULT_HOME, credentialsPath, type VaultStorageKind } from "../credentials.js";

export interface TemplateContext {
  store: VaultStorageKind;
  bucket: string;
  region?: string;
  projectId?: string;
  hubUrl: string;
  token: string;
}

export async function writeCredentialsTemplate(ctx: TemplateContext): Promise<string> {
  await mkdir(VAULT_HOME, { recursive: true });
  const body =
    ctx.store === "gcs"
      ? {
          store: "gcs",
          projectId: ctx.projectId ?? "<GCP_PROJECT_ID>",
          bucket: ctx.bucket,
          region: ctx.region ?? "<LOCATION>",
          gcs: "<REPLACE: a service-account key JSON object — { type, project_id, private_key, client_email, … } — for an account with roles/storage.objectAdmin on this bucket>",
          letai: { hubUrl: ctx.hubUrl, pendingToken: ctx.token },
        }
      : {
          store: "s3",
          bucket: ctx.bucket,
          region: ctx.region ?? "<REGION>",
          s3: { accessKeyId: "<ACCESS_KEY_ID>", secretAccessKey: "<SECRET_ACCESS_KEY>" },
          letai: { hubUrl: ctx.hubUrl, pendingToken: ctx.token },
        };
  const p = credentialsPath();
  await writeFile(p, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return p;
}

export async function writeSetupMd(ctx: TemplateContext): Promise<string> {
  const p = path.join(VAULT_HOME, "SETUP.md");
  await writeFile(p, renderSetupMd(ctx), { mode: 0o600 });
  return p;
}

function renderSetupMd(ctx: TemplateContext): string {
  if (ctx.store === "gcs") {
    return [
      "# Session Vault — manual setup (Google Cloud Storage)",
      "",
      "credentials.json has been written with placeholders. Complete the `gcs`",
      "block with a service-account key, then run `hx-fortress start`.",
      "",
      "## Create a least-privilege service account",
      "",
      "```sh",
      `PROJECT=${ctx.projectId ?? "<project>"}`,
      `BUCKET=${ctx.bucket}`,
      'gcloud iam service-accounts create hx-session-vault \\',
      '  --project="$PROJECT" --display-name="Session Vault"',
      "gcloud storage buckets add-iam-policy-binding gs://$BUCKET \\",
      '  --member="serviceAccount:hx-session-vault@$PROJECT.iam.gserviceaccount.com" \\',
      "  --role=roles/storage.objectAdmin",
      "gcloud iam service-accounts keys create key.json \\",
      '  --iam-account="hx-session-vault@$PROJECT.iam.gserviceaccount.com"',
      "```",
      "",
      "Paste the contents of key.json as the `gcs` value in credentials.json, then:",
      "",
      "```sh",
      "hx-fortress start",
      "```",
      "",
    ].join("\n");
  }
  return [
    "# Session Vault — manual setup (Amazon S3)",
    "",
    "credentials.json has been written with placeholders. Fill `s3.accessKeyId`",
    "and `s3.secretAccessKey` with a key scoped to this bucket, then run",
    "`hx-fortress start`.",
    "",
    "## Least-privilege IAM policy (attach to a dedicated user)",
    "",
    "```json",
    JSON.stringify(
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:ListBucket",
              "s3:AbortMultipartUpload",
            ],
            Resource: [`arn:aws:s3:::${ctx.bucket}`, `arn:aws:s3:::${ctx.bucket}/*`],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "```sh",
    "hx-fortress start",
    "```",
    "",
  ].join("\n");
}
