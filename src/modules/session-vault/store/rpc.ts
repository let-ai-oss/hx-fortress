// Vault RPC protocol — the wire contract between the workbench-api (client side,
// via RemoteVaultStore) and a self-hosted vault (server side). Transport-
// agnostic: this module only defines request/result shapes and a dispatcher
// that runs one request against a local SessionStore. The reverse tunnel (P4)
// carries these messages; nothing here knows about sockets.

import type { HxDb } from "../../../host/postgres/db.js";
import {
  ingestAgentCommit,
  ingestCommit,
  type IngestAttribution,
} from "../../../ingest/ingest.js";
import { listSessionsForUser } from "../../../query/list-sessions.js";
import { maxCanonicalBytes } from "./limits.js";
import type {
  ComposeResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
} from "./types.js";

/** Shared payload for the two metadata-ingest RPCs the cloud sends after a
 *  commit so the fortress mirrors the session into its own hx schema. The
 *  cloud passes the chunk text it already read plus the attribution it already
 *  resolved; the fortress re-parses and writes rows locally. */
export interface IngestCommitRpc {
  key: SessionKey;
  chunkId: string;
  replace?: boolean;
  chunkText: string;
  totalBytes: number;
  componentCount: number;
  meta: Record<string, unknown> | null;
  attribution: IngestAttribution;
}

/** One prepared "my sessions" row, read from the fortress hx Postgres (MC-2415).
 *  Names (org/project/repo/model/device) are resolved fortress-side from the
 *  mirrored dimension tables, so the cloud needs no further joins to render the
 *  list. Mirrors the let-forge `FortressSessionRow` contract — keep in sync. */
export interface FortressSessionRow {
  family: string;
  sessionId: string;
  title: string | null;
  titleSource: "user" | "ai" | "fallback" | null;
  cwd: string | null;
  gitBranch: string | null;
  sourcePath: string | null;
  repoSlug: string | null;
  orgName: string | null;
  projectName: string | null;
  model: string | null;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estCostUsd: number | null;
  bytesUploaded: number;
  deviceName: string | null;
  firstSeenAt: string;
  lastActivityAt: string | null;
  updatedAt: string;
}

export type VaultRpcRequest =
  | { method: "signStagingUpload"; key: SessionKey; chunkId: string }
  | { method: "readChunkText"; key: SessionKey; chunkId: string }
  // `replace` (divergence repair) is honored by vaults built after it was
  // added; older vault binaries simply ignore the extra field and append.
  | { method: "appendChunkToCanonical"; key: SessionKey; chunkId: string; replace?: boolean }
  | { method: "signCanonicalDownload"; key: SessionKey }
  // Locked-bucket path: the vault reads the canonical itself (inside the
  // customer network) and streams the bytes back base64-encoded, instead of
  // handing out a signed URL the let.ai side would fetch directly.
  | { method: "readCanonical"; key: SessionKey }
  | { method: "statCanonical"; key: SessionKey }
  | { method: "writeArtifact"; key: SessionKey; name: string; text: string }
  | { method: "readArtifactText"; key: SessionKey; name: string }
  | { method: "listSessionMetadata"; userId: string }
  // Prepared "my sessions" read against the fortress hx Postgres (MC-2415).
  // Postgres-backed vaults only; older binaries reject the unknown method and
  // the cloud falls back to listSessionMetadata.
  | { method: "listSessions"; userId: string; limit?: number }
  // Metadata-ingest RPCs (MC-2406) — written to the fortress hx schema. Honored
  // by vaults built with the embedded/external Postgres; older binaries reject
  // the unknown method, which the cloud treats as best-effort.
  | ({ method: "ingestCommit" } & IngestCommitRpc)
  | ({ method: "ingestAgentCommit"; agentId: string } & IngestCommitRpc)
  | { method: "selfTest" };

export type VaultRpcResult =
  | { method: "signStagingUpload"; value: SignedUpload }
  | { method: "readChunkText"; value: string }
  | { method: "appendChunkToCanonical"; value: ComposeResult }
  | { method: "signCanonicalDownload"; value: SignedDownload }
  | { method: "readCanonical"; value: { base64: string } }
  | { method: "statCanonical"; value: number | null }
  | { method: "writeArtifact"; value: { ok: true } }
  | { method: "readArtifactText"; value: string | null }
  | { method: "listSessionMetadata"; value: SessionMetadata[] }
  | { method: "listSessions"; value: FortressSessionRow[] }
  | { method: "ingestCommit"; value: { ok: true } }
  | { method: "ingestAgentCommit"; value: { ok: true } }
  | { method: "selfTest"; value: { ok: true } };

export interface VaultRpcError {
  error: string;
}

/**
 * Execute one RPC request against a local SessionStore. The vault calls this for
 * each request the tunnel forwards. Throws on unknown methods or store errors;
 * the caller maps the throw to a VaultRpcError on the wire.
 */
export async function handleVaultRpc(
  store: SessionStore,
  req: VaultRpcRequest,
  db: HxDb | null = null,
): Promise<VaultRpcResult> {
  switch (req.method) {
    case "signStagingUpload":
      return { method: req.method, value: await store.signStagingUpload(req.key, req.chunkId) };
    case "readChunkText":
      return { method: req.method, value: await store.readChunkText(req.key, req.chunkId) };
    case "appendChunkToCanonical":
      return {
        method: req.method,
        value: await store.appendChunkToCanonical(req.key, req.chunkId, { replace: req.replace }),
      };
    case "signCanonicalDownload":
      return { method: req.method, value: await store.signCanonicalDownload(req.key) };
    case "statCanonical":
      return { method: req.method, value: await store.statCanonical(req.key) };
    case "readCanonical": {
      // M-9c · reject an oversized whole-object read before fetching it into memory.
      const size = await store.statCanonical(req.key);
      if (size !== null && size > maxCanonicalBytes()) throw new Error("canonical_too_large");
      const { url } = await store.signCanonicalDownload(req.key);
      // Low · a thrown fetch error can embed the signed URL — swallow the original
      // and surface a URL-free reason so the signed URL never reaches logs/replies.
      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        throw new Error("canonical_fetch_failed:network");
      }
      if (!res.ok) throw new Error(`canonical_fetch_failed:${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { method: req.method, value: { base64: buf.toString("base64") } };
    }
    case "writeArtifact":
      await store.writeArtifact(req.key, req.name, req.text);
      return { method: req.method, value: { ok: true } };
    case "readArtifactText":
      return { method: req.method, value: await store.readArtifactText(req.key, req.name) };
    case "listSessionMetadata":
      return { method: req.method, value: await store.listSessionMetadata(req.userId) };
    case "listSessions": {
      if (!db) throw new Error("postgres_not_ready");
      return {
        method: req.method,
        value: await listSessionsForUser(db, { userId: req.userId, limit: req.limit }),
      };
    }
    case "ingestCommit": {
      if (!db) throw new Error("postgres_not_ready");
      await ingestCommit(db, {
        key: req.key,
        chunkId: req.chunkId,
        replace: req.replace === true,
        chunkText: req.chunkText,
        totalBytes: req.totalBytes,
        componentCount: req.componentCount,
        meta: req.meta,
        attribution: req.attribution,
      });
      return { method: req.method, value: { ok: true } };
    }
    case "ingestAgentCommit": {
      if (!db) throw new Error("postgres_not_ready");
      await ingestAgentCommit(db, {
        key: req.key,
        agentId: req.agentId,
        chunkId: req.chunkId,
        replace: req.replace === true,
        chunkText: req.chunkText,
        totalBytes: req.totalBytes,
        componentCount: req.componentCount,
        meta: req.meta,
        attribution: req.attribution,
      });
      return { method: req.method, value: { ok: true } };
    }
    case "selfTest":
      await store.selfTest();
      return { method: req.method, value: { ok: true } };
    default: {
      const _exhaustive: never = req;
      throw new Error(`unknown_vault_method:${JSON.stringify(_exhaustive)}`);
    }
  }
}
