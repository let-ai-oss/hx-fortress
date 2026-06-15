/**
 * Loopback hub for CI — simulates the Let.ai cloud hub over a real local WebSocket.
 * Responds to enroll/hello/heartbeat automatically; tests can inject frames and
 * inspect everything received. T14/T16 import this to drive end-to-end tests
 * without a live cloud connection.
 */

import type { ServerWebSocket } from "bun";
import { decodeFrame, encodeFrame } from "../src/protocol/codec";
import type { FortressToHubFrame, HubToFortressFrame } from "../src/protocol/frames";
import { SUPPORTED_PROTOCOL_VERSION } from "../src/cloud/connection";

export interface FakeHubOptions {
  /** Override the org id sent in enrolled/welcome (default "test-org"). */
  orgId?: string;
  /** Override the fortress id sent in enrolled (default "test-fortress"). */
  fortressId?: string;
  /** Override the credential sent in enrolled (default "test-credential"). */
  credential?: string;
  /** Override the protocol version reported in enrolled/welcome (default SUPPORTED_PROTOCOL_VERSION). */
  protocolVersion?: number;
  /**
   * If set, the hub sends a `fatal` frame immediately after receiving hello/enroll
   * instead of the normal enrolled/welcome response.
   */
  rejectWith?: string;
}

export class FakeHub {
  readonly url: string;
  private readonly server: Bun.Server<undefined>;
  private socket: ServerWebSocket<undefined> | null = null;
  private _received: FortressToHubFrame[] = [];
  private readonly opts: Required<Omit<FakeHubOptions, "rejectWith">> & Pick<FakeHubOptions, "rejectWith">;

  constructor(options: FakeHubOptions = {}) {
    this.opts = {
      orgId: options.orgId ?? "test-org",
      fortressId: options.fortressId ?? "test-fortress",
      credential: options.credential ?? "test-credential",
      protocolVersion: options.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION,
      rejectWith: options.rejectWith,
    };

    this.server = Bun.serve<undefined>({
      port: 0,
      fetch: (req, server) => {
        if (server.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.socket = ws;
        },
        message: (ws, data) => {
          const raw = typeof data === "string" ? data : data.toString();
          let frame: FortressToHubFrame;
          try {
            frame = decodeFrame<FortressToHubFrame>(raw);
          } catch {
            return;
          }
          this._received.push(frame);
          this.autoRespond(ws, frame);
        },
        close: () => {
          this.socket = null;
        },
      },
    });

    this.url = `ws://localhost:${this.server.port}`;
  }

  /** All frames received from the Fortress client, in arrival order. */
  received(): readonly FortressToHubFrame[] {
    return [...this._received];
  }

  /** Send a frame down to the connected Fortress client. */
  send(frame: HubToFortressFrame): void {
    this.socket?.send(encodeFrame(frame));
  }

  /** Stop the hub server, immediately closing any open connections. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private autoRespond(ws: ServerWebSocket<undefined>, frame: FortressToHubFrame): void {
    const { orgId, fortressId, credential, protocolVersion, rejectWith } = this.opts;

    if (frame.t === "enroll") {
      if (rejectWith) {
        ws.send(encodeFrame({ t: "fatal", reason: rejectWith }));
      } else {
        ws.send(encodeFrame({ t: "enrolled", orgId, fortressId, credential, protocolVersion }));
      }
    } else if (frame.t === "hello") {
      if (rejectWith) {
        ws.send(encodeFrame({ t: "fatal", reason: rejectWith }));
      } else {
        ws.send(encodeFrame({ t: "welcome", orgId, protocolVersion }));
      }
    } else if (frame.t === "heartbeat") {
      ws.send(encodeFrame({ t: "heartbeatAck" }));
    }
  }
}
