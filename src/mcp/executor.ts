import type { HxDb } from "../host/postgres/db";
import type { McpTunnelRequest, McpTunnelResult } from "../protocol/frames";
import { capToolOutput } from "./output-limit";
import type { HxToolRegistry } from "./registry";

export interface McpExecutorDeps {
  registry: HxToolRegistry;
  db: () => HxDb | null;
}

export async function handleMcpTunnelRequest(
  deps: McpExecutorDeps,
  req: McpTunnelRequest,
): Promise<McpTunnelResult> {
  if (req.method === "listTools") {
    return { method: "listTools", tools: deps.registry.list() };
  }
  const tool = deps.registry.get(req.name);
  if (!tool) {
    return { method: "callTool", content: capToolOutput(`Unknown tool "${req.name}".`), isError: true };
  }
  try {
    // run() zod-validates args (bad args → isError result, not a throw).
    const result = await tool.run(req.arguments, { db: deps.db(), userId: req.userId });
    return { method: "callTool", content: capToolOutput(result.content), isError: result.isError };
  } catch (err) {
    // Unexpected tool fault is a *result* (the agent reads + reacts), not a
    // transport fault. Never let it reach the mcpRpcError channel.
    const message = err instanceof Error ? err.message : String(err);
    return { method: "callTool", content: capToolOutput(`Tool failed: ${message}`), isError: true };
  }
}
