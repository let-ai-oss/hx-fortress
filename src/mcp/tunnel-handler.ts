// MC-2430 tunnel-MCP handler — serves the fortress's MCP tools over the reverse
// vault tunnel (the transport for a fortress with NO public URL / behind NAT).
// Reuses the SAME tool set as the HTTP-MCP path (src/mcp/tools.ts) + src/gateway
// — one tool registry, two transports (tunnel default, HTTP when reachable).
import type { McpTunnelRequest, McpTunnelResult } from "../protocol/frames";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";
import type { Embedder } from "../modules/embed-worker/openai";
import { MCP_TOOLS } from "./tools";

export interface McpTunnelDeps {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  embedder?: Embedder | null;
}

/** Build the `mcp.handle` the cloud connection dispatches tunnel MCP frames to. */
export function createMcpTunnelHandler(deps: McpTunnelDeps): {
  handle(req: McpTunnelRequest): Promise<McpTunnelResult>;
} {
  return {
    async handle(req: McpTunnelRequest): Promise<McpTunnelResult> {
      if (req.method === "listTools") {
        return {
          method: "listTools",
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      }
      const tool = MCP_TOOLS.find((t) => t.name === req.name);
      if (!tool) {
        return { method: "callTool", content: JSON.stringify({ error: "unknown_tool", name: req.name }), isError: true };
      }
      const res = await tool.handle(req.arguments, {
        db: deps.db(),
        store: deps.store(),
        embedder: deps.embedder ?? null,
      });
      return { method: "callTool", content: res.content[0]?.text ?? "", isError: res.isError };
    },
  };
}
