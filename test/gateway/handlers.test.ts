import { describe, it, expect } from "bun:test";
import { handleAppendUrl, handleCommit } from "../../src/gateway/handlers";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

function fakeStore(overrides: Partial<SessionStore> = {}): SessionStore {
  const base: SessionStore = {
    signStagingUpload: async () => ({
      url: "https://bucket.example/presigned",
      objectName: "obj/abc",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
    readChunkText: async () => "",
    appendChunkToCanonical: async () => ({ totalBytes: 42, componentCount: 2 }),
    statCanonical: async () => null,
    signCanonicalDownload: async () => ({
      url: "https://bucket.example/canonical",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
    readCanonicalText: async () => "",
    writeArtifact: async () => {},
    readArtifactText: async () => null,
    selfTest: async () => {},
  };
  return { ...base, ...overrides };
}

describe("handleAppendUrl", () => {
  it("returns the presigned upload URL from the store", async () => {
    const res = await handleAppendUrl(fakeStore(), {
      userId: "u1",
      family: "claude",
      sessionId: "s1",
      chunkId: "c1",
    });
    expect(res.uploadUrl).toBe("https://bucket.example/presigned");
    expect(res.objectName).toBe("obj/abc");
    expect(res.chunkId).toBe("c1");
  });
});

describe("handleCommit", () => {
  it("composes the chunk and returns totals", async () => {
    const res = await handleCommit(fakeStore(), {
      userId: "u1",
      family: "claude",
      sessionId: "s1",
      chunkId: "c1",
    });
    expect(res.ok).toBe(true);
    expect(res.totalBytes).toBe(42);
    expect(res.componentCount).toBe(2);
  });
});
