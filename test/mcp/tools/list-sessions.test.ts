import { test, expect } from "bun:test";
import type { FortressSessionRow } from "../../../src/modules/session-vault/store/rpc";
import { makeListSessionsTool } from "../../../src/mcp/tools/list-sessions";

const ONE_ROW: FortressSessionRow[] = [{
  family: "claude", sessionId: "s1", title: "t", titleSource: "ai", cwd: null,
  gitBranch: null, sourcePath: null, repoSlug: null, orgName: null, projectName: null, model: null,
  eventCount: 0, userTextCount: 0, assistantCount: 0, toolCallCount: 0, inputTokens: 0,
  outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estCostUsd: null, bytesUploaded: 0,
  deviceName: null, firstSeenAt: "2026-01-01T00:00:00Z", lastActivityAt: null,
  updatedAt: "2026-01-01T00:00:00Z",
}];

test("returns paginated JSON and forwards limit + offset", async () => {
  let seen: { userId: string; limit?: number; offset?: number } | undefined;
  const tool = makeListSessionsTool(async (_db, opts) => { seen = opts; return ONE_ROW; });
  const res = await tool.run({ limit: 10, offset: 20 }, { db: {} as never, userId: "u1" });
  expect(res.isError).toBeUndefined();
  expect(seen).toEqual({ userId: "u1", limit: 10, offset: 20 });
  const parsed = JSON.parse(res.content) as { sessions: unknown[]; page: { limit: number; offset: number; count: number } };
  expect(parsed.sessions).toHaveLength(1);
  expect(parsed.page).toEqual({ limit: 10, offset: 20, count: 1 });
});

test("defaults to a page-sized limit when omitted", async () => {
  let seen: { userId: string; limit?: number; offset?: number } | undefined;
  const tool = makeListSessionsTool(async (_db, opts) => { seen = opts; return []; });
  await tool.run({}, { db: {} as never, userId: "u1" });
  expect(seen?.limit).toBe(50);
});

test("rejects a non-integer limit as an isError result", async () => {
  const tool = makeListSessionsTool(async () => []);
  const res = await tool.run({ limit: "lots" }, { db: {} as never, userId: "u1" });
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/invalid arguments/i);
});

test("errors cleanly when Postgres is not ready (db null)", async () => {
  const tool = makeListSessionsTool(async () => []);
  const res = await tool.run({}, { db: null, userId: "u1" });
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/not ready/i);
});
