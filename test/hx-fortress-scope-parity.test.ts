import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { hxOrgs, hxSessions } from "../src/host/postgres/schema";
import { hxSessionSearch } from "../src/query/search";
import { hxSessionsList } from "../src/query/sessions-list";
import type { FortressScope } from "../src/query/scope";

// §13-C PARITY ORACLE (the analogue of the workbench SERVER_PARITY_ORACLE): prove
// the fortress matches the PASSED identities and NEVER its own frozen `org_id`.
//
// The divergence that bites: a session whose fortress `hx.sessions.org_id` is
// frozen at orgA (ingest-stamped, never re-attributed on the fortress) while
// workbench has manually re-attributed it to orgB. The contract (A6) is that the
// fortress evaluates NO org predicate — it admits exactly the enumerated scope
// identities. So:
//   • a scope whose identities INCLUDE the session (as workbench resolves for
//     orgB's board) → returns it, even though its frozen org_id is orgA;
//   • a scope whose identities EXCLUDE it (as orgA's board resolves after the
//     manual re-attribution away) → 0, even though its frozen org_id is STILL
//     orgA (the fortress must not fall back to it).
// A test that only checked the workbench resolver would pass while the fortress
// still leaked via its stale org_id — so this oracle lives in the fortress repo.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-scope-parity.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER_ID = `user-parity-${SUFFIX}`;
const FAMILY = "claude-cli";
const SESSION_X = `sess-parity-x-${SUFFIX}`; // re-attributed orgA → orgB on workbench
const SESSION_Y = `sess-parity-y-${SUFFIX}`; // still on orgA's board
const ORG_A = `org-parity-A-${SUFFIX}`;
const TS = "2026-06-30T10:00:00Z";

const NULL_ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

// One user turn carrying a word BOTH sessions share, so the keyword query matches
// both and the SCOPE — not the query — is what discriminates the results.
function chunk(): string {
  return JSON.stringify({
    type: "user",
    timestamp: TS,
    message: { content: [{ type: "text", text: "please search the directory now" }] },
  });
}

const idX = { userExternalId: USER_ID, family: FAMILY, sessionId: SESSION_X };
const idY = { userExternalId: USER_ID, family: FAMILY, sessionId: SESSION_Y };

function searchIds(out: { hits: { sessionId: string }[] }): string[] {
  return out.hits.map((h) => h.sessionId);
}
function listIds(out: { sessions: { sessionId: string }[] }): string[] {
  return out.sessions.map((s) => s.sessionId);
}

describe.if(!!DSN)("hx-fortress §13-C scope parity (identities, never the frozen org_id)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;
  let orgAUuid: string;

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    db = createHxDb(dsn);

    for (const sessionId of [SESSION_X, SESSION_Y]) {
      await ingestCommit(db, {
        attribution: NULL_ATTR, // ingest stamps org_id = NULL (Uncategorized)…
        key: { userId: USER_ID, family: FAMILY, sessionId },
        chunkId: "c1",
        replace: false,
        chunkText: chunk(),
        totalBytes: 128,
        componentCount: 1,
        meta: { title: `parity ${sessionId}` },
      });
    }

    // …then FREEZE both sessions' fortress org_id at orgA directly (as ingest from
    // an orgA-attributed upload would have). This is the stale value the fortress
    // must IGNORE — workbench has since re-attributed sX to orgB, but no
    // re-attribution RPC reaches the fortress, so its org_id stays orgA.
    const [orgRow] = await db
      .insert(hxOrgs)
      .values({ externalId: ORG_A, name: "Alpha" })
      .returning({ id: hxOrgs.id });
    orgAUuid = orgRow.id;
    await db
      .update(hxSessions)
      .set({ orgId: orgAUuid })
      .where(inArray(hxSessions.sessionId, [SESSION_X, SESSION_Y]));
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    await sqlx.exec(
      `DELETE FROM hx.ingest_events WHERE session_id_ext IN ('${SESSION_X}', '${SESSION_Y}')`,
    );
    await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id IN ('${SESSION_X}', '${SESSION_Y}')`);
    await sqlx.exec(`DELETE FROM hx.orgs WHERE external_id = '${ORG_A}'`);
  });

  test("(a) the divergence is real: both sessions' fortress org_id is frozen at orgA", async () => {
    const rows = await db
      .select({ sessionId: hxSessions.sessionId, orgId: hxSessions.orgId })
      .from(hxSessions)
      .where(inArray(hxSessions.sessionId, [SESSION_X, SESSION_Y]));
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.orgId).toBe(orgAUuid);
  });

  test("(b) INCLUDE sX (orgB's resolved scope) → returns sX, excludes sY — matched by identity, not org_id", async () => {
    const scope: FortressScope = { identities: [idX] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_X);
    expect(search).not.toContain(SESSION_Y);

    const list = listIds(await hxSessionsList(db, { scope }));
    expect(list).toEqual([SESSION_X]);
  });

  test("(c) EXCLUDE sX (orgA's board after re-attribution away) → sX never leaks via its frozen org_id", async () => {
    // orgA's board now resolves only sY; sX must NOT come back even though its
    // frozen org_id is STILL orgA (the fortress evaluates no org predicate).
    const scope: FortressScope = { identities: [idY] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_Y);
    expect(search).not.toContain(SESSION_X);

    const list = listIds(await hxSessionsList(db, { scope }));
    expect(list).toEqual([SESSION_Y]);
  });

  test("(d) me-scope (both identities) → both sessions, regardless of the frozen org_id", async () => {
    const scope: FortressScope = { identities: [idX, idY] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_X);
    expect(search).toContain(SESSION_Y);

    const list = listIds(await hxSessionsList(db, { scope })).sort();
    expect(list).toEqual([SESSION_X, SESSION_Y].sort());
  });

  test("(e) an empty scope → 0 (fail-closed match-nothing), even with sessions frozen at orgA", async () => {
    const none: FortressScope = { identities: [] };
    expect((await hxSessionSearch(db, { scope: none, query: "directory" })).hits.length).toBe(0);
    expect((await hxSessionsList(db, { scope: none })).sessions.length).toBe(0);

    // …and a FOREIGN identity (a different owner of "the same" session) → 0 too.
    const foreign: FortressScope = {
      identities: [{ userExternalId: "someone-else", family: FAMILY, sessionId: SESSION_X }],
    };
    expect((await hxSessionSearch(db, { scope: foreign, query: "directory" })).hits.length).toBe(0);
    expect((await hxSessionsList(db, { scope: foreign })).sessions.length).toBe(0);
  });
});
