import { test, expect } from "bun:test";
import { dispatchMcpFrame } from "../../src/cloud/connection";
import type { FortressToHubFrame } from "../../src/protocol/frames";

test("mcpRpc → mcpRpcResult on success", async () => {
  const sent: FortressToHubFrame[] = [];
  await dispatchMcpFrame(
    { handle: async () => ({ method: "listTools", tools: [] }) },
    { t: "mcpRpc", id: "7", req: { method: "listTools" } },
    (f) => sent.push(f),
    { error: () => {} },
  );
  expect(sent).toEqual([{ t: "mcpRpcResult", id: "7", result: { method: "listTools", tools: [] } }]);
});

test("mcpRpc → mcpRpcError when the executor throws", async () => {
  const sent: FortressToHubFrame[] = [];
  await dispatchMcpFrame(
    { handle: async () => { throw new Error("boom"); } },
    { t: "mcpRpc", id: "8", req: { method: "listTools" } },
    (f) => sent.push(f),
    { error: () => {} },
  );
  expect(sent).toEqual([{ t: "mcpRpcError", id: "8", error: "boom" }]);
});
