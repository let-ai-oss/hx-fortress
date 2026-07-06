# hx-fortress

HX Fortress is the on-customer-infrastructure host for let.ai components. It
runs as a long-lived Bun process, owns the connection to let.ai cloud, and
loads component modules such as `session_vault`.

This repository currently contains the vendored Fortress/cloud protocol
boundary, the host runtime with its stable on-disk configuration and status
contracts, and the lifecycle CLI for running Fortress as a persistent per-user
launchd or systemd service. Structured logs, module loading, and cloud
transport are implemented. Release artifacts bundle the core `session_vault`
module; `update` and the installer remain follow-up tasks.

## Install

The distribution installer will be served from the customer's let.ai
Workbench origin:

```sh
curl -fsSL https://<workbench-origin>/install/hx-fortress.sh | sh
```

## Install from sources

If you'd rather build the binary yourself instead of downloading a prebuilt
one, clone this repo and run the from-source installer. It reaches the same
running, enrolled Fortress as the `curl … | sh` path above — it just compiles
the binary locally with [Bun](https://bun.sh) first.

Prerequisite: Bun. Get the one-time `<token>` and the `<cloud-url>` from your
let.ai Workbench (Org Settings → self-hosted vault), exactly as for the binary
installer.

```sh
git clone https://github.com/let-ai-oss/hx-fortress && cd hx-fortress
./scripts/install-from-source.sh <token> --cloud <cloud-url>
```

The script installs dependencies, builds `hx-fortress`, installs it to
`~/.let/bin/hx-fortress` (ad-hoc code-signed on macOS), and hands off to the
interactive enroll wizard. Bun users can equivalently run
`bun run install:enroll <token> --cloud <cloud-url>`.

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
| `FORTRESS_DATABASE_URL` | no | Connect to an external Postgres instead of the embedded one. When set, the bundled Postgres is not downloaded or supervised. |
| `FORTRESS_PG_VERSION` | no | Embedded Postgres version to acquire (default pinned in code). |
| `FORTRESS_PG_BINARIES_URL` | no | Base URL for Postgres binary archives (default Maven Central); point at a mirror for air-gapped installs. |
| `FORTRESS_PG_DATA` | no | Data directory for the embedded cluster (default `$FORTRESS_ROOT/pgdata`). |
| `FORTRESS_PG_PORT` | no | Loopback port for the embedded server (default `54329`). Bound to `127.0.0.1` only. |

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

The vector column and its index require a pgvector-enabled Postgres; point the
fortress at one via `FORTRESS_DATABASE_URL` (the bundled embedded Postgres is
vanilla and ships no `vector` extension). When the extension is absent the embed
indexes are skipped and `hx_semantic_search` degrades to keyword.

**MCP data plane.** The `hx_*` tools are served over MCP on the gateway's `/mcp`
route, which is **off by default**. Set `FORTRESS_PUBLIC_URL` to enable the
gateway and advertise the public address an MCP client connects to; without it
the fortress advertises no public URL and the MCP data plane is unavailable.

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
