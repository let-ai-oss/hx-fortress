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

/** The verified authorization a tunnel grant carries into a vault RPC (H-4): the
 *  principal (`sub`) the cloud minted the grant for, plus the read grant's scope
 *  commitment. Present only when the connection verified a grant; absent in the
 *  compat window (see connection.ts). */
export interface VaultAuthz {
  sub: string;
  scopeHash?: string;
}

/** The vault RPCs that MUTATE stored objects — each is bound to its `key.userId`
 *  owner, so a grant may only drive them for its own principal (H-4). */
const VAULT_WRITE_METHODS: ReadonlySet<string> = new Set([
  "signStagingUpload",
  "appendChunkToCanonical",
  "writeArtifact",
  "ingestCommit",
  "ingestAgentCommit",
]);

/** True for a mutating vault RPC method (drives the ingest vs read grant purpose). */
export function isVaultWriteMethod(method: string): boolean {
  return VAULT_WRITE_METHODS.has(method);
}

/** The capability-grant purpose a vault RPC method requires: writes need an
 *  `ingest` grant, everything else a `read` grant. */
export function vaultRpcPurpose(method: string): "ingest" | "read" {
  return isVaultWriteMethod(method) ? "ingest" : "read";
}

/** The user id the request's object belongs to, or null for object-free methods
 *  (`selfTest`). Writes and object reads both carry a `key`; the list reads carry
 *  a bare `userId`. */
function objectUserId(req: VaultRpcRequest): string | null {
  if ("key" in req && req.key) return req.key.userId;
  if ("userId" in req) return req.userId;
  return null;
}

/**
 * Execute one RPC request against a local SessionStore. The vault calls this for
 * each request the tunnel forwards. Throws on unknown methods or store errors;
 * the caller maps the throw to a VaultRpcError on the wire.
 *
 * H-4 · when `authz` is present (the connection verified a grant), the object the
 * RPC touches must belong to the grant's principal — `key.userId === authz.sub`
 * (or `userId === authz.sub` for the list reads). A mismatch fails closed with
 * `principal_object_mismatch`. `selfTest` carries no object and is never gated.
 *
 * `db` is the RW (DML) handle used by the ingest write branches; `dbRead` is the
 * SELECT-only RO handle for the `listSessions` metadata read (least-privilege).
 * `dbRead` falls back to `db` when omitted, so callers with a single handle (tests,
 * external Postgres) keep their exact prior behavior.
 */
export async function handleVaultRpc(
  store: SessionStore,
  req: VaultRpcRequest,
  db: HxDb | null = null,
  authz?: VaultAuthz,
  dbRead: HxDb | null = null,
): Promise<VaultRpcResult> {
  if (authz && req.method !== "selfTest") {
    const owner = objectUserId(req);
    if (owner !== null && owner !== authz.sub) {
      throw new Error("principal_object_mismatch");
    }
  }
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
        // redirect:"error" — a validated signed URL must not 3xx-redirect into a
        // private/metadata address (SSRF): a redirect makes fetch throw, which we
        // map to the URL-free network reason below (fail-closed).
        res = await fetch(url, { redirect: "error" });
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
      // Least-privilege: the "my sessions" metadata read is SELECT-only, so it
      // runs on the RO handle (falling back to the RW handle when a single handle
      // was passed — external Postgres / tests).
      const readDb = dbRead ?? db;
      if (!readDb) throw new Error("postgres_not_ready");
      return {
        method: req.method,
        value: await listSessionsForUser(readDb, { userId: req.userId, limit: req.limit }),
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
