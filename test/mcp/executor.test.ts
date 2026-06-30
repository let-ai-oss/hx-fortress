import { test, expect } from "bun:test";
import { z } from "zod";
import { HxToolRegistry, defineTool } from "../../src/mcp/registry";
import { MAX_TOOL_OUTPUT_CHARS } from "../../src/mcp/output-limit";
import { handleMcpTunnelRequest } from "../../src/mcp/executor";

const echo = defineTool({
  name: "hx_clarity_echo",
  description: "echo",
  schema: z.object({ msg: z.string().describe("text to echo") }),
  execute: async ({ msg }, ctx) => ({ content: `${ctx.userId}:${msg}` }),
});
const boom = defineTool({
  name: "hx_clarity_boom",
  description: "boom",
  schema: z.object({}),
  execute: async () => { throw new Error("db exploded"); },
});
const flood = defineTool({
  name: "hx_clarity_flood",
  description: "flood",
  schema: z.object({}),
  execute: async () => ({ content: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 5_000) }),
});
const deps = { registry: new HxToolRegistry([echo, boom, flood]), db: () => null };

test("listTools returns the registry defs", async () => {
  const res = await handleMcpTunnelRequest(deps, { method: "listTools" });
  if (res.method !== "listTools") throw new Error("narrow");
  expect(res.tools.map((t) => t.name)).toEqual(["hx_clarity_echo", "hx_clarity_boom", "hx_clarity_flood"]);
});

test("callTool runs the tool with the supplied userId", async () => {
  const res = await handleMcpTunnelRequest(deps, {
    method: "callTool", name: "hx_clarity_echo", arguments: { msg: "hi" }, userId: "u9",
  });
  if (res.method !== "callTool") throw new Error("narrow");
  expect(res.content).toBe("u9:hi");
  expect(res.isError).toBeUndefined();
});

test("invalid args surface as an isError result (validation in run)", async () => {
  const res = await handleMcpTunnelRequest(deps, {
    method: "callTool", name: "hx_clarity_echo", arguments: { msg: 5 }, userId: "u9",
  });
  if (res.method !== "callTool") throw new Error("narrow");
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/invalid arguments/i);
});

test("callTool on unknown tool is a tool error, not a throw", async () => {
  const res = await handleMcpTunnelRequest(deps, {
    method: "callTool", name: "missing", arguments: {}, userId: "u9",
  });
  if (res.method !== "callTool") throw new Error("narrow");
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/unknown tool/i);
});

test("a tool that throws becomes an isError result, never a rejected promise", async () => {
  const res = await handleMcpTunnelRequest(deps, {
    method: "callTool", name: "hx_clarity_boom", arguments: {}, userId: "u9",
  });
  if (res.method !== "callTool") throw new Error("narrow");
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/db exploded/);
  expect(res.content.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 200);
});

test("oversized output is capped by the executor", async () => {
  const res = await handleMcpTunnelRequest(deps, {
    method: "callTool", name: "hx_clarity_flood", arguments: {}, userId: "u9",
  });
  if (res.method !== "callTool") throw new Error("narrow");
  expect(res.content.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 200);
  expect(res.content).toMatch(/truncated/i);
});
