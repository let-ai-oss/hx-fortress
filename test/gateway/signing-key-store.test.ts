import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSigningKeyStore } from "../../src/gateway/signing-key-store";

describe("FileSigningKeyStore", () => {
  it("round-trips a key and returns null when absent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sk-"));
    const store = new FileSigningKeyStore(path.join(dir, "signing-key"));
    expect(await store.load()).toBeNull();
    await store.save("BASE64URLKEY");
    expect(await store.load()).toBe("BASE64URLKEY");
  });
});
