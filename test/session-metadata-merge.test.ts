// What a REPLAYED sidecar does to the one already in the bucket.
//
// A parked sidecar is a whole composition the gateway made from the sidecar as
// it stood before the pause — not a delta. Reads stay open through a pause, so
// every deferred commit in one episode composed from the SAME pre-pause text,
// and replaying those verbatim let the last one erase everything the earlier
// ones had added. The merge is what makes a replay additive again.

import { describe, expect, test } from "bun:test";

import {
  mergeReplayedMetadata,
  parseSessionMetadata,
} from "../src/modules/session-vault/store/session-metadata";
import type { SessionMetadata } from "../src/modules/session-vault/store/types";

function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    family: "claude",
    sessionId: "s1",
    title: null,
    titleSource: null,
    bytesUploaded: 0,
    eventCount: 0,
    userTextCount: 0,
    assistantCount: 0,
    lastActivityAt: null,
    firstSeenAt: "2026-08-05T04:00:00.000Z",
    updatedAt: "2026-08-05T04:00:00.000Z",
    cwd: null,
    gitBranch: null,
    sourcePath: null,
    repoSlug: null,
    deviceName: null,
    ...over,
  };
}

describe("mergeReplayedMetadata", () => {
  test("a later replay never erases what an earlier one set", () => {
    // Two commits inside one pause: the first carries the title (an hx client
    // titles a from-zero upload), the second does not — and composed from the
    // same pre-pause text, so its own title field is null.
    const afterFirst = meta({
      title: "Fixing the migration",
      titleSource: "ai",
      eventCount: 17,
      bytesUploaded: 900,
      lastActivityAt: "2026-08-05T04:01:00.000Z",
      updatedAt: "2026-08-05T04:01:00.000Z",
      cwd: "/w/repo",
    });
    const second = meta({
      eventCount: 31,
      bytesUploaded: 1500,
      lastActivityAt: "2026-08-05T04:02:00.000Z",
      firstSeenAt: "2026-08-05T04:02:00.000Z",
      updatedAt: "2026-08-05T04:02:00.000Z",
    });

    const merged = mergeReplayedMetadata(afterFirst, second);
    expect(merged.title).toBe("Fixing the migration");
    expect(merged.titleSource).toBe("ai");
    expect(merged.cwd).toBe("/w/repo");
    // Counts move forward only.
    expect(merged.eventCount).toBe(31);
    expect(merged.bytesUploaded).toBe(1500);
    expect(merged.lastActivityAt).toBe("2026-08-05T04:02:00.000Z");
    // …and first-seen moves backward only.
    expect(merged.firstSeenAt).toBe("2026-08-05T04:00:00.000Z");
  });

  test("an OUT-OF-ORDER replay does not regress the bucket", () => {
    // The ordering by parkedAt is a belt; this is the brace. Replaying the older
    // composition after the newer one must still leave the newer facts standing.
    const newer = meta({ eventCount: 31, lastActivityAt: "2026-08-05T04:02:00.000Z" });
    const older = meta({ eventCount: 17, lastActivityAt: "2026-08-05T04:01:00.000Z", title: "T" });
    const merged = mergeReplayedMetadata(newer, older);
    expect(merged.eventCount).toBe(31);
    expect(merged.lastActivityAt).toBe("2026-08-05T04:02:00.000Z");
    // …while still recovering what only the older one carried.
    expect(merged.title).toBe("T");
  });

  test("nothing in the bucket means the replay lands as parked", () => {
    const only = meta({ title: "T", eventCount: 3 });
    expect(mergeReplayedMetadata(null, only)).toEqual(only);
  });

  test("a REPLACE is authoritative — its totals may legitimately be smaller", () => {
    // The gateway composes a replace's totals verbatim, and the hub's
    // destination bookkeeping says the same: "a canonical really can shrink".
    // Merging them forward pinned the sidecar to the pre-replace numbers.
    const bucket = meta({ bytesUploaded: 4096, eventCount: 42, title: "old" });
    const replaced = meta({ bytesUploaded: 120, eventCount: 2, title: "new" });
    const merged = mergeReplayedMetadata(bucket, replaced, true);
    expect(merged.bytesUploaded).toBe(120);
    expect(merged.eventCount).toBe(2);
    expect(merged.title).toBe("new");
    // …and an APPEND still moves forward only.
    expect(mergeReplayedMetadata(bucket, replaced, false).eventCount).toBe(42);
  });

  test("title and its PROVENANCE move together", () => {
    // Resolved from different sides, an AI-derived title ended up labelled
    // operator-set: the source is a claim about the value, not a value of its
    // own.
    const merged = mergeReplayedMetadata(
      meta({ title: "Q3 payroll", titleSource: "ai" }),
      meta({ title: null, titleSource: "user" }),
    );
    expect(merged.title).toBe("Q3 payroll");
    expect(merged.titleSource).toBe("ai");
  });

  test("the merge is over PARSED metadata, so a torn sidecar is not merged into", () => {
    expect(parseSessionMetadata(JSON.parse("null"))).toBeNull();
    expect(parseSessionMetadata({ family: "claude" })).toBeNull();
    // The shape this test's title actually claims: unparseable TEXT, which is
    // what a torn object in the bucket is. It must not throw — the replay
    // callback treats an unreadable current as absent rather than re-parking the
    // entry forever.
    expect(() => JSON.parse("{ not json")).toThrow();
    const readTorn = (raw: string | null): ReturnType<typeof parseSessionMetadata> => {
      try {
        return parseSessionMetadata(JSON.parse(raw ?? "null") as unknown);
      } catch {
        return null;
      }
    };
    expect(readTorn("{ not json")).toBeNull();
    expect(readTorn(null)).toBeNull();
  });
});
