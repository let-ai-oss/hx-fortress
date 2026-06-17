import { describe, it, expect } from "bun:test";
import { resolveGatewayConfig } from "../../src/host/config";

describe("resolveGatewayConfig", () => {
  it("returns a gatewayUrl + port when FORTRESS_PUBLIC_URL is set", () => {
    const cfg = resolveGatewayConfig({
      FORTRESS_PUBLIC_URL: "https://fortress.acme.example",
      FORTRESS_GATEWAY_PORT: "8787",
    });
    expect(cfg.gatewayUrl).toBe("https://fortress.acme.example");
    expect(cfg.port).toBe(8787);
    expect(cfg.enabled).toBe(true);
  });

  it("is disabled when no public URL is set", () => {
    const cfg = resolveGatewayConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(8787);
  });
});
