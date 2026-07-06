// MC-2430 tunnel-MCP handler — serves the fortress's MCP tools over the reverse
// vault tunnel (the transport for a fortress with NO public URL / behind NAT).
// Reuses the SAME tool set as the HTTP-MCP path (src/mcp/tools.ts) + src/gateway
// — one tool registry, two transports (tunnel default, HTTP when reachable).
import type { McpTunnelRequest, McpTunnelResult } from "../protocol";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";
import type { Embedder } from "../modules/embed-worker/openai";
import type { GrantClaims } from "../gateway/capability-token";
import { isTunnelGrantEnforcing } from "../gateway/capability-token";
import { checkScopeGrant, MCP_TOOLS } from "./tools";

export interface McpTunnelDeps {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  embedder?: Embedder | null;
  /** Verifies a tunnel MCP read grant against the pinned per-org signing key.
   *  Built in main.ts over signingKeyStore.pinnedKey() + the enrolled org id.
   *  Omit to disable grant verification (a present grant then fails closed). */
  verifyGrant?: (
    token: string,
    opts: { purpose: "ingest" | "read"; requireScope?: boolean },
  ) => Promise<GrantClaims>;
}

function toolError(content: unknown): McpTunnelResult {
  return { method: "callTool", content: JSON.stringify(content), isError: true };
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
        return toolError({ error: "unknown_tool", name: req.name });
      }

      // H-4 · a tunnel MCP read is authorized by a cloud-signed read grant bound
      // to (principal, scope). Verify it offline, bind sub↔userId, then require the
      // args scope to match the grant's committed scopeHash. A present-but-invalid
      // grant always fails closed; an ABSENT grant is admitted only when the tunnel
      // enforce flag is off (checkScopeGrant), so current grant-less reads keep working.
      let grant: GrantClaims | undefined;
      if (req.grant) {
        if (!deps.verifyGrant) return toolError({ error: "unauthorized" });
        try {
          // A tunnel MCP read is SCOPE-BOUND — checkScopeGrant recomputes the
          // args scope against the grant's committed scopeHash — so requireScope:true.
          grant = await deps.verifyGrant(req.grant, { purpose: "read", requireScope: true });
        } catch {
          return toolError({ error: "unauthorized" });
        }
        if (grant.sub !== req.userId) return toolError({ error: "principal_object_mismatch" });
      }

      const gate = checkScopeGrant(req.arguments, grant, isTunnelGrantEnforcing());
      if (gate) return { method: "callTool", content: gate.content[0]?.text ?? "", isError: true };

      const res = await tool.handle(req.arguments, {
        db: deps.db(),
        store: deps.store(),
        embedder: deps.embedder ?? null,
        grant,
      });
      return { method: "callTool", content: res.content[0]?.text ?? "", isError: res.isError };
    },
  };
}
