import {
  encodeFrame,
  safeDecodeFrame,
  type CollectionStats,
  type FortressIdentity,
  type FortressToHubFrame,
  type HubToFortressFrame,
  type KeyProof,
  type McpTunnelRequest,
  type McpTunnelResult,
  type MsgData,
} from "../protocol";
import type {
  CloudConnection,
  ConnectionState,
  ConnectionStatusSnapshot,
  FortressConfig,
  HostLogger,
  HxIngestNotification,
  MessageDispatcher,
  ModuleLifecycleHandler,
} from "../host/types";
import type { GrantClaims } from "../gateway/capability-token";
import { GRANT_REQUIRED_ERROR, isTunnelGrantEnforcing } from "../gateway/capability-token";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { persistSigningKeyPin, type PinnedSigningKey } from "../gateway/signing-key-store";
import { vaultRpcPurpose, type VaultAuthz } from "../modules/session-vault/store/rpc";
import type { CloudCredential, CredentialStore } from "./credentials";

export const SUPPORTED_PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Low · drop any frame larger than this before parsing it (DoS guard).
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

function parseMaxFrameBytes(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FRAME_BYTES;
}

export interface WsCloudConnectionDeps {
  dispatcher: MessageDispatcher;
  credentialStore: CredentialStore;
  logger: HostLogger;
  identity: FortressIdentity;
  moduleLoader?: ModuleLifecycleHandler;
  /** Persists the org Ed25519 public key the hub pushes on welcome/enrolled, so
   *  the gateway can verify capability tokens offline. H-2: the store PINS the key
   *  on first sight; a later CHANGE without a valid root proof is rejected. */
  signingKeyStore?: {
    loadRecord(): Promise<PinnedSigningKey | null>;
    saveRecord(record: PinnedSigningKey): Promise<void>;
  };
  /** Verifies a tunnel capability GRANT against the pinned per-org signing key
   *  (H-4). Built in main.ts over signingKeyStore.pinnedKey() + the enrolled org
   *  id. Omit to disable tunnel grant verification (a present grant then fails
   *  closed on the vault RPC path). */
  verifyGrant?: (
    token: string,
    opts: { purpose: "ingest" | "read"; requireScope?: boolean },
  ) => Promise<GrantClaims>;
  enrollToken?: string;
  /** Called once immediately after a successful enrollment and credential save.
   *  Use to clear the pending enrollment token and propagate identity to modules. */
  onEnrolled?: (cred: CloudCredential) => Promise<void> | void;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** MC-2430 tunnel-MCP: serves the fortress's MCP tools over the reverse
   *  tunnel (the read transport for a fortress with no public URL). Omit to disable. */
  mcp?: { handle(req: McpTunnelRequest): Promise<McpTunnelResult> };
  /** MC-2368: computes the fortress's collection counts, piggybacked onto the
   *  heartbeat (throttled). Returns null when the DB isn't ready. Omit to disable. */
  collectionStats?: () => Promise<CollectionStats | null>;
}

/** Dispatch one reverse-tunnel MCP request to the fortress tool handler + reply. */
export async function dispatchMcpFrame(
  mcp: { handle(req: McpTunnelRequest): Promise<McpTunnelResult> },
  frame: { t: "mcpRpc"; id: string; req: McpTunnelRequest },
  send: (f: FortressToHubFrame) => void,
  logger: { error: (msg: string, err?: unknown) => void },
): Promise<void> {
  try {
    const result = await mcp.handle(frame.req);
    send({ t: "mcpRpcResult", id: frame.id, result });
  } catch (err) {
    // This error crosses the wire back to the hub/agent — redact any DSN /
    // signed-URL a DB or driver error could carry before it leaves the fortress.
    const error = sanitizeDbError(err);
    logger.error(`mcp tunnel error: ${error}`, err);
    send({ t: "mcpRpcError", id: frame.id, error });
  }
}

export class WsCloudConnection implements CloudConnection {
  private _state: ConnectionState = "offline";
  private _reason: string | null = null;
  private _message: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private backoff: number;
  // The pending enrollment token, consumed on the first successful enroll and
  // then cleared so later reconnects authenticate with the saved credential
  // (the token is one-time — re-sending a consumed one would be rejected).
  private activeEnrollToken: string | null;
  private readonly heartbeatMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxFrameBytes: number;
  private closeResolve: (() => void) | null = null;

  constructor(private readonly deps: WsCloudConnectionDeps) {
    this.reconnectMinMs = deps.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    this.maxFrameBytes = parseMaxFrameBytes(process.env.FORTRESS_MAX_FRAME_BYTES);
    this.backoff = this.reconnectMinMs;
    this.activeEnrollToken = deps.enrollToken ?? null;
  }

  state(): ConnectionState {
    return this._state;
  }

  status(): ConnectionStatusSnapshot {
    return {
      state: this._state,
      reason: this._reason,
      message: this._message,
    };
  }

  open(config: FortressConfig): Promise<void> {
    this._state = "connecting";
    this._reason = null;
    this._message = null;
    this.stopped = false;
    this.backoff = this.reconnectMinMs;
    return new Promise<void>((resolve, reject) => {
      void this.dial(config, resolve, reject);
    });
  }

  notifyIngest(evt: HxIngestNotification): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        encodeFrame({
          t: "hxInvalidate",
          userExternalId: evt.userExternalId,
          orgExternalId: evt.orgExternalId,
        }),
      );
    } catch {
      // Best-effort: a transient send failure just misses one invalidation;
      // the next ingest (or the client's own refetch) recovers the list.
    }
  }

  close(): Promise<void> {
    this.stopped = true;
    this._state = "closing";
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this._state = "offline";
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;
      ws.close();
    });
  }

  private async dial(
    config: FortressConfig,
    onFirstConnect: () => void,
    onFirstFail: (error: Error) => void,
  ): Promise<void> {
    if (this.stopped) {
      this._state = "offline";
      return;
    }

    let firstSettled = false;
    const settle = (error?: Error): void => {
      if (firstSettled) return;
      firstSettled = true;
      if (error) onFirstFail(error);
      else onFirstConnect();
    };

    let cred: CloudCredential | null;
    try {
      cred = await this.deps.credentialStore.load();
    } catch (err) {
      this._state = "offline";
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!cred && !this.activeEnrollToken) {
      this._state = "offline";
      settle(new Error("No Fortress credentials and no enrollment token — cannot connect"));
      return;
    }

    const ws = new WebSocket(config.cloud.url);
    this.ws = ws;

    const send = (frame: FortressToHubFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
    };

    ws.addEventListener("open", () => {
      this.backoff = this.reconnectMinMs;
      // A pending enrollment token only survives on disk until enrollment
      // succeeds (onEnrolled clears it), so its presence is the operator's fresh
      // (re-)bootstrap intent and must win over any leftover credentials.json
      // from a previous install — otherwise a stale credential shadows the token
      // and the hub rejects the stale `hello` with `invalid_credential`.
      if (this.activeEnrollToken) {
        send({ t: "enroll", enrollToken: this.activeEnrollToken, ...this.deps.identity });
      } else if (cred) {
        send({
          t: "hello",
          fortressId: cred.fortressId,
          credential: cred.credential,
          ...this.deps.identity,
        });
      }
      let lastStatsAt = 0;
      const STATS_MIN_INTERVAL_MS = 60_000;
      this.heartbeatTimer = setInterval(() => {
        send({ t: "heartbeat" });
        // MC-2368: piggyback collection counts on the heartbeat tick — no second
        // timer to leak/stack on reconnect. Throttled + best-effort so a slow or
        // failed compute never delays the liveness ping.
        const now = Date.now();
        if (this.deps.collectionStats && now - lastStatsAt >= STATS_MIN_INTERVAL_MS) {
          lastStatsAt = now;
          void this.deps
            .collectionStats()
            .then((stats) => {
              if (stats) send({ t: "collectionStats", stats });
            })
            .catch(() => {});
        }
      }, this.heartbeatMs);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      // Drop an oversized frame BEFORE parsing it (DoS guard), and use the
      // non-throwing decoder so a malformed envelope returns without dispatch
      // instead of throwing out of the read loop. Measure BYTES (UTF-8), not
      // `raw.length` (UTF-16 code units), so a multi-byte payload can't sneak past
      // the byte ceiling.
      if (Buffer.byteLength(raw) > this.maxFrameBytes) return;
      const decoded = safeDecodeFrame<HubToFortressFrame>(raw);
      if (!decoded.ok) return;
      void this.handleFrame(decoded.frame, send, settle);
    });

    ws.addEventListener("close", () => {
      this.clearHeartbeat();
      if (this.stopped) {
        this._state = "offline";
        const resolve = this.closeResolve;
        this.closeResolve = null;
        resolve?.();
        settle(new Error("Connection closed before authentication completed"));
        return;
      }
      this._state = "connecting";
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.reconnectMaxMs);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.dial(config, () => {}, () => {});
      }, wait);
    });

    ws.addEventListener("error", () => {
      if (!firstSettled) {
        this.deps.logger.error("Fortress cloud connection error");
      }
    });
  }

  private async handleFrame(
    frame: HubToFortressFrame,
    send: (f: FortressToHubFrame) => void,
    settle: (error?: Error) => void,
  ): Promise<void> {
    switch (frame.t) {
      case "enrolled": {
        if (frame.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
          const error = new Error(
            `Unsupported protocol version from hub: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
          );
          this.deps.logger.error(error.message);
          this.stopped = true;
          settle(error);
          this.ws?.close();
          return;
        }
        await this.persistSigningKey(frame.orgId, frame.signingPublicKey, frame.keyProof);
        // The one-time token is now spent; reconnects must authenticate with the
        // saved credential via hello, never re-send the consumed token.
        this.activeEnrollToken = null;
        const cred: CloudCredential = {
          orgId: frame.orgId,
          fortressId: frame.fortressId,
          credential: frame.credential,
        };
        try {
          await this.deps.credentialStore.save(cred);
        } catch (err) {
          this.deps.logger.error("Failed to save Fortress credentials", err);
        }
        try {
          await this.deps.onEnrolled?.(cred);
        } catch (err) {
          this.deps.logger.error("onEnrolled hook failed", err);
        }
        this._reason = null;
        this._message = null;
        this._state = "connected";
        settle();
        break;
      }
      case "welcome": {
        if (frame.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
          const error = new Error(
            `Unsupported protocol version from hub: ${frame.protocolVersion} (client supports ${SUPPORTED_PROTOCOL_VERSION})`,
          );
          this.deps.logger.error(error.message);
          this.stopped = true;
          settle(error);
          this.ws?.close();
          return;
        }
        await this.persistSigningKey(frame.orgId, frame.signingPublicKey, frame.keyProof);
        this._reason = null;
        this._message = null;
        this._state = "connected";
        settle();
        break;
      }
      case "moduleMessage": {
        const reply = await this.deps.dispatcher.dispatch(frame.data);
        if (reply) {
          send({ t: "moduleReply", id: frame.data.id, reply });
        }
        break;
      }
      case "rpc": {
        const method = (frame.req as { method?: string }).method ?? "";
        // H-4 · authorize the vault RPC with its cloud-signed grant. selfTest is
        // an object-free liveness probe and is never gated. A present grant is
        // fully verified and its principal bound into the RPC (authz); a present-
        // but-invalid grant fails closed. An ABSENT grant is admitted only while
        // FORTRESS_TUNNEL_GRANT_ENFORCE is off, so current traffic keeps working.
        let authz: VaultAuthz | undefined;
        if (method !== "selfTest") {
          if (frame.grant) {
            if (!this.deps.verifyGrant) {
              send({ t: "rpcError", id: frame.id, error: "unauthorized" });
              break;
            }
            try {
              // Vault RPCs are OWN-OBJECT: a read grant is sub-bound with NO
              // scopeHash (the boundary is key.userId === grant.sub, enforced in
              // handleVaultRpc) — requireScope:false, or every tunnel read would
              // throw `unauthorized` once grants ship. (No-op for ingest writes.)
              const grant = await this.deps.verifyGrant(frame.grant, {
                purpose: vaultRpcPurpose(method),
                requireScope: false,
              });
              authz = { sub: grant.sub, scopeHash: grant.scopeHash };
            } catch {
              send({ t: "rpcError", id: frame.id, error: "unauthorized" });
              break;
            }
          } else if (isTunnelGrantEnforcing()) {
            // Absent grant under enforcement — the SAME code the HTTP gateway + MCP
            // layer use (a present-but-invalid grant stays `unauthorized` above).
            send({ t: "rpcError", id: frame.id, error: GRANT_REQUIRED_ERROR });
            break;
          }
        }
        const msgData: MsgData & { authz?: VaultAuthz } = {
          module: "session_vault",
          id: frame.id,
          kind: "request",
          payload: frame.req,
        };
        if (authz) msgData.authz = authz;
        const reply = await this.deps.dispatcher.dispatch(msgData);
        if (reply) {
          if (reply.ok) {
            send({ t: "rpcResult", id: frame.id, result: reply.payload });
          } else {
            this.deps.logger.error(`vault RPC error: ${reply.error}`);
            send({ t: "rpcError", id: frame.id, error: reply.error });
          }
        }
        break;
      }
      case "mcpRpc": {
        if (this.deps.mcp) await dispatchMcpFrame(this.deps.mcp, frame, send, this.deps.logger);
        break;
      }
      case "heartbeatAck":
        break;
      case "moduleAdvertise": {
        const { moduleId, version, artifactUrl, checksum } = frame;
        // The detached-signature sidecar rides on `moduleAdvertise.signature`.
        // Read it defensively so an older hub/protocol without the field still
        // parses (the loader then fails closed only when enforcing).
        const signature =
          "signature" in frame && typeof frame.signature === "string"
            ? frame.signature
            : undefined;
        if (this.deps.moduleLoader) {
          try {
            await this.deps.moduleLoader.install({
              moduleId,
              version,
              artifactUrl,
              checksum,
              signature,
            });
            send({ t: "moduleInstallResult", moduleId, version, ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.error(`Failed to install module: ${moduleId}`, error);
            send({ t: "moduleInstallResult", moduleId, version, ok: false, error: message });
          }
        }
        break;
      }
      case "moduleRemove": {
        const { moduleId } = frame;
        if (this.deps.moduleLoader) {
          try {
            await this.deps.moduleLoader.uninstall(moduleId);
            send({ t: "moduleRemoveResult", moduleId, ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.error(`Failed to remove module: ${moduleId}`, error);
            send({ t: "moduleRemoveResult", moduleId, ok: false, error: message });
          }
        }
        break;
      }
      case "fatal": {
        this._reason = frame.reason;
        this._message = `Hub rejected connection: ${frame.reason}`;
        this.deps.logger.error(`Fortress hub rejected connection: ${frame.reason}`);
        this.stopped = true;
        settle(new Error(this._message));
        this.ws?.close();
        break;
      }
    }
  }

  private async persistSigningKey(
    orgId: string,
    signingPublicKey?: string,
    keyProof?: KeyProof,
  ): Promise<void> {
    if (!signingPublicKey) return;
    const store = this.deps.signingKeyStore;
    if (!store) return;
    try {
      // H-2 pin-floor: pin on first sight; reject a later CHANGE that lacks a
      // valid root proof (keeps the existing pin, logs signing_key_rotation_rejected).
      await persistSigningKeyPin({
        store,
        orgId,
        incomingKey: signingPublicKey,
        keyProof,
        log: (msg, fields) => this.deps.logger.error(msg, fields),
      });
    } catch (err) {
      this.deps.logger.error("Failed to persist org signing key", err);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
