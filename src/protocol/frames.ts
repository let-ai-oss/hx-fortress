// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

import type { FortressIdentity } from "./identity";
import type { MsgData, MsgReply } from "./messages";

// --- MCP tunnel (MC-2430) ---
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type McpTunnelRequest =
  | { method: "listTools" }
  | { method: "callTool"; name: string; arguments: Record<string, unknown>; userId: string };
export type McpTunnelResult =
  | { method: "listTools"; tools: McpToolDef[] }
  | { method: "callTool"; content: string; isError?: boolean };

export type FortressToHubFrame =
  | ({ t: "enroll"; enrollToken: string } & FortressIdentity)
  | ({ t: "hello"; fortressId: string; credential: string } & FortressIdentity)
  | { t: "heartbeat" }
  | { t: "moduleReply"; id: string; reply: MsgReply }
  | { t: "rpcResult"; id: string; result: unknown }
  | { t: "rpcError"; id: string; error: string }
  // Fortress→cloud realtime invalidation (MC-2415): emitted after an hx ingest
  // so the cloud refreshes the affected user's live "my sessions" queries —
  // including fortress-direct writes the cloud never relayed.
  | { t: "hxInvalidate"; userExternalId: string; orgExternalId: string | null }
  | { t: "moduleInstallResult"; moduleId: string; version: string; ok: true }
  | { t: "moduleInstallResult"; moduleId: string; version: string; ok: false; error: string }
  | { t: "moduleRemoveResult"; moduleId: string; ok: true }
  | { t: "moduleRemoveResult"; moduleId: string; ok: false; error: string }
  | { t: "mcpRpcResult"; id: string; result: McpTunnelResult }
  | { t: "mcpRpcError"; id: string; error: string };

export type HubToFortressFrame =
  | { t: "welcome"; orgId: string; protocolVersion: number; signingPublicKey?: string }
  | {
      t: "enrolled";
      orgId: string;
      fortressId: string;
      credential: string;
      protocolVersion: number;
      signingPublicKey?: string;
    }
  | { t: "moduleMessage"; data: MsgData }
  | { t: "rpc"; id: string; req: unknown }
  | { t: "heartbeatAck" }
  | { t: "fatal"; reason: string }
  | {
      t: "moduleAdvertise";
      moduleId: string;
      version: string;
      artifactUrl: string;
      checksum: string;
    }
  | { t: "moduleRemove"; moduleId: string }
  | { t: "mcpRpc"; id: string; req: McpTunnelRequest };

export type ProtocolFrame = FortressToHubFrame | HubToFortressFrame;
