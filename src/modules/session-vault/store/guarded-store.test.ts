// GuardedStore: the per-call deadline + rebuild-after-breaches decorator born
// from the 2026-07-30 prod wedge (hung GCS pool, silent zero-ingest for 3h).
import { describe, expect, it } from "bun:test";
import { GuardedStore, StoreDeadlineError, type GuardedStoreOptions } from "./guarded-store.js";
import type { SessionStore } from "./types.js";

const KEY = { userId: "u", family: "claude-cli", sessionId: "s" };

/** A stub store whose statCanonical resolves after `delayMs`; everything else
 *  is unreachable in these tests. */
function stubStore(delayMs: number, onCall?: () => void): SessionStore {
  const never = (): Promise<never> => Promise.reject(new Error("unused in test"));
  return {
    statCanonical: () => {
      onCall?.();
      return new Promise((resolve) => setTimeout(() => resolve(1), delayMs));
    },
    selfTest: () => new Promise((resolve) => setTimeout(resolve, delayMs)),
    signStagingUpload: never,
    readChunkText: never,
    appendChunkToCanonical: () => Promise.reject(new Error("backend_says_no")),
    signCanonicalDownload: never,
    readCanonicalText: never,
    writeCanonicalText: never,
    writeArtifact: never,
    readArtifactText: never,
    listSessionMetadata: never,
    listAllCanonicalKeys: () => new Promise((resolve) => setTimeout(() => resolve([]), delayMs)),
    deleteSession: never,
  } as SessionStore;
}

const fast = (over: Partial<GuardedStoreOptions> = {}): GuardedStoreOptions => ({
  opTimeoutMs: 20,
  heavyOpTimeoutMs: 40,
  scanTimeoutMs: 80,
  rebuildAfter: 3,
  ...over,
});

describe("GuardedStore", () => {
  it("turns a hung call into a StoreDeadlineError instead of waiting forever", async () => {
    const store = new GuardedStore(() => stubStore(1_000), fast());
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
  });

  it("rebuilds the inner store after consecutive breaches, and the rebuilt one serves", async () => {
    let builds = 0;
    const store = new GuardedStore(() => {
      builds += 1;
      // First client hangs everything; the rebuilt one is healthy.
      return stubStore(builds === 1 ? 1_000 : 0);
    }, fast());
    for (let i = 0; i < 3; i += 1) {
      await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(builds).toBe(2);
    expect(await store.statCanonical(KEY)).toBe(1);
  });

  it("a success resets the breach streak", async () => {
    let builds = 0;
    let delay = 1_000;
    const store = new GuardedStore(() => {
      builds += 1;
      return {
        ...stubStore(0),
        statCanonical: () => new Promise((resolve) => setTimeout(() => resolve(1), delay)),
      } as SessionStore;
    }, fast());
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    delay = 0;
    expect(await store.statCanonical(KEY)).toBe(1); // streak resets here
    delay = 1_000;
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(builds).toBe(1); // never reached rebuildAfter consecutively
  });

  it("backend errors pass through unchanged and do not count as breaches", async () => {
    let builds = 0;
    const store = new GuardedStore(() => {
      builds += 1;
      return stubStore(0);
    }, fast({ rebuildAfter: 1 }));
    for (let i = 0; i < 3; i += 1) {
      await expect(store.appendChunkToCanonical(KEY, "c1")).rejects.toThrow("backend_says_no");
    }
    expect(builds).toBe(1);
  });

  it("the whole-bucket scan gets its own larger budget", async () => {
    // Hangs past the op deadline but inside the scan deadline: op-classed calls
    // breach, the scan succeeds.
    const store = new GuardedStore(() => stubStore(50), fast());
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(await store.listAllCanonicalKeys()).toEqual([]);
  });
});
