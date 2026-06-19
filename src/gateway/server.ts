// Fortress ingest/read gateway — a small HTTP server that mirrors the cloud
// hx-gateway upload/read surface so hx-client talks to it with only a base-URL
// swap. Every request carries a cloud-signed Ed25519 capability token, verified
// offline against the org public key the hub pushed over the tunnel; on success
// the matching handler presigns/composes against the live session_vault store.
import {
  handleAppendUrl,
  handleCommit,
  handleAgentAppendUrl,
  handleAgentCommit,
  handleCanonicalDownload,
  handleArtifactRead,
  handleListSessionMetadata,
} from "./handlers";
import { verifyCapabilityToken, type CapabilityClaims } from "./capability-token";
import type { SessionStore } from "../modules/session-vault/store/types";
import {
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "../modules/session-vault/store/session-metadata";

export interface GatewayLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface GatewayDeps {
  /** Resolves the live session_vault store, or null when the module isn't ready. */
  store: () => SessionStore | null;
  /** Cached org Ed25519 public key (base64url), or null before the hub pushes it. */
  signingKey: () => Promise<string | null>;
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
    return await verifyCapabilityToken(header.slice(7).trim(), key);
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

export function startGatewayServer(deps: GatewayDeps): GatewayHandle {
  const server = Bun.serve({
    port: deps.port,
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
        const ready = deps.store() !== null;
        return json({ ok: ready, ready }, ready ? 200 : 503);
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
                const commit = await handleCommit(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  chunkId: str(body.chunkId),
                  replace: body.replace === true,
                });
                const key = {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                };
                const meta = metaRecord(body.meta);
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
              return json(
                await handleAgentCommit(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  agentId: str(body.agentId),
                  chunkId: str(body.chunkId),
                  replace: body.replace === true,
                }),
              );
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
