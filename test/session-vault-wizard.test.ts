import { describe, expect, test } from "bun:test";
import { DEFAULT_GATEWAY_PUBLIC_URL } from "../src/host/config";
import { resolveGatewayPublicUrlInput } from "../src/modules/session-vault/wizard";

describe("resolveGatewayPublicUrlInput", () => {
  test("returns the localhost default when the operator skips the prompt", () => {
    expect(resolveGatewayPublicUrlInput("")).toBe(DEFAULT_GATEWAY_PUBLIC_URL);
    expect(resolveGatewayPublicUrlInput("   ")).toBe(DEFAULT_GATEWAY_PUBLIC_URL);
  });

  test("preserves an explicit public URL", () => {
    expect(resolveGatewayPublicUrlInput("https://fortress.example")).toBe(
      "https://fortress.example",
    );
  });

  test("rejects an invalid URL", () => {
    expect(() => resolveGatewayPublicUrlInput("fortress.example")).toThrow(
      "gateway.publicUrl must be a valid URL",
    );
  });
});
