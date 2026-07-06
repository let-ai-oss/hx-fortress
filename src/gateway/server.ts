// Fortress ingest/read gateway — a small HTTP server that mirrors the cloud
// hx-gateway upload/read surface so hx-client talks to it with only a base-URL
// swap. Every request carries a cloud-signed Ed25519 capability token, verified
// offline against the org public key the hub pushed over the tunnel; on success
// the matching handler presigns/composes against the live session_vault store.
//
// It also serves the hx_* MCP server at POST /mcp (A5) — key-authed with the
// same capability machinery, reading the fortress's own Postgres + local blob.
import {
  handleAppendUrl,
  handleCommit,
  handleAgentAppendUrl,
  handleAgentCommit,
  handleCanonicalDownload,
  handleArtifactRead,
  handleListSessionMetadata,
  type CommitOutput,
} from "./handlers";
import { verifyCapabilityToken, type CapabilityClaims } from "./capability-token";
import { ingestAgentCommit, ingestCommit, type IngestAttribution } from "../ingest/ingest";
import type { HxDb } from "../host/postgres/db";
import type { HxIngestNotification } from "../host/types";
import type { Embedder } from "../modules/embed-worker/openai";
import type { SessionStore } from "../modules/session-vault/store/types";
import {
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "../modules/session-vault/store/session-metadata";
import { handleMcpRequest } from "../mcp/server";
import packageJson from "../../package.json";

export interface GatewayLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface GatewayDeps {
  /** Resolves the live session_vault store, or null when the module isn't ready. */
  store: () => SessionStore | null;
  /** Cached org Ed25519 public key (base64url), or null before the hub pushes it. */
  signingKey: () => Promise<string | null>;
  /** This fortress's own org id (from its enrolled cloud credential), or null
   *  before enrollment. Lets verify reject a capability token whose `aud` names a
   *  DIFFERENT org — anti cross-org replay. Omitted ⇒ no aud-vs-org check. */
  ownOrgId?: () => Promise<string | null>;
  /** True once the local Postgres is accepting connections. */
  postgresReady: () => boolean;
  /** RW Drizzle handle on the bundled hx-db (the DML `hx_app_rw` role) — the
   *  ingest write path. Null before Postgres is ready. */
  db: () => HxDb | null;
  /** RO Drizzle handle on the bundled hx-db (the SELECT-only `hx_app_ro` role) —
   *  the MCP read tools. Null before Postgres is ready. */
  dbRead: () => HxDb | null;
  /** The fortress's OpenAI embedder for hx_semantic_search's in-fortress query
   *  embed. null/omitted ⇒ no key ⇒ semantic search degrades to keyword. */
  embedder?: Embedder | null;
  /** Push a realtime invalidation to the cloud after a direct-gateway ingest the
   *  cloud never relayed (MC-2415). Best-effort; optional. */
  notify?: (evt: HxIngestNotification) => void;
  logger: GatewayLogger;
  port: number;
}

export interface GatewayHandle {
  stop: () => void;
  port: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function authed(req: Request, deps: GatewayDeps): Promise<CapabilityClaims | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const key = await deps.signingKey();
  if (!key) return null;
  try {
    // Bind the token to this fortress's own org id when we know it: verify
    // rejects an `aud` naming a different org (anti cross-org replay).
    const ownOrgId = deps.ownOrgId ? await deps.ownOrgId() : null;
    return await verifyCapabilityToken(header.slice(7).trim(), key, ownOrgId);
  } catch {
    return null;
  }
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function metaRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface SessionKeyInput {
  userId: string;
  family: string;
  sessionId: string;
}

// On the direct gateway the cloud already attributed the session inside the
// capability token; map those claims to the ingest attribution shape.
function attributionFromClaims(claims: CapabilityClaims): IngestAttribution {
  return {
    orgExternalId: claims.org ?? null,
    repoSlug: claims.repo ?? null,
    projectExternalId: claims.project ?? null,
    deviceId: claims.deviceId ?? null,
  };
}

// Metadata ingestion is best-effort: the bytes are already committed to the
// vault, so a Postgres hiccup must not fail the upload — it's logged and the
// chunk re-ingests idempotently on the next commit.
async function ingestCommitMetadata(
  deps: GatewayDeps,
  claims: CapabilityClaims,
  key: SessionKeyInput,
  chunkId: string,
  replace: boolean,
  chunkText: string,
  commit: CommitOutput,
  meta: Record<string, unknown> | null,
): Promise<void> {
  const db = deps.db();
  if (!db) return;
  try {
    await ingestCommit(db, {
      attribution: attributionFromClaims(claims),
      key,
      chunkId,
      replace,
      chunkText,
      totalBytes: commit.totalBytes,
      componentCount: commit.componentCount,
      meta,
    });
    deps.notify?.({ userExternalId: key.userId, orgExternalId: claims.org ?? null });
  } catch (err) {
    deps.logger.error("hx metadata ingest failed", {
      sessionId: key.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function ingestAgentCommitMetadata(
  deps: GatewayDeps,
  claims: CapabilityClaims,
  key: SessionKeyInput,
  agentId: string,
  chunkId: string,
  replace: boolean,
  chunkText: string,
  commit: CommitOutput,
  meta: Record<string, unknown> | null,
): Promise<void> {
  const db = deps.db();
  if (!db) return;
  try {
    await ingestAgentCommit(db, {
      attribution: attributionFromClaims(claims),
      key,
      agentId,
      chunkId,
      replace,
      chunkText,
      totalBytes: commit.totalBytes,
      componentCount: commit.componentCount,
      meta,
    });
    deps.notify?.({ userExternalId: key.userId, orgExternalId: claims.org ?? null });
  } catch (err) {
    deps.logger.error("hx agent metadata ingest failed", {
      sessionId: key.sessionId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// M-9a · cap request bodies so a single upload can't exhaust memory. The ingest
// surface streams chunk bytes to signed URLs, not through this JSON API, so 4 MiB
// is ample for the control-plane JSON (commit metadata, MCP JSON-RPC).
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function startGatewayServer(deps: GatewayDeps): GatewayHandle {
  const server = Bun.serve({
    port: deps.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Unauthenticated liveness probe — proves the process is up. Used by the
      // platform health check; returns 200 as soon as the gateway is listening,
      // before enrollment completes, so the deploy is marked alive immediately.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }

      // Unauthenticated readiness probe — 200 only once the session_vault store
      // is live (enrolled, connected, credentials valid), otherwise 503. Use
      // this to gate traffic; /healthz to gate liveness.
      if (req.method === "GET" && url.pathname === "/readyz") {
        const ready = deps.store() !== null && deps.postgresReady();
        return json({ ok: ready, ready }, ready ? 200 : 503);
      }

      // MCP server (A5). Key-authed like every other route, but handled BEFORE
      // the vault-store gate below: the keyword/metadata tools read only the
      // local Postgres, so they answer even when the vault store is offline
      // (only hx_session_read_events needs the store, and degrades per-tool).
      if (url.pathname === "/mcp") {
        const mcpClaims = await authed(req, deps);
        if (!mcpClaims) return json({ error: "unauthorized" }, 401);
        try {
          return await handleMcpRequest(req, {
            // Least-privilege: the MCP tools are read-only, so they run on the
            // SELECT-only RO handle, never the ingest RW one.
            db: deps.dbRead(),
            store: deps.store(),
            embedder: deps.embedder ?? null,
            version: packageJson.version,
          });
        } catch (err) {
          deps.logger.error("mcp handler failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return json({ error: "internal_error" }, 500);
        }
      }

      const claims = await authed(req, deps);
      if (!claims) return json({ error: "unauthorized" }, 401);
      const store = deps.store();
      if (!store) return json({ error: "vault_offline" }, 503);
      const userId = claims.sub ?? "";

      try {
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          switch (url.pathname) {
            case "/sessions/append-url":
              return json(
                await handleAppendUrl(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  chunkId: str(body.chunkId),
                }),
              );
            case "/sessions/commit":
              {
                const key = {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                };
                const chunkId = str(body.chunkId);
                const replace = body.replace === true;
                // Read the staged chunk before composing — compose may clear staging.
                const chunkText = await store.readChunkText(key, chunkId).catch(() => "");
                const commit = await handleCommit(store, { ...key, chunkId, replace });
                const meta = metaRecord(body.meta);
                await ingestCommitMetadata(deps, claims, key, chunkId, replace, chunkText, commit, meta);
                const existing = parseSessionMetadata(
                  JSON.parse((await store.readArtifactText(key, SESSION_METADATA_ARTIFACT).catch(() => null)) ?? "null"),
                );
                const now = new Date().toISOString();
                await store.writeArtifact(
                  key,
                  SESSION_METADATA_ARTIFACT,
                  JSON.stringify({
                    family: key.family,
                    sessionId: key.sessionId,
                    title: optionalString(meta?.title) ?? existing?.title ?? null,
                    titleSource:
                      meta?.titleSource === "user" ||
                      meta?.titleSource === "ai" ||
                      meta?.titleSource === "fallback"
                        ? meta.titleSource
                        : (existing?.titleSource ?? null),
                    bytesUploaded: commit.totalBytes,
                    eventCount: num(meta?.eventCount, existing?.eventCount ?? 0),
                    userTextCount: num(meta?.userTextCount, existing?.userTextCount ?? 0),
                    assistantCount: num(meta?.assistantCount, existing?.assistantCount ?? 0),
                    lastActivityAt:
                      optionalString(meta?.lastActivityAt) ?? existing?.lastActivityAt ?? now,
                    firstSeenAt: existing?.firstSeenAt ?? now,
                    updatedAt: now,
                    cwd: optionalString(meta?.cwd) ?? existing?.cwd ?? null,
                    gitBranch: optionalString(meta?.gitBranch) ?? existing?.gitBranch ?? null,
                    sourcePath: optionalString(meta?.sourcePath) ?? existing?.sourcePath ?? null,
                    repoSlug: optionalString(meta?.repoSlug) ?? existing?.repoSlug ?? null,
                    deviceName: existing?.deviceName ?? null,
                  }),
                );
                return json(commit);
              }
            case "/sessions/agent-append-url":
              return json(
                await handleAgentAppendUrl(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  agentId: str(body.agentId),
                  chunkId: str(body.chunkId),
                }),
              );
            case "/sessions/agent-commit":
              {
                const key = {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                };
                const agentId = str(body.agentId);
                const chunkId = str(body.chunkId);
                const replace = body.replace === true;
                // Child lanes are stored under the composite sessionId:a:agentId key.
                const storeKey = { ...key, sessionId: `${key.sessionId}:a:${agentId}` };
                const chunkText = await store.readChunkText(storeKey, chunkId).catch(() => "");
                const commit = await handleAgentCommit(store, { ...key, agentId, chunkId, replace });
                await ingestAgentCommitMetadata(
                  deps,
                  claims,
                  key,
                  agentId,
                  chunkId,
                  replace,
                  chunkText,
                  commit,
                  metaRecord(body.meta),
                );
                return json(commit);
              }
            case "/sessions/canonical-url":
              return json(
                await handleCanonicalDownload(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                }),
              );
            case "/sessions/artifact":
              return json(
                await handleArtifactRead(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  name: str(body.name),
                }),
              );
          }
        }
        if (req.method === "GET" && url.pathname === "/sessions") {
          return json(await handleListSessionMetadata(store, { userId }));
        }
      } catch (err) {
        deps.logger.error("gateway handler failed", {
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
        return json({ error: "internal_error" }, 500);
      }

      return json({ error: "not_found" }, 404);
    },
  });
  const boundPort = server.port ?? deps.port;
  deps.logger.info("gateway listening", { port: boundPort });
  return { stop: () => server.stop(true), port: boundPort };
}
