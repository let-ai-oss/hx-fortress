import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
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
      ingestChannel: "tunnel",
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
      ingestChannel: "tunnel",
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
      ingestChannel: "tunnel",
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
      ingestChannel: "tunnel",
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
