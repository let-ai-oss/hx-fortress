import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { hxSessionsAggregate } from "../src/query/aggregate";

// PRODUCTIVITY slice — hx.session_facts derivation + hx_sessions_aggregate
// (§13-A4 / §10). Runs against a real Postgres when FORTRESS_DATABASE_URL is set;
// skipped (no failure) otherwise.
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-productivity.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess-prod-${SUFFIX}`;
const USER_ID = `user-prod-${SUFFIX}`;
const KEY = { userId: USER_ID, family: "claude-cli", sessionId: SESSION_ID };

const inScope = { userExternalId: USER_ID, family: KEY.family, sessionId: SESSION_ID };

// 1 user turn · 2 assistant text turns · an Edit on /src/foo.ts (old 2 lines →
// new 4 lines) · a Write of /src/bar.ts (3 lines), with event_ts a few minutes
// apart — and a 12.5-min idle gap (10:02:30 → 10:15:00) that the 5-min idle cap
// must clamp.
function mockChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:00:00Z",
      message: { content: [{ type: "text", text: "let's refactor the parser" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:02:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "I'll edit the file." },
          {
            type: "tool_use",
            id: "tu_edit",
            name: "Edit",
            input: { file_path: "/src/foo.ts", old_string: "old A\nold B", new_string: "new A\nnew B\nnew C\nnew D" },
          },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:02:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_edit", content: "edited", is_error: false }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:15:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Now writing the module." },
          {
            type: "tool_use",
            id: "tu_write",
            name: "Write",
            input: { file_path: "/src/bar.ts", content: "w1\nw2\nw3" },
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:15:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_write", content: "wrote", is_error: false }] },
    }),
  ].join("\n");
}

// A replace chunk: one Edit on /src/foo.ts (1 line → 1 line). If facts double-
// counted across replace, files/lines/tool_calls would carry the old chunk too.
function replaceChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:00:00Z",
      message: { content: [{ type: "text", text: "redo it" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:01:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Editing once." },
          {
            type: "tool_use",
            id: "tu_redo",
            name: "Edit",
            input: { file_path: "/src/foo.ts", old_string: "x", new_string: "y" },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:01:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_redo", content: "done", is_error: false }] },
    }),
  ].join("\n");
}

interface FactsRow {
  user_msgs: number;
  assistant_msgs: number;
  files_touched: number;
  lines_added: number;
  lines_removed: number;
  active_ms: number | string;
  primary_day: string | null;
  tool_calls_by_type: Record<string, number> | string;
}

describe.if(!!DSN)("hx-fortress productivity slice (facts + aggregate, §13-A4/§10)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    db = createHxDb(dsn);
    await ingestCommit(db, {
      attribution: ATTR,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 512,
      componentCount: 1,
      meta: { title: "Productivity smoke", cwd: "/work/let-forge" },
    });
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${SESSION_ID}'`);
    // hx.session_facts / turns / tool_calls cascade off the session delete.
    await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id = '${SESSION_ID}'`);
  });

  async function facts(): Promise<FactsRow> {
    const rows = await sqlx.query<FactsRow>(
      `SELECT f.user_msgs, f.assistant_msgs, f.files_touched, f.lines_added, f.lines_removed,
              f.active_ms::bigint AS active_ms,
              to_char(f.primary_day, 'YYYY-MM-DD') AS primary_day,
              f.tool_calls_by_type
         FROM hx.session_facts f
         JOIN hx.sessions s ON s.id = f.session_id
        WHERE s.session_id = '${SESSION_ID}'`,
    );
    return rows[0];
  }

  function tct(row: FactsRow): Record<string, number> {
    return typeof row.tool_calls_by_type === "string"
      ? (JSON.parse(row.tool_calls_by_type) as Record<string, number>)
      : row.tool_calls_by_type;
  }

  test("(a) hx.session_facts derives files/lines/active_ms/primary_day at ingest", async () => {
    const f = await facts();
    expect(f).toBeDefined();
    // /src/foo.ts (Edit) + /src/bar.ts (Write).
    expect(Number(f.files_touched)).toBe(2);
    // Edit new (4) + Write content (3).
    expect(Number(f.lines_added)).toBe(7);
    // Edit old (2) + Write (0).
    expect(Number(f.lines_removed)).toBe(2);
    expect(Number(f.user_msgs)).toBe(1);
    expect(Number(f.assistant_msgs)).toBe(2);
    expect(tct(f)).toEqual({ Edit: 1, Write: 1 });
    // 120 000 (10:00→10:02) + 0 + 30 000 (→10:02:30) + min(750 000, 300 000 cap)
    //   (→10:15:00) + 0 + 30 000 (→10:15:30) = 480 000 ms (the 12.5-min idle is capped).
    expect(Number(f.active_ms)).toBe(480_000);
    // date(min(event_ts)) in UTC.
    expect(f.primary_day).toBe("2026-06-30");
  });

  test("(b) hx_sessions_aggregate sums the in-scope facts", async () => {
    const out = await hxSessionsAggregate(db, { scope: { identities: [inScope] } });
    expect(out.totalSessions).toBe(1);
    expect(out.activeMs).toBe(480_000);
    expect(out.userMsgs).toBe(1);
    expect(out.assistantMsgs).toBe(2);
    expect(out.filesTouched).toBe(2);
    expect(out.linesAdded).toBe(7);
    expect(out.linesRemoved).toBe(2);
    expect(out.toolCallsByType).toEqual({ Edit: 1, Write: 1 });
    expect(out.firstDay).toBe("2026-06-30");
    expect(out.lastDay).toBe("2026-06-30");
  });

  test("(c) a different identity is scope-gated to zeros", async () => {
    const out = await hxSessionsAggregate(db, {
      scope: { identities: [{ ...inScope, userExternalId: "someone-else" }] },
    });
    expect(out.totalSessions).toBe(0);
    expect(out.activeMs).toBe(0);
    expect(out.filesTouched).toBe(0);
    expect(out.linesAdded).toBe(0);
    expect(out.toolCallsByType).toEqual({});
    expect(out.firstDay).toBeNull();
  });

  test("(d) an empty scope fails closed to zeros", async () => {
    const out = await hxSessionsAggregate(db, { scope: { identities: [] } });
    expect(out.totalSessions).toBe(0);
    expect(out.activeMs).toBe(0);
    expect(out.toolCallsByType).toEqual({});
  });

  test("(e) the date filter buckets on primary_day", async () => {
    const inDay = await hxSessionsAggregate(db, {
      scope: { identities: [inScope] },
      fromDate: "2026-06-30",
      toDate: "2026-06-30",
    });
    expect(inDay.totalSessions).toBe(1);
    const otherDay = await hxSessionsAggregate(db, {
      scope: { identities: [inScope] },
      fromDate: "2026-07-01",
    });
    expect(otherDay.totalSessions).toBe(0);
  });

  test("(f) a replace recomputes the facts row — no double-count", async () => {
    await ingestCommit(db, {
      attribution: ATTR,
      key: KEY,
      chunkId: "c2",
      replace: true,
      chunkText: replaceChunk(),
      totalBytes: 128,
      componentCount: 1,
      meta: null,
    });

    const f = await facts();
    // Only the replace chunk's single Edit on /src/foo.ts survives.
    expect(Number(f.files_touched)).toBe(1);
    expect(Number(f.lines_added)).toBe(1);
    expect(Number(f.lines_removed)).toBe(1);
    expect(Number(f.user_msgs)).toBe(1);
    expect(Number(f.assistant_msgs)).toBe(1);
    expect(tct(f)).toEqual({ Edit: 1 });
    // 60 000 (10:00→10:01) + 0 + 30 000 (→10:01:30) = 90 000 ms.
    expect(Number(f.active_ms)).toBe(90_000);

    const out = await hxSessionsAggregate(db, { scope: { identities: [inScope] } });
    expect(out.totalSessions).toBe(1);
    expect(out.filesTouched).toBe(1);
    expect(out.linesAdded).toBe(1);
    expect(out.toolCallsByType).toEqual({ Edit: 1 });
    expect(out.activeMs).toBe(90_000);
  });
});
