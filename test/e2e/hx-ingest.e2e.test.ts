import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CapabilityClaims } from "../../src/gateway/capability-token";
import { ingestAgentCommit, ingestCommit } from "../../src/gateway/ingest/ingest";
import { createHxDb, type HxDb } from "../../src/host/postgres/db";
import { runMigrations } from "../../src/host/postgres/migrate";
import { migrations } from "../../src/host/postgres/migrations/manifest";
import { makeMigrationExec, startCluster, type Cluster } from "./_cluster";

// Gated like the other embedded-cluster e2e: opt in with FORTRESS_PG_E2E=1
// (first run downloads + extracts the zonky binaries).
const RUN = process.env.FORTRESS_PG_E2E === "1";

const CLAIMS: CapabilityClaims = {
  org: "org-ext-1",
  project: "proj-ext-1",
  repo: "let-ai/let-forge",
  deviceId: "device-ext-1",
  sub: "user-ext-1",
};
const KEY = { userId: "user-ext-1", family: "claude-cli", sessionId: "sess-1" };

function chunk(userText: string, replyText: string, ts: string): string {
  return [
    JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text: userText }] } }),
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: replyText },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: ts,
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] },
    }),
  ].join("\n");
}

describe.if(RUN)("hx metadata ingestion (embedded cluster)", () => {
  let cluster: Cluster;
  let db: HxDb;
  let sql: ReturnType<typeof makeMigrationExec>;

  beforeAll(async () => {
    cluster = await startCluster();
    await runMigrations(makeMigrationExec(cluster.dsn), migrations);
    db = createHxDb(cluster.dsn);
    sql = makeMigrationExec(cluster.dsn);
  }, 180_000);
  afterAll(async () => {
    if (cluster) await cluster.stop();
  });

  async function session() {
    const rows = await sql.query<Record<string, number | string>>(
      "SELECT event_count, user_text_count, assistant_count, tool_call_count, input_tokens, output_tokens, chunk_count, bytes_uploaded, est_cost_usd, title, attribution_source FROM hx.sessions WHERE session_id = 'sess-1'",
    );
    return rows[0];
  }
  async function count(q: string): Promise<number> {
    const rows = await sql.query<{ n: number }>(q);
    return Number(rows[0].n);
  }

  test("first commit writes the session, turns, tool_calls, device, dimensions and ingest event", async () => {
    await ingestCommit(db, {
      claims: CLAIMS,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: chunk("hello", "hi there", "2026-06-29T10:00:00Z"),
      totalBytes: 100,
      componentCount: 1,
      meta: { title: "My session", titleSource: "user", cwd: "/work/let-forge", gitBranch: "main" },
    });

    const s = await session();
    expect(s.event_count).toBe(3);
    expect(s.user_text_count).toBe(1);
    expect(s.assistant_count).toBe(1);
    expect(s.tool_call_count).toBe(1);
    expect(s.input_tokens).toBe(10);
    expect(s.output_tokens).toBe(5);
    expect(s.chunk_count).toBe(1);
    expect(Number(s.bytes_uploaded)).toBe(100);
    expect(Number(s.est_cost_usd)).toBeCloseTo((10 * 5 + 5 * 25) / 1_000_000, 8);
    expect(s.title).toBe("My session");
    expect(s.attribution_source).toBe("auto");

    expect(await count("SELECT count(*)::int n FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id='sess-1')")).toBe(2);
    expect(await count("SELECT count(*)::int n FROM hx.tool_calls")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.users WHERE external_id='user-ext-1'")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.orgs WHERE external_id='org-ext-1'")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.projects WHERE external_id='proj-ext-1'")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.repos WHERE slug='let-ai/let-forge'")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.models WHERE model_id='claude-opus-4-8'")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.ingest_events")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.devices WHERE device_id='device-ext-1' AND last_upload_at IS NOT NULL")).toBe(1);

    // tool_use + tool_result merged into one row keyed by tool_use_id.
    const tc = await sql.query<{ tool_name: string; result: unknown }>(
      "SELECT tool_name, result FROM hx.tool_calls WHERE tool_use_id='tu_1'",
    );
    expect(tc[0].tool_name).toBe("Bash");
    expect(tc[0].result).not.toBeNull();
  });

  test("a second commit accumulates counts and bumps chunk_count", async () => {
    await ingestCommit(db, {
      claims: CLAIMS,
      key: KEY,
      chunkId: "c2",
      replace: false,
      chunkText: chunk("more", "again", "2026-06-29T10:05:00Z"),
      totalBytes: 250,
      componentCount: 2,
      meta: null,
    });
    const s = await session();
    expect(s.event_count).toBe(6);
    expect(s.chunk_count).toBe(2);
    expect(s.input_tokens).toBe(20);
    expect(Number(s.bytes_uploaded)).toBe(250);
    // Title carries forward when a later chunk omits it.
    expect(s.title).toBe("My session");
    expect(await count("SELECT count(*)::int n FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id='sess-1') AND agent_id IS NULL")).toBe(4);
  });

  test("a replace commit resets counts and re-indexes the parent lane", async () => {
    await ingestCommit(db, {
      claims: CLAIMS,
      key: KEY,
      chunkId: "c3",
      replace: true,
      chunkText: chunk("fresh", "reset", "2026-06-29T11:00:00Z"),
      totalBytes: 80,
      componentCount: 1,
      meta: null,
    });
    const s = await session();
    expect(s.event_count).toBe(3);
    expect(s.chunk_count).toBe(1);
    expect(await count("SELECT count(*)::int n FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id='sess-1') AND agent_id IS NULL")).toBe(2);
  });

  test("re-committing the same chunk is a no-op (idempotent)", async () => {
    const before = await session();
    const events = await count("SELECT count(*)::int n FROM hx.ingest_events");
    await ingestCommit(db, {
      claims: CLAIMS,
      key: KEY,
      chunkId: "c3",
      replace: true,
      chunkText: chunk("fresh", "reset", "2026-06-29T11:00:00Z"),
      totalBytes: 80,
      componentCount: 1,
      meta: null,
    });
    const after = await session();
    expect(after.event_count).toBe(before.event_count);
    expect(await count("SELECT count(*)::int n FROM hx.ingest_events")).toBe(events);
  });

  test("agent commit creates a child lane and indexes its turns", async () => {
    await ingestAgentCommit(db, {
      claims: CLAIMS,
      key: KEY,
      agentId: "agent-1",
      chunkId: "ac1",
      replace: false,
      chunkText: chunk("subtask", "working", "2026-06-29T11:10:00Z"),
      totalBytes: 60,
      componentCount: 1,
      meta: { kind: "subagent", label: "explorer", agentType: "Explore" },
    });
    const agent = await sql.query<Record<string, number | string>>(
      "SELECT kind, label, event_count, chunk_count FROM hx.session_agents WHERE agent_external_id='agent-1'",
    );
    expect(agent[0].kind).toBe("subagent");
    expect(agent[0].label).toBe("explorer");
    expect(agent[0].event_count).toBe(3);
    expect(await count("SELECT count(*)::int n FROM hx.turns WHERE agent_id IS NOT NULL")).toBe(2);
  });
});
