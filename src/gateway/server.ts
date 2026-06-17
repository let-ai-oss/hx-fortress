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
} from "./handlers";
import { verifyCapabilityToken, type CapabilityClaims } from "./capability-token";
import type { SessionStore } from "../modules/session-vault/store/types";

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

export function startGatewayServer(deps: GatewayDeps): GatewayHandle {
  const server = Bun.serve({
    port: deps.port,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Unauthenticated liveness probe for the customer's ingress.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
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
              return json(
                await handleCommit(store, {
                  userId: str(body.userId, userId),
                  family: str(body.family),
                  sessionId: str(body.sessionId),
                  chunkId: str(body.chunkId),
                  replace: body.replace === true,
                }),
              );
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
  deps.logger.info("gateway listening", { port: deps.port });
  return { stop: () => server.stop(true), port: deps.port };
}
