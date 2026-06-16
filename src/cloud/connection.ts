import { decodeFrame, encodeFrame } from "../protocol/codec";
import type { FortressToHubFrame, HubToFortressFrame } from "../protocol/frames";
import type { FortressIdentity } from "../protocol/identity";
import type { CloudConnection, ConnectionState, FortressConfig, HostLogger, MessageDispatcher, ModuleLifecycleHandler } from "../host/types";
import type { CloudCredential, CredentialStore } from "./credentials";

export const SUPPORTED_PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface WsCloudConnectionDeps {
  dispatcher: MessageDispatcher;
  credentialStore: CredentialStore;
  logger: HostLogger;
  identity: FortressIdentity;
  moduleLoader?: ModuleLifecycleHandler;
  enrollToken?: string;
  /** Called once immediately after a successful enrollment and credential save.
   *  Use to clear the pending enrollment token and propagate identity to modules. */
  onEnrolled?: (cred: CloudCredential) => Promise<void> | void;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class WsCloudConnection implements CloudConnection {
  private _state: ConnectionState = "offline";
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private backoff: number;
  private readonly heartbeatMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private closeResolve: (() => void) | null = null;

  constructor(private readonly deps: WsCloudConnectionDeps) {
    this.reconnectMinMs = deps.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    this.backoff = this.reconnectMinMs;
  }

  state(): ConnectionState {
    return this._state;
  }

  open(config: FortressConfig): Promise<void> {
    this._state = "connecting";
    this.stopped = false;
    this.backoff = this.reconnectMinMs;
    return new Promise<void>((resolve, reject) => {
      void this.dial(config, resolve, reject);
    });
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

    if (!cred && !this.deps.enrollToken) {
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
      if (cred) {
        send({
          t: "hello",
          fortressId: cred.fortressId,
          credential: cred.credential,
          ...this.deps.identity,
        });
      } else {
        send({ t: "enroll", enrollToken: this.deps.enrollToken!, ...this.deps.identity });
      }
      this.heartbeatTimer = setInterval(() => send({ t: "heartbeat" }), this.heartbeatMs);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      let frame: HubToFortressFrame;
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        frame = decodeFrame<HubToFortressFrame>(raw);
      } catch {
        return;
      }
      void this.handleFrame(frame, send, settle);
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
        const msgData = {
          module: "session_vault",
          id: frame.id,
          kind: "request" as const,
          payload: frame.req,
        };
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
      case "heartbeatAck":
        break;
      case "moduleAdvertise": {
        const { moduleId, version, artifactUrl, checksum } = frame;
        if (this.deps.moduleLoader) {
          try {
            await this.deps.moduleLoader.install({ moduleId, version, artifactUrl, checksum });
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
        this.deps.logger.error(`Fortress hub rejected connection: ${frame.reason}`);
        this.stopped = true;
        settle(new Error(`Hub rejected connection: ${frame.reason}`));
        this.ws?.close();
        break;
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
