import { describe, it, expect } from "bun:test";
import { resolveGatewayConfig } from "../../src/host/config";

describe("resolveGatewayConfig", () => {
  it("prefers FORTRESS_PUBLIC_URL over the persisted config value", () => {
    const cfg = resolveGatewayConfig(
      {
        FORTRESS_PUBLIC_URL: "https://fortress.acme.example",
        FORTRESS_GATEWAY_PORT: "8787",
      },
      "http://localhost:8787",
    );
    expect(cfg.gatewayUrl).toBe("https://fortress.acme.example");
    expect(cfg.port).toBe(8787);
    expect(cfg.enabled).toBe(true);
  });

  it("falls back to the persisted config value when env override is absent", () => {
    const cfg = resolveGatewayConfig({}, "http://localhost:8787");
    expect(cfg.enabled).toBe(true);
    expect(cfg.gatewayUrl).toBe("http://localhost:8787");
    expect(cfg.port).toBe(8787);
  });

  it("is disabled when neither env nor config provide a public URL", () => {
    const cfg = resolveGatewayConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(8787);
  });
});
