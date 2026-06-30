import { test, expect } from "bun:test";
import { z } from "zod";
import { HxToolRegistry, defineTool } from "../../src/mcp/registry";
import { capToolOutput, MAX_TOOL_OUTPUT_CHARS } from "../../src/mcp/output-limit";

const demo = defineTool({
  name: "hx_clarity_demo",
  description: "demo",
  schema: z.object({ q: z.string().describe("query text") }),
  execute: async ({ q }) => ({ content: `got:${q}` }),
});

test("list() emits a JSON Schema generated from the zod schema", () => {
  const reg = new HxToolRegistry([demo]);
  const [def] = reg.list();
  expect(def.name).toBe("hx_clarity_demo");
  expect(def.inputSchema).toMatchObject({ type: "object" });
  // the described property surfaces in the schema
  expect(JSON.stringify(def.inputSchema)).toMatch(/query text/);
});

test("run() rejects invalid args as an isError result (no throw)", async () => {
  const res = await demo.run({ q: 123 }, { db: null, userId: "u1" });
  expect(res.isError).toBe(true);
  expect(res.content).toMatch(/invalid arguments/i);
});

test("run() passes parsed, typed args to execute", async () => {
  const res = await demo.run({ q: "hi" }, { db: null, userId: "u1" });
  expect(res).toEqual({ content: "got:hi" });
});

test("duplicate tool names throw at construction", () => {
  expect(() => new HxToolRegistry([demo, demo])).toThrow(/duplicate/i);
});

test("capToolOutput truncates past the limit with a marker", () => {
  const big = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100);
  const capped = capToolOutput(big);
  expect(capped.length).toBeLessThan(big.length);
  expect(capped).toMatch(/truncated/i);
  expect(capToolOutput("short")).toBe("short");
});
