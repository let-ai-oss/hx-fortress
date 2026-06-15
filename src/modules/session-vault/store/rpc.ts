// Vault RPC protocol — the wire contract between the workbench-api (client side,
// via RemoteVaultStore) and a self-hosted vault (server side). Transport-
// agnostic: this module only defines request/result shapes and a dispatcher
// that runs one request against a local SessionStore. The reverse tunnel (P4)
// carries these messages; nothing here knows about sockets.

import type {
  ComposeResult,
  SessionKey,
  SessionStore,
  SignedDownload,
  SignedUpload,
} from "./types.js";

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
      const { url } = await store.signCanonicalDownload(req.key);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`canonical_fetch_failed:${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { method: req.method, value: { base64: buf.toString("base64") } };
    }
    case "writeArtifact":
      await store.writeArtifact(req.key, req.name, req.text);
      return { method: req.method, value: { ok: true } };
    case "readArtifactText":
      return { method: req.method, value: await store.readArtifactText(req.key, req.name) };
    case "selfTest":
      await store.selfTest();
      return { method: req.method, value: { ok: true } };
    default: {
      const _exhaustive: never = req;
      throw new Error(`unknown_vault_method:${JSON.stringify(_exhaustive)}`);
    }
  }
}
