import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import {
  IndexAdvancedError,
  LanePrefixMismatchError,
  ingestCommit,
  type IngestAttribution,
} from "../src/ingest/ingest";
import { markSessionDeleted } from "../src/ingest/delete";
import { reconcileOrphans } from "../src/ingest/reconciler";
import { hxSessionAgents, hxSessions } from "../src/host/postgres/schema/sessions";
import { hxTurns } from "../src/host/postgres/schema/transcript";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import { canonicalObject, parseCanonicalKey } from "../src/modules/session-vault/store/keys";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

// Component G full-restore proof (MC-2606). Runs against a real pgvector Postgres
// when FORTRESS_DATABASE_URL is set; skipped (no failure) otherwise. Run with:
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db bun test test/mc2606-reconciler.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const TS = "2026-07-01T10:00:00Z";
const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

/** A Claude canonical with a real ai-title line + one user + one assistant turn. */
function claudeCanonical(aiTitle: string): string {
  return [
    JSON.stringify({ type: "ai-title", aiTitle }),
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { content: [{ type: "text", text: "please summarise the readme" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    }),
  ].join("\n");
}

/** In-memory store keyed by bucket object name (mirrors GCS/S3 layout). Only
 *  listAllCanonicalKeys + readCanonicalText matter to the reconciler; the rest
 *  are inert stubs. A missing canonical throws NoSuchKey, like the real stores. */
function memStore(canonicals: Map<string, string>): SessionStore {
  return {
    signStagingUpload: async () => ({ url: "", objectName: "", expiresAt: "" }),
    readChunkText: async () => "",
    appendChunkToCanonical: async () => ({ totalBytes: 0, componentCount: 1 }),
    statCanonical: async () => null,
    signCanonicalDownload: async () => ({ url: "", expiresAt: "" }),
    readCanonicalText: async (k: SessionKey) => {
      const text = canonicals.get(canonicalObject(k));
      if (text === undefined) throw new Error("NoSuchKey");
      return text;
    },
    writeCanonicalText: async () => {},
    writeArtifact: async () => {},
    readArtifactText: async () => null,
    listSessionMetadata: async () => [],
    selfTest: async () => {},
    deleteSession: async () => ({ complete: true, deleted: 0 }),
    listAllCanonicalKeys: async () => {
      const out: SessionKey[] = [];
      for (const name of canonicals.keys()) {
        const k = parseCanonicalKey(name);
        if (k) out.push(k);
      }
      return out;
    },
  };
}

describe.if(!!DSN)("Component G — reconciler full restore (MC-2606)", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  beforeAll(async () => {
    await runMigrations(sql, migrations);
    db = createHxDb(dsn);
  });

  // Unique per run so the persistent DB is repeatable.
  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = (m: Map<string, string>) => memStore(m);

  async function sessionRow(key: SessionKey) {
    const [row] = await db
      .select({
        id: hxSessions.id,
        title: hxSessions.title,
        titleSource: hxSessions.titleSource,
        attributionSource: hxSessions.attributionSource,
        orgId: hxSessions.orgId,
      })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    return row ?? null;
  }

  test("re-indexes a row-less canonical: row + turns + real title + recovered attribution", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const canon = new Map([[canonicalObject(key), claudeCanonical("Restore The README")]]);

    const res = await reconcileOrphans(db, store(canon), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.restored).toBe(1);
    expect(res.errors).toBe(0);

    const row = await sessionRow(key);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Restore The README"); // tier-A ai-title, not the floor
    expect(row!.titleSource).toBe("ai");
    expect(row!.attributionSource).toBe("recovered");
    expect(row!.orgId).toBeNull();

    // Turns were rebuilt (full pipeline, not just a title).
    const turns = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, row!.id));
    expect(turns.length).toBeGreaterThan(0);
  });

  test("skips a canonical that already has a row (no redundant re-ingest)", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const text = claudeCanonical("Already Indexed");
    // Ingest it normally first (authoritative auto write).
    await ingestCommit(db, {
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: text,
      totalBytes: Buffer.byteLength(text),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    expect(before!.attributionSource).toBe("auto");

    const res = await reconcileOrphans(db, store(new Map([[canonicalObject(key), text]])), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.restored).toBe(0); // already present ⇒ not re-ingested

    // The authoritative row is untouched (still 'auto', not demoted to 'recovered').
    const after = await sessionRow(key);
    expect(after!.attributionSource).toBe("auto");
  });

  test("never resurrects a tombstoned session", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    await markSessionDeleted(db, key);

    const res = await reconcileOrphans(db, store(new Map([[canonicalObject(key), claudeCanonical("Nope")]])), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.skippedTombstoned).toBeGreaterThanOrEqual(1);
    expect(res.restored).toBe(0);
    expect(await sessionRow(key)).toBeNull();
  });

  test("restores an agent lane under its parent", async () => {
    const s = suffix();
    const base = `sess-${s}`;
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: base };
    const laneKey: SessionKey = { userId: key.userId, family: key.family, sessionId: `${base}:a:agent-1` };
    const canon = new Map([
      [canonicalObject(key), claudeCanonical("Parent Session")],
      [canonicalObject(laneKey), claudeCanonical("Parent Session")],
    ]);

    const res = await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.restored).toBe(2); // parent + lane

    const parent = await sessionRow(key);
    expect(parent).not.toBeNull();
    const [agent] = await db
      .select({ id: hxSessionAgents.id })
      .from(hxSessionAgents)
      .where(
        and(
          eq(hxSessionAgents.sessionId, parent!.id),
          eq(hxSessionAgents.agentExternalId, "agent-1"),
        ),
      )
      .limit(1);
    expect(agent).toBeTruthy();

    // A second pass is a no-op — both parent and lane are now indexed.
    const res2 = await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res2.restored).toBe(0);
  });

  test("corrective pass flips an existing fallback title to the real ai-title", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    // First ingest with NO real title so the cascade stamps the first-message floor.
    const noTitle = [
      JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "floor me" }] } }),
    ].join("\n");
    await ingestCommit(db, {
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: noTitle,
      totalBytes: Buffer.byteLength(noTitle),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    expect(before!.titleSource).toBe("fallback");

    // Now the canonical the store holds carries a real ai-title. The reconciler's
    // corrective pass (title-only CAS) should upgrade the fallback row.
    const canon = new Map([[canonicalObject(key), claudeCanonical("The Real Title")]]);
    await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: true });

    const after = await sessionRow(key);
    expect(after!.title).toBe("The Real Title");
    expect(after!.titleSource).toBe("ai");
  });

  test("a recovered write no-ops on an already-indexed row (no rebuild, no demote)", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const text = claudeCanonical("Live Owned");
    // An authoritative (auto) write creates the row first.
    await ingestCommit(db, {
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: text,
      totalBytes: Buffer.byteLength(text),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    const turnsBefore = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, before!.id));

    // A recovered (G) write racing the same session must NOT rebuild it — else a
    // concurrent live delta double-counts / gets nuked. It must no-op. Use a
    // LARGER canonical for the recovered write so that a rebuild (the bug) would
    // change the turn count — making the no-op assertion actually discriminating.
    const longerText =
      text +
      "\n" +
      JSON.stringify({
        type: "user",
        timestamp: TS,
        message: { content: [{ type: "text", text: "an extra turn a rebuild would add" }] },
      });
    await ingestCommit(db, {
      attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null },
      key,
      chunkId: "reconcile",
      replace: true,
      chunkText: longerText,
      totalBytes: Buffer.byteLength(longerText),
      componentCount: 1,
      meta: null,
      recovered: true,
    });
    const after = await sessionRow(key);
    const turnsAfter = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, after!.id));
    expect(turnsAfter.length).toBe(turnsBefore.length); // no rebuild / duplication
    expect(after!.attributionSource).toBe("auto"); // not demoted to 'recovered'
  });

  test("defers an agent lane when its parent re-ingest throws; retries next sweep", async () => {
    const s = suffix();
    const base = `sess-${s}`;
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: base };
    const laneKey: SessionKey = { userId: key.userId, family: key.family, sessionId: `${base}:a:agent-1` };
    const text = claudeCanonical("Parent Session");
    const canon = new Map([
      [canonicalObject(key), text],
      [canonicalObject(laneKey), text],
    ]);
    // A store that throws on the PARENT canonical read (transient), lane read OK.
    let failParent = true;
    const flaky: SessionStore = {
      ...memStore(canon),
      readCanonicalText: async (k: SessionKey) => {
        if (failParent && k.sessionId === base) throw new Error("transient store error");
        const t = canon.get(canonicalObject(k));
        if (t === undefined) throw new Error("NoSuchKey");
        return t;
      },
    };

    const r1 = await reconcileOrphans(db, flaky, { batchDelayMs: 0, correctExistingTitles: false });
    expect(r1.errors).toBeGreaterThanOrEqual(1); // parent threw
    expect(r1.deferred).toBeGreaterThanOrEqual(1); // lane deferred, not stubbed
    expect(await sessionRow(key)).toBeNull(); // no title-less parent stub created

    // Store heals → next sweep restores the parent (first) then its lane.
    failParent = false;
    const r2 = await reconcileOrphans(db, flaky, { batchDelayMs: 0, correctExistingTitles: false });
    expect(r2.restored).toBe(2);
    const parent = await sessionRow(key);
    expect(parent).not.toBeNull();
    const [agent] = await db
      .select({ id: hxSessionAgents.id })
      .from(hxSessionAgents)
      .where(
        and(eq(hxSessionAgents.sessionId, parent!.id), eq(hxSessionAgents.agentExternalId, "agent-1")),
      )
      .limit(1);
    expect(agent).toBeTruthy();
  });
});


// A session can be indexed FULLY or NOT AT ALL within one chunk (one
// transaction), but nothing makes chunk N+1 atomic with chunk N — so a commit
// that fails after earlier ones landed leaves an index BEHIND its canonical.
// That row has eventCount > 0, so an existence check calls it indexed and no
// sweep would ever find it. These pin the completeness check that does.
describe.if(!!DSN)("Component G — partially indexed sessions (index behind canonical)", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** memStore, but reporting each canonical's SIZE the way a real listing does
   *  (GCS File.metadata.size / S3 Contents[].Size). */
  function sizedStore(canonicals: Map<string, string>): SessionStore {
    const base = memStore(canonicals);
    return {
      ...base,
      listAllCanonicalKeys: async () => {
        const out: Array<SessionKey & { bytes?: number }> = [];
        for (const [name, text] of canonicals) {
          const k = parseCanonicalKey(name);
          if (k) out.push({ ...k, bytes: Buffer.byteLength(text) });
        }
        return out;
      },
    } as SessionStore;
  }

  /** Index only the HEAD of a transcript, then present the store with the WHOLE
   *  thing — exactly the state a failed tail-chunk commit leaves behind. */
  async function halfIndexed(user: string, canonicals: Map<string, string>) {
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const head = JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "head" }] } });
    const whole = `${head}\n${JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "tail" }] } })}`;
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR,
    });
    canonicals.set(canonicalObject(key), whole);
    return key;
  }

  const events = async (key: SessionKey) => {
    const [row] = await db
      .select({ n: hxSessions.eventCount })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    return Number(row?.n ?? 0);
  };

  test("counted as staleIndexes, and repaired by DEFAULT", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-default-${uniq()}`, canonicals);
    expect(await events(key)).toBe(1);

    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.staleIndexes).toBe(1);
    expect(res.restored).toBe(1);
    // Rebuilt from the WHOLE canonical, through the ordinary restore path.
    expect(await events(key)).toBe(2);
  });

  test("repairStaleIndexes:false still DETECTS — turning repair off never blinds the sweep", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-off-${uniq()}`, canonicals);
    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      repairStaleIndexes: false,
    });
    expect(res.staleIndexes).toBe(1);
    expect(res.restored).toBe(0);
    expect(await events(key)).toBe(1);
  });

  test("a store that reports no size is never judged stale", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-nosize-${uniq()}`, canonicals);
    // memStore's listing carries no bytes — absent means "cannot judge", never
    // "rebuild it".
    const res = await reconcileOrphans(db, memStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.staleIndexes).toBe(0);
    expect(await events(key)).toBe(1);
  });

  test("the ceiling refuses a MASS mismatch — a regressed comparison must not re-ingest the corpus", async () => {
    const canonicals = new Map<string, string>();
    const user = `stale-mass-${uniq()}`;
    const keys: SessionKey[] = [];
    for (let i = 0; i < 60; i += 1) keys.push(await halfIndexed(user, canonicals));

    const refused = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(refused.staleIndexes).toBe(60);
    expect(refused.restored).toBe(0); // 100% stale — the shape of a broken comparison
    expect(await events(keys[0]!)).toBe(1);

    // …and yields when an operator raises the ceiling deliberately.
    const allowed = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      staleRepairCeiling: 1,
    });
    expect(allowed.restored).toBe(60);
    expect(await events(keys[0]!)).toBe(2);
  }, 60_000);

  test("a HANDFUL is always repaired — the ceiling must never strand a small fortress", async () => {
    const canonicals = new Map<string, string>();
    const user = `stale-small-${uniq()}`;
    const key = await halfIndexed(user, canonicals);
    // 1 of 1 is 100%, far above the 0.25 ratio: only the absolute-count floor
    // keeps this repairable, which is the case a ratio-only guard got wrong.
    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      staleRepairCeiling: 0,
    });
    expect(res.restored).toBe(1);
    expect(await events(key)).toBe(2);
  });
});


// The integrity contract: after the guarantor touches a session it is FULLY
// indexed, or the pass says so out loud. A tail that lands with a hole behind it
// is the one outcome that must be impossible.
describe.if(!!DSN)("Component G — integrity of a repaired session", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });

  function sized(canonicals: Map<string, string>): SessionStore {
    return {
      ...memStore(canonicals),
      listAllCanonicalKeys: async () => {
        const out: Array<SessionKey & { bytes?: number }> = [];
        for (const [name, text] of canonicals) {
          const k = parseCanonicalKey(name);
          if (k) out.push({ ...k, bytes: Buffer.byteLength(text) });
        }
        return out;
      },
    } as SessionStore;
  }

  /** Index the first `head` records of an `total`-record transcript, then present
   *  the store with the whole thing. */
  async function halfIndexed(head: number, total: number, canonicals: Map<string, string>) {
    const key: SessionKey = {
      userId: `integrity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const lines = Array.from({ length: total }, (_, i) => rec(`turn ${i}`));
    const prefix = `${lines.slice(0, head).join("\n")}\n`;
    const whole = `${lines.join("\n")}\n`;
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: prefix,
      totalBytes: Buffer.byteLength(prefix), componentCount: 1, meta: null, attribution: ATTR,
    });
    canonicals.set(canonicalObject(key), whole);
    return { key, whole };
  }

  /** Turn count, max seq and whether the lane is dense (no holes). */
  async function lane(key: SessionKey) {
    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const turns = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    const seqs = turns.map((t) => Number(t.seq)).sort((a, b) => a - b);
    return {
      id: row!.id,
      bytes: Number(row!.bytes ?? 0),
      turns: seqs.length,
      dense: seqs.length === (seqs[seqs.length - 1] ?? -1) + 1,
    };
  }

  test("a cleanly-behind index is repaired by APPENDING the tail, and verified dense", async () => {
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });

    expect(res.repairedTail).toBe(1);
    expect(res.integrityFailures).toBe(0);
    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
    expect(l.bytes).toBe(Buffer.byteLength(whole));
  });

  test("an index ending MID-RECORD is never sliced — it falls back to a full rebuild", async () => {
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    // Claim a prefix length that does not land on a newline: slicing there would
    // append half a record, which is the gap this must never create.
    const l0 = await lane(key);
    await db.update(hxSessions).set({ bytesUploaded: l0.bytes - 7 }).where(eq(hxSessions.id, l0.id));

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.repairedTail).toBe(0);
    expect(res.repairedFull).toBe(1);
    expect(res.integrityFailures).toBe(0);
    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
    expect(l.bytes).toBe(Buffer.byteLength(whole));
  });

  test("a stale tail slice is REFUSED when a live commit got there first", async () => {
    // The reconciler cuts a tail at the byte count it saw at scan time, minutes
    // before the repair runs. If a live chunk commits in between, appending that
    // slice re-inserts turns the live write already indexed — and the result is
    // still dense and still covers the canonical, so NOTHING downstream can see
    // it. Without the compare-and-swap this leaves 17 turns where 10 belong.
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    const sliceFrom = (await lane(key)).bytes;

    // The live client catches up first.
    await ingestCommit(db, {
      key, chunkId: "live-2", replace: false,
      chunkText: Buffer.from(whole).subarray(sliceFrom).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const live = await lane(key);
    expect(live.turns).toBe(10);

    // Now the guarantor's stale slice arrives, carrying the offset it was cut at.
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: "reconcile-tail", replace: false,
        chunkText: Buffer.from(whole).subarray(sliceFrom).toString("utf8"),
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
        recovered: true, rebuild: true, expectIndexedBytes: sliceFrom,
      });
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(IndexAdvancedError);
    expect((caught as IndexAdvancedError).expected).toBe(sliceFrom);
    expect((caught as IndexAdvancedError).actual).toBe(live.bytes);

    const after = await lane(key);
    expect(after.turns).toBe(10);   // not 17
    expect(after.dense).toBe(true);
  });

  test("a session that grew UNDER the sweep is complete, not damaged", async () => {
    // Production produced exactly this: a live chunk landed between the repair and
    // the verification, leaving the row AHEAD of the canonical size captured when
    // the pass started. Treating "not equal" as damage reported healthy sessions
    // as integrity failures and re-indexed them every sweep.
    const canonicals = new Map<string, string>();
    const { key } = await halfIndexed(10, 10, canonicals);
    const l0 = await lane(key);
    // The row covers MORE than the canonical the store reports.
    await db.update(hxSessions).set({ bytesUploaded: l0.bytes + 5_000 }).where(eq(hxSessions.id, l0.id));

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.staleIndexes).toBe(0);       // ahead is not behind
    expect(res.repairedTail).toBe(0);
    expect(res.repairedFull).toBe(0);
    expect(res.integrityFailures).toBe(0);  // and it is certainly not a failure
    const l = await lane(key);
    expect(l.turns).toBe(10);               // untouched
    expect(l.dense).toBe(true);
  });

  test("a hole in the MIDDLE is detected by seq density — bytes alone cannot see it", async () => {
    const canonicals = new Map<string, string>();
    const { key } = await halfIndexed(10, 10, canonicals); // fully indexed…
    const l0 = await lane(key);
    expect(l0.dense).toBe(true);
    // …then lose one turn from the middle. bytes_uploaded still matches the
    // canonical exactly, so the byte comparison reports nothing wrong.
    await db.delete(hxTurns).where(and(eq(hxTurns.sessionId, l0.id), isNull(hxTurns.agentId), eq(hxTurns.seq, 4)));
    expect((await lane(key)).dense).toBe(false);

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.gappedLanes).toBe(1);
    expect(res.staleIndexes).toBe(0); // byte counts agree — density is what caught it
    expect(res.repairedFull).toBe(1); // a hole cannot be appended away
    expect(res.integrityFailures).toBe(0);

    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
  });
});


// The guarantor's correctness contract. Each of these encodes a defect that
// reached production or was one deploy away from it.
describe.if(!!DSN)("Component G — repair can always run, and can never destroy", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`turn ${i}`)).join("\n")}\n`;
  const repairKey = () => `reconcile-full:${crypto.randomUUID()}`;

  async function seed(nHead: number) {
    const key: SessionKey = {
      userId: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const head = body(nHead);
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR,
    });
    return { key, headBytes: Buffer.byteLength(head) };
  }
  async function lane(key: SessionKey) {
    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const turns = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    return { bytes: Number(row!.bytes ?? 0), turns: turns.length };
  }

  test("a session can be rebuilt MORE THAN ONCE — the constant repair key froze it forever", async () => {
    const { key } = await seed(5);
    const whole = body(5);
    const opts = {
      replace: true as const, chunkText: whole, totalBytes: Buffer.byteLength(whole),
      componentCount: 1, meta: null, attribution: ATTR, recovered: true as const, rebuild: true as const,
    };
    const first = await ingestCommit(db, { key, chunkId: repairKey(), ...opts });
    const second = await ingestCommit(db, { key, chunkId: repairKey(), ...opts });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect((await lane(key)).turns).toBe(5);
  });

  test("a commit that does NOTHING says so — a dedupe hit is not success", async () => {
    const { key } = await seed(3);
    const whole = body(3);
    const opts = {
      chunkId: "a-fixed-key", replace: true as const, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null,
      attribution: ATTR, recovered: true as const, rebuild: true as const,
    };
    expect((await ingestCommit(db, { key, ...opts })).applied).toBe(true);
    const again = await ingestCommit(db, { key, ...opts });
    expect(again.applied).toBe(false);
    expect(again).toMatchObject({ reason: "deduped" });
  });

  test("bytes_uploaded is MONOTONE on append — a replayed chunk cannot regress it", async () => {
    // The regression is what lets a later tail repair slice from an offset the
    // lane has already passed, duplicating turns invisibly.
    const { key, headBytes } = await seed(3);
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "c2", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const live = await lane(key);
    await ingestCommit(db, {
      key, chunkId: "c1-replay", replace: false, chunkText: "",
      totalBytes: headBytes, componentCount: 1, meta: null, attribution: ATTR,
    });
    expect((await lane(key)).bytes).toBe(live.bytes);
  });

  test("a tail sliced from a stale prefix is REFUSED — the byte CAS alone cannot see it", async () => {
    const { key, headBytes } = await seed(3);
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "c2", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const before = await lane(key);
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: `reconcile-tail:${crypto.randomUUID()}`, replace: false,
        chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
        recovered: true, rebuild: true,
        // Both sides agree — and both are wrong. Only the turn count catches it.
        expectIndexedBytes: before.bytes, expectPriorTurns: 3,
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LanePrefixMismatchError);
    expect((await lane(key)).turns).toBe(before.turns);
  });

  test("a stale full rebuild cannot WIPE turns a live commit just wrote", async () => {
    const { key, headBytes } = await seed(3);
    const scanBytes = headBytes; // what the sweep observed before reading the canonical
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "live-later", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const live = await lane(key);
    const stale = body(3);
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: `reconcile-full:${crypto.randomUUID()}`, replace: true, chunkText: stale,
        totalBytes: Buffer.byteLength(stale), componentCount: 1, meta: null, attribution: ATTR,
        recovered: true, rebuild: true, expectIndexedBytes: scanBytes,
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(IndexAdvancedError);
    // Without the CAS this lane would be back to 3 turns, permanently.
    expect((await lane(key)).turns).toBe(live.turns);
  });
});
