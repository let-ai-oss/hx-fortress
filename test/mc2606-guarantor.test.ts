import { describe, expect, test } from "bun:test";

import { createGuarantor, guarantorEnabled } from "../src/ingest/guarantor";
import { setReconcileSignalHandler, signalReconcile } from "../src/ingest/reconcile-signal";
import { stripListTitle } from "../src/modules/session-vault/store/session-metadata";
import { parseCanonicalKey } from "../src/modules/session-vault/store/keys";
import type { SessionMetadata } from "../src/modules/session-vault/store/types";

// ── The guarantor kill-switch is INVERTED (default-ON) ──────────────────────
// This is the highest-leverage prerequisite in the plan: parseBooleanEnv is
// false-when-unset, so a plain flag would ship G OFF and the whole self-heal
// would silently no-op. FORTRESS_GUARANTOR_DISABLED must mean "unset ⇒ run".
describe("guarantorEnabled (inverted default-ON kill-switch)", () => {
  test("runs when the disable flag is unset / blank / falsey", () => {
    expect(guarantorEnabled({})).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "0" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "false" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "no" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "junk" })).toBe(true);
  });

  test("is disabled only by an explicit truthy spelling", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: v })).toBe(false);
    }
  });
});

describe("guarantor lifecycle guards", () => {
  test("runOnce no-ops (null) until db + store are both ready", async () => {
    expect(await createGuarantor({ db: () => null, store: () => null }).runOnce()).toBeNull();
    // store present but db still null ⇒ still not ready.
    const fakeStore = { listAllCanonicalKeys: async () => [] } as never;
    expect(await createGuarantor({ db: () => null, store: () => fakeStore }).runOnce()).toBeNull();
  });

  test("signal() and stop() never throw, before or after start", async () => {
    const g = createGuarantor({ db: () => null, store: () => null });
    expect(() => g.signal()).not.toThrow();
    g.start();
    expect(() => g.signal()).not.toThrow();
    await g.stop();
    // Signalling a stopped guarantor is a no-op, not an error.
    expect(() => g.signal()).not.toThrow();
  });
});

// ── The known-failure → guarantor nudge seam ────────────────────────────────
describe("signalReconcile", () => {
  test("fires the wired handler", () => {
    let n = 0;
    setReconcileSignalHandler(() => {
      n += 1;
    });
    signalReconcile();
    signalReconcile();
    expect(n).toBe(2);
    setReconcileSignalHandler(() => {});
  });

  test("swallows a throwing handler (never fails the upload path)", () => {
    setReconcileSignalHandler(() => {
      throw new Error("boom");
    });
    expect(() => signalReconcile()).not.toThrow();
    setReconcileSignalHandler(() => {});
  });

  test("default handler is a silent no-op", () => {
    setReconcileSignalHandler(() => {});
    expect(() => signalReconcile()).not.toThrow();
  });
});

// ── parseCanonicalKey — the whole-bucket orphan scan's object→key inverse ────
describe("parseCanonicalKey", () => {
  test("parses a parent canonical", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1/log.jsonl")).toEqual({
      userId: "u1",
      family: "claude-cli",
      sessionId: "s1",
    });
  });

  test("keeps the agent-lane composite as one segment", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1:a:agent-7/log.jsonl")).toEqual({
      userId: "u1",
      family: "claude-cli",
      sessionId: "s1:a:agent-7",
    });
  });

  test("rejects staging / artifact / compaction / short objects", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1/.staging/c1.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/session.json")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/.compact-123.jsonl")).toBeNull();
    // A chunk literally named "log" would still be one segment too deep.
    expect(parseCanonicalKey("u1/claude-cli/s1/.staging/log.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/log.jsonl")).toBeNull();
    expect(parseCanonicalKey("log.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/log.txt")).toBeNull();
  });
});

// ── stripListTitle — PG-authoritative list title, content-only artifact ──────
describe("stripListTitle", () => {
  const base: SessionMetadata = {
    family: "claude-cli",
    sessionId: "s1",
    title: "A stale artifact title",
    titleSource: "user",
    bytesUploaded: 10,
    eventCount: 3,
    userTextCount: 1,
    assistantCount: 1,
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    cwd: "/work",
    gitBranch: "main",
    sourcePath: "/tmp/s.jsonl",
    repoSlug: "let-ai/let-forge",
    deviceName: "Mac",
  };

  test("nulls title + titleSource, preserves every other field", () => {
    const [out] = stripListTitle([base]);
    expect(out.title).toBeNull();
    expect(out.titleSource).toBeNull();
    expect({ ...out, title: base.title, titleSource: base.titleSource }).toEqual(base);
  });

  test("leaves an already-titleless row untouched (same reference)", () => {
    const titleless: SessionMetadata = { ...base, title: null, titleSource: null };
    const [out] = stripListTitle([titleless]);
    expect(out).toBe(titleless);
  });
});
