import { test, expect } from "bun:test";
import { encodeFrame, decodeFrame } from "../../src/protocol/codec";
import type { FortressToHubFrame, HubToFortressFrame } from "../../src/protocol/frames";

test("mcpRpc down-frame round-trips", () => {
  const f: HubToFortressFrame = { t: "mcpRpc", id: "1", req: { method: "listTools" } };
  expect(decodeFrame<HubToFortressFrame>(encodeFrame(f))).toEqual(f);
});

test("mcpRpcResult up-frame round-trips", () => {
  const f: FortressToHubFrame = {
    t: "mcpRpcResult", id: "1", result: { method: "callTool", content: "{}" },
  };
  expect(decodeFrame<FortressToHubFrame>(encodeFrame(f))).toEqual(f);
});

test("mcpRpcError up-frame round-trips", () => {
  const f: FortressToHubFrame = { t: "mcpRpcError", id: "9", error: "boom" };
  expect(decodeFrame<FortressToHubFrame>(encodeFrame(f))).toEqual(f);
});

test("mcpRpcResult with isError round-trips", () => {
  const f: FortressToHubFrame = {
    t: "mcpRpcResult",
    id: "2",
    result: { method: "callTool", content: "Tool failed: x", isError: true },
  };
  expect(decodeFrame<FortressToHubFrame>(encodeFrame(f))).toEqual(f);
});
