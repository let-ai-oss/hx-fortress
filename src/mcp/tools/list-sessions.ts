import { z } from "zod";
import type { HxDb } from "../../host/postgres/db";
import type { FortressSessionRow } from "../../modules/session-vault/store/rpc";
import { listSessionsForUser } from "../../query/list-sessions";
import { defineTool, type HxTool } from "../registry";

type ListFn = (
  db: HxDb,
  opts: { userId: string; limit?: number; offset?: number },
) => Promise<FortressSessionRow[]>;

// MCP-facing default is smaller than the query's 500 so a single page stays
// well under the output cap and the agent's context budget; callers page on.
const MCP_DEFAULT_LIMIT = 50;

const schema = z.object({
  limit: z.number().int().min(1).max(1000).optional()
    .describe("Max sessions to return (default 50, hard cap 1000)."),
  offset: z.number().int().min(0).optional()
    .describe("Rows to skip from the most-recent end, for pagination (default 0)."),
});

/** Factory with an injectable query fn so unit tests need no Postgres. */
export function makeListSessionsTool(query: ListFn): HxTool {
  return defineTool({
    name: "hx_clarity_list_sessions",
    description:
      "List the calling user's recent coding-agent sessions captured by HX Clarity, most recent first. Page with limit + offset.",
    schema,
    async execute({ limit, offset }, ctx) {
      if (!ctx.db) return { content: "Session store is not ready yet.", isError: true };
      const effectiveLimit = limit ?? MCP_DEFAULT_LIMIT;
      const sessions = await query(ctx.db, { userId: ctx.userId, limit: effectiveLimit, offset });
      return {
        content: JSON.stringify({
          sessions,
          page: { limit: effectiveLimit, offset: offset ?? 0, count: sessions.length },
        }),
      };
    },
  });
}

export const listSessionsTool: HxTool = makeListSessionsTool(listSessionsForUser);
