import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startGatewayServer, type GatewayHandle } from "../src/gateway/server";
import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";

// QUERY + MCP slice smoke test (§13-A4/A5/A6). Runs against a real pgvector
// Postgres when FORTRESS_DATABASE_URL is set; skipped (no failure) otherwise.
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-query-mcp.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess-querymcp-${SUFFIX}`;
const USER_ID = `user-querymcp-${SUFFIX}`;
const KEY = { userId: USER_ID, family: "claude-cli", sessionId: SESSION_ID };
const TS = "2026-06-30T10:00:00Z";

// 1 user turn · 1 assistant turn (text + tool_use) · 1 tool_result carrying the
// distinctive ZZQX_MARKER literal in its OUTPUT (proves keyword reaches tool text).
function mockChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { content: [{ type: "text", text: "please list the directory" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Sure, running it now." },
          { type: "tool_use", id: "tu_zz", name: "Bash", input: { command: "ls -la" } },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_zz",
            content: "total 4\nZZQX_MARKER drwxr-xr-x 2 user user 4096 .",
            is_error: false,
          },
        ],
      },
    }),
  ].join("\n");
}

const inScopeIdentity = {
  userExternalId: USER_ID,
  family: KEY.family,
  sessionId: SESSION_ID,
};

interface ToolText {
  content: Array<{ type: string; text?: string }>;
}
interface SearchOut {
  hits: Array<{ sessionId: string; seq: number; kind: string; snippet: string; rank: number }>;
}

function searchResult(res: ToolText): SearchOut {
  const text = res.content.find((c) => c.type === "text")?.text ?? "null";
  return JSON.parse(text) as SearchOut;
}

describe.if(!!DSN)("hx-fortress query + MCP slice (A4/A5/A6)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;
  let handle: GatewayHandle;
  let url: string;
  let token: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    db = createHxDb(dsn);
    await ingestCommit(db, {
      attribution: ATTR,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 256,
      componentCount: 1,
      meta: { title: "Query+MCP smoke" },
    });

    // Mint the capability token with the fortress's Ed25519 key (the org public
    // key the gateway verifies against; repo:"*" sentinel — the /mcp route is
    // org-scoped and the fortress evaluates no repo predicate).
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const rawB64url = (await exportJWK(publicKey)).x as string;
    token = await new SignJWT({ org: "org-smoke", repo: "*", sub: USER_ID })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    handle = startGatewayServer({
      port: 0,
      logger: { info() {}, error() {} },
      signingKey: async () => rawB64url,
      // Search/list/get need only the DB; the vault store is intentionally null
      // (read_events is not exercised here and degrades when the store is off).
      store: () => null,
      postgresReady: () => true,
      db: () => db,
      // The /mcp read tools resolve through dbRead (the RO role in production);
      // this suite runs a single connection so both point at the same handle.
      dbRead: () => db,
    });
    url = `http://localhost:${handle.port}/mcp`;

    transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: "hx-fortress-smoke", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    handle?.stop();
    if (!DSN) return;
    await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${SESSION_ID}'`);
    await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id = '${SESSION_ID}'`);
  });

  test("(a) tools/list returns the hx_* tools over MCP", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("hx_session_search");
    expect(names).toContain("hx_sessions_list");
    expect(names).toContain("hx_session_get");
    expect(names).toContain("hx_session_read_events");
    // Contract-complete: the later-slice tools are registered too.
    expect(names).toContain("hx_semantic_search");
    expect(names).toContain("hx_sessions_aggregate");
  });

  test("(b) hx_session_search finds the session by tool-text keyword, scope-gated", async () => {
    const res = await client.callTool({
      name: "hx_session_search",
      arguments: { query: "ZZQX_MARKER", scope: { identities: [inScopeIdentity] } },
    });
    const out = searchResult(res as ToolText);
    expect(out.hits.length).toBeGreaterThanOrEqual(1);
    expect(out.hits[0].sessionId).toBe(SESSION_ID);
    // ZZQX_MARKER lives in a tool_result — proves the broad keyword index over tool text.
    expect(out.hits.some((h) => h.kind === "tool_result")).toBe(true);
  });

  test("(c) a DIFFERENT identity in scope returns 0 results (scope isolation)", async () => {
    const res = await client.callTool({
      name: "hx_session_search",
      arguments: {
        query: "ZZQX_MARKER",
        scope: { identities: [{ ...inScopeIdentity, userExternalId: "someone-else" }] },
      },
    });
    expect(searchResult(res as ToolText).hits.length).toBe(0);
  });

  test("(d) empty scope.identities returns 0 results (fail-closed)", async () => {
    const res = await client.callTool({
      name: "hx_session_search",
      arguments: { query: "ZZQX_MARKER", scope: { identities: [] } },
    });
    expect(searchResult(res as ToolText).hits.length).toBe(0);
  });

  test("(e) a missing or invalid capability token is rejected with 401", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } },
    });
    const noToken = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    expect(noToken.status).toBe(401);

    const badToken = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-a-real-jwt",
      },
      body,
    });
    expect(badToken.status).toBe(401);
  });
});
