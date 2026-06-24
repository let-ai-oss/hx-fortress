import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_GATEWAY_PUBLIC_URL } from "../src/host/config";
import { fortressPaths } from "../src/host/paths";
import {
  maybeKeepExistingVaultConfig,
  resolveGatewayPublicUrlInput,
} from "../src/modules/session-vault/wizard";

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

describe("maybeKeepExistingVaultConfig", () => {
  test("keeps an existing enrolled config without staging a new enrollment token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hx-fortress-reinstall-"));
    try {
      const paths = fortressPaths(root);
      await mkdir(path.dirname(paths.credentials), { recursive: true });
      await writeFile(
        paths.config,
        JSON.stringify({
          schemaVersion: 1,
          cloud: { url: "wss://existing.let.ai/_api/hx-gateway/vault-tunnel" },
          gateway: { publicUrl: "https://fortress.example" },
          modules: { enabled: ["session_vault"] },
        }),
      );
      await writeFile(
        paths.credentials,
        JSON.stringify({
          orgId: "org-1",
          fortressId: "fortress-1",
          credential: "credential-1",
        }),
      );
      await writeFile(
        paths.pendingEnrollment,
        JSON.stringify({
          token: "stale-token",
          cloudUrl: "wss://new.let.ai/_api/hx-gateway/vault-tunnel",
        }),
      );

      const kept = await maybeKeepExistingVaultConfig(
        {
          cloudUrl: "wss://new.let.ai/_api/hx-gateway/vault-tunnel",
          token: "fresh-token",
          log() {},
          fortressRoot: root,
        },
        async () => true,
      );

      expect(kept).toBe(true);
      await expect(readFile(paths.pendingEnrollment, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
