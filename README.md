# hx-fortress

HX Fortress is the on-customer-infrastructure host for let.ai components. It
runs as a long-lived Bun process, owns the connection to let.ai cloud, and
loads component modules such as `session_vault`.

This repository currently contains the vendored Fortress/cloud protocol
boundary, the host runtime with its stable on-disk configuration and status
contracts, and the lifecycle CLI for running Fortress as a persistent per-user
launchd or systemd service. Structured logs, module loading, and cloud
transport are implemented. Release artifacts bundle the core `session_vault`
module, and both the self-update command and the install-from-source and
prebuilt installers are shipped.

## Install

The distribution installer is served from the customer's let.ai
Workbench origin:

```sh
curl -fsSL https://<workbench-origin>/install/hx-fortress.sh | sh
```

## Install from sources

If you'd rather build the binary yourself instead of downloading a prebuilt
one, clone this repo and run the from-source installer. It reaches the same
running, enrolled Fortress as the `curl … | sh` path above — it just compiles
the binary locally with [Bun](https://bun.sh) first (installed automatically
if missing).

Both parameters are optional: the `--cloud` URL defaults to production
(`wss://let.ai/_api/hx-gateway/vault-tunnel`), and if you omit the enrollment
token the wizard walks you through acquiring one (via browser or paste) once
the build finishes.

```sh
git clone https://github.com/let-ai-oss/hx-fortress && cd hx-fortress
./install-from-source.sh
```

The script installs dependencies, builds `hx-fortress`, installs it to
`~/.let/bin/hx-fortress` (ad-hoc code-signed on macOS), and hands off to the
interactive enroll wizard. Once credentials are verified, the wizard asks
"Start hx-fortress now?" — accept to have it register as a service and start
immediately, or decline and run `hx-fortress start` yourself later. Bun users
can equivalently run `bun run install:enroll`. Pass a token and/or `--cloud
<url>` explicitly if you already have them: `./install-from-source.sh <token>
--cloud <cloud-url>`.

## Commands

The Fortress CLI surface is:

```text
hx-fortress start
hx-fortress stop
hx-fortress status
hx-fortress logs
hx-fortress update
```

`hx-fortress host` is the internal foreground command used by the OS service
manager. It is not intended for direct user invocation.

## Cloud-service run mode

`hx-fortress host` also runs headless as a let.ai cloud service — no TUI, no
interactive enroll wizard. A container started with only environment variables
and an empty mounted volume enrolls into the hub on first boot and serves the
gateway. The Dockerfile sets `FORTRESS_ROOT=/data` and `ENTRYPOINT
["hx-fortress", "host"]`; mount a volume at `/data` so `config.json`,
`credentials.json`, and the signing key persist across restarts (restarts
re-`hello` with the saved credential instead of re-enrolling).

### Environment contract

| Variable | Required | Purpose |
| --- | --- | --- |
| `FORTRESS_ROOT` | yes (Docker) | Directory for persisted state. The image sets `/data`. |
| `FORTRESS_PUBLIC_URL` | yes | Public URL of the ingest gateway; also enables the gateway. |
| `FORTRESS_GATEWAY_PORT` | no | Gateway listen port (default `8787`). |
| `FORTRESS_ENROLL_TOKEN` | first boot | One-time enrollment token from the let.ai hub. |
| `FORTRESS_CLOUD_URL` | first boot | WebSocket URL of the hub, e.g. `wss://let.ai/api/fortress/tunnel`. |
| `FORTRESS_STORAGE_BUCKET` | yes | Bucket that holds session transcripts. |
| `FORTRESS_STORAGE_KIND` | no | `gcs` (default) or `s3`. |
| `FORTRESS_STORAGE_REGION` | no | Bucket location / region. |
| `FORTRESS_GCS_PROJECT_ID` | gcs | GCP project id. |
| `FORTRESS_GCS_SA_KEY` | no (gcs) | Service-account key JSON, raw or base64-encoded. Omit to use application default credentials. |
| `FORTRESS_S3_ACCESS_KEY_ID` | no (s3) | S3 access key id. Omit to use the AWS default credential chain. |
| `FORTRESS_S3_SECRET_ACCESS_KEY` | no (s3) | S3 secret access key. |
| `FORTRESS_S3_SESSION_TOKEN` | no (s3) | S3 session token. |
| `FORTRESS_S3_ENDPOINT` | no (s3) | S3-compatible endpoint (MinIO, R2, …). |
| `FORTRESS_S3_FORCE_PATH_STYLE` | no (s3) | `true` for path-style addressing. |
| `FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT` | no (s3) | Allow a plaintext / private-range `FORTRESS_S3_ENDPOINT` (e.g. MinIO on an internal network); off ⇒ https + public-range required (SSRF guard). |
| `FORTRESS_S3_ENDPOINT_ALLOWLIST` | no (s3) | Comma-separated host allowlist for `FORTRESS_S3_ENDPOINT`; when set, only these hosts are permitted. |
| `FORTRESS_DATABASE_URL` | no | Connect to an external Postgres instead of the embedded one. When set, the bundled Postgres is not downloaded or supervised. |
| `FORTRESS_PG_VERSION` | no | Embedded Postgres version to acquire (default pinned in code). |
| `FORTRESS_PG_BINARIES_URL` | no | Base URL for Postgres binary archives (default Maven Central); point at a mirror for air-gapped installs. |
| `FORTRESS_PG_DATA` | no | Data directory for the embedded cluster (default `$FORTRESS_ROOT/pgdata`). |
| `FORTRESS_PG_PORT` | no | Loopback port for the embedded server (default `54329`). Bound to `127.0.0.1` only. |
| `FORTRESS_PG_REQUIRE_PINNED` | no | Refuse a Postgres binary with no baked-in pinned SHA-256 (strict supply-chain mode). |
| `FORTRESS_PG_ALLOW_UNPINNED` | no | Escape hatch that re-permits the network `.sha256` fallback even under require-pinned. |
| `FORTRESS_STORE_OP_TIMEOUT_MS` | no | Per-call deadline for ordinary storage calls (default `20000`). Values above the cloud tunnel's 30s only help direct-gateway callers. |
| `FORTRESS_STORE_HEAVY_TIMEOUT_MS` | no | Deadline for heavy storage calls — whole-canonical read/write, chunk compose (default `120000`). |
| `FORTRESS_STORE_SCAN_TIMEOUT_MS` | no | Deadline for whole-bucket scans — reconciler discovery, large session lists (default `600000`). |
| `FORTRESS_STORE_PROBE_INTERVAL_MS` | no | Write-path self-test cadence (default `60000`; `0` disables). A hung probe counts toward the storage-client rebuild. |
| `FORTRESS_STORE_EXIT_ON_WEDGE` | no | `on`/`off`: force or forbid exiting for a supervisor restart when rebuilds prove futile. **Spans BOTH self-heal layers** — the storage client and the hx-db pools. Default: auto-detect systemd/launchd/Railway; never exits from a terminal, never exits if the layer has not succeeded since boot. |
| `FORTRESS_DB_CONNECT_TIMEOUT_MS` | no | Pool connect bound (default `10000`; `0` ⇒ default — never disableable). |
| `FORTRESS_DB_STATEMENT_TIMEOUT_MS` | no | Server-side `statement_timeout` startup parameter on every fortress pool (default `120000`). **`0` OMITS the parameter entirely on every consumer — the pooled-DSN escape hatch** (see upgrade note below). |
| `FORTRESS_DB_MAX_LIFETIME_MS` | no | Hard connection rotation (default `600000`; `0` ⇒ default — rotation is the poisoned-pool healer and is never disableable). Kills a still-running statement at rotation (the txn rolls back atomically); purges are exempt (own client). |
| `FORTRESS_DB_PROBE_INTERVAL_MS` | no | hx-db liveness probe cadence (default `60000`; `0` disables — mirrors the store probe). 3 consecutive breaches rebuild the pools; 2 futile rebuilds escalate per `FORTRESS_STORE_EXIT_ON_WEDGE`. |
| `FORTRESS_DB_MIGRATION_TIMEOUT_MS` | no | Per-statement bound inside every migration batch (default `300000`; validated integer). **Each single migration must fit this budget** — per-migration journaling converges incrementally across attempts, one too-slow migration never does; raise it for backfill-class migrations. |
| `FORTRESS_GUARANTOR_INTERVAL_MS` | no | Reconcile sweep interval (default `3600000`; `0` ⇒ default — use `FORTRESS_GUARANTOR_DISABLED` to turn the guarantor off). |

**Upgrade note — pooler-fronted `FORTRESS_DATABASE_URL` (PgBouncer-class):**
v0.17.0 sends a `statement_timeout` startup parameter on its pools. Poolers
that reject unknown startup parameters (`unsupported startup parameter`) will
refuse those connections — the fortress still boots and migrates (its
provider/migration clients are parameter-free), then logs a one-shot ERROR
naming the remedy: set `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0` to omit the
parameter everywhere. Note the `=0` semantics deliberately differ per knob
(statement-timeout `0` = omit; max-lifetime/guarantor `0` = default;
probe-interval `0` = disable) — each row above states its own.

Buckets enrolled before v0.16.0 predate the probe-prefix lifecycle rules new
enrolls provision automatically; add them once so the minutely write-probe's
noncurrent versions expire (scoped to `.session-vault/` — customer data is
untouched). **Both commands REPLACE the bucket's entire lifecycle
configuration** — if your bucket already carries lifecycle rules (transitions,
expiries), merge these into your existing set instead of pasting verbatim.
GCS — `gcloud storage buckets update gs://<bucket> --lifecycle-file=<json with
the .session-vault/ noncurrent-delete + age-7 rules>`; S3 — `aws s3api
put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration
'{"Rules":[{"ID":"hx-session-vault-probe","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"Expiration":{"ExpiredObjectDeleteMarker":true}},{"ID":"hx-session-vault-probe-strays","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"Expiration":{"Days":7}}]}'`.

`FORTRESS_ENROLL_TOKEN` + `FORTRESS_CLOUD_URL` are consumed only on the first
boot of a fresh volume; once a credential is saved they are ignored. Storage
credentials are re-applied from the environment on every boot, so rotating a key
is a redeploy.

### Configuration (embed / semantic)

The semantic layer — the `hx_semantic_search` tool and its `pgvector` index — is
driven by an in-fortress embed worker. It is **off until
`FORTRESS_OPENAI_API_KEY` is set**; with no key the worker never runs and
`hx_semantic_search` degrades to keyword search. The OpenAI account **must have
billing/credits** — otherwise embedding fails with `insufficient_quota` and the
tool likewise degrades to keyword. Resolved in `resolveEmbedConfig`
(`src/host/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORTRESS_OPENAI_API_KEY` | — (gates the feature) | OpenAI key for the embed worker. Absent ⇒ worker off, semantic degrades to keyword. |
| `FORTRESS_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI endpoint base; override for a zero-retention / DPA endpoint. |
| `FORTRESS_EMBED_MODEL` | `text-embedding-3-large` | Embedding model. |
| `FORTRESS_EMBED_DIMENSIONS` | `1024` | Output dimensions (Matryoshka); must match the `vector`/`halfvec` column width. |
| `FORTRESS_EMBED_DB_MAX` | `4` | The worker's own `Bun.SQL` pool cap (the shared `createHxDb` handle is uncapped). |
| `FORTRESS_EMBED_CONCURRENCY` | `2` | In-process embed concurrency limit. |
| `FORTRESS_EMBED_BATCH` | `96` | Turns per OpenAI embed request. |
| `FORTRESS_EMBED_MAX_PER_PASS` | `500` | Maximum turns embedded per worker pass. |
| `FORTRESS_EMBED_DEBOUNCE_MS` | `5000` | Debounce (ms) after a commit before an embed pass fires. |
| `FORTRESS_EMBED_MAX_WAIT_MS` | `1800000` | Max-wait cap (ms; 30 min) — embed any turn that has waited at least this long regardless of later chunks. |
| `FORTRESS_EMBED_DAILY_TOKEN_BUDGET` | `5000000` | Daily OpenAI embed-token ceiling, keyed on the UTC day; `0` ⇒ unlimited. New embeds pause for the day once crossed. |
| `FORTRESS_MAX_QUERY_TEXT_CHARS` | `8000` | Max `hx_semantic_search` query length before it is trimmed (scrub + egress DoS guard). |

The vector column and its index require a pgvector-enabled Postgres; point the
fortress at one via `FORTRESS_DATABASE_URL` (the bundled embedded Postgres is
vanilla and ships no `vector` extension). When the extension is absent the embed
indexes are skipped and `hx_semantic_search` degrades to keyword.

**MCP data plane.** The `hx_*` tools are served over MCP on the gateway's `/mcp`
route, which is **off by default**. Set `FORTRESS_PUBLIC_URL` to enable the
gateway and advertise the public address an MCP client connects to; without it
the fortress advertises no public URL and the MCP data plane is unavailable.

### Security & hardening

Boolean knobs read the truthy spellings `1` / `true` / `yes` / `on`
(case-insensitive); everything else is off. These default to the conservative
setting — flip them deliberately.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORTRESS_GRANT_ENFORCE` | off | REQUIRE a capability grant on the HTTP gateway + `/mcp` (verify-if-present when off). Coordinated-rollout lever — flip together with the workbench's `HX_FORTRESS_SEND_GRANTS`. |
| `FORTRESS_TUNNEL_GRANT_ENFORCE` | off | The reverse-tunnel equivalent (vault RPC + tunnel MCP). Same coordinated-rollout lever as `HX_FORTRESS_SEND_GRANTS`. |
| `FORTRESS_ALLOW_REENROLL` | off | Permit a pending enrollment whose cloud origin differs from the enrolled one (otherwise a hijack-drop re-enroll is ignored). |
| `FORTRESS_MAX_FRAME_BYTES` | `33554432` | Drop a cloud tunnel frame larger than this (bytes) before parsing — pre-auth DoS guard (32 MiB). |
| `FORTRESS_MAX_CANONICAL_BYTES` | `67108864` | Reject a whole-object session read above this size (bytes) — OOM guard (64 MiB). |
| `FORTRESS_SIGNING_KEY` / `FORTRESS_SIGNING_KEYID` | — (CI only) | base64url private Ed25519 JWK + its keyid used by `scripts/sign-artifact.ts` to sign release artifacts; the keyid must match a baked trust anchor. |

### Embedded Postgres

Fortress runs a local Postgres (database `hx-db`, schema `hx`) with no Docker, no
root, and no prompts. On first boot it downloads a pinned Postgres build, runs
`initdb` into `$FORTRESS_ROOT/pgdata`, and starts the server bound to `127.0.0.1`
(loopback only) on `FORTRESS_PG_PORT`. Set `FORTRESS_DATABASE_URL` to use an
external Postgres instead. Readiness (`/readyz` and `hx-fortress status`) reflects
Postgres availability; a failed or unreachable database holds readiness down with
a specific reason.

### Health checks

- `GET /healthz` — liveness; `200 {"ok":true}` as soon as the gateway listens.
- `GET /readyz` — readiness; `200 {"ok":true,"ready":true}` once the vault store
  is live and Postgres is accepting connections, otherwise `503`. Point the
  platform's traffic gate here.

## Development

Install Bun, then run:

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Use `bun run check` to run all repository checks in the same order as CI.
