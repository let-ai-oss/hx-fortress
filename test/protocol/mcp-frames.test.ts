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
