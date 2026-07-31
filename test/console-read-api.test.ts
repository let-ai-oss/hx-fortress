// The console read API: what it may read, what it may not, and what it says when
// it cannot.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { fortressPaths } from "../src/host/paths";
import { UI_SESSION_COLUMNS, UI_READ_TABLES } from "../src/host/postgres/console-plane";
import { SESSION_META_SELECT } from "../src/query/sessions-list";
import {
  CONSOLE_DENIED_TABLES,
  CONSOLE_SEARCH_FIELDS,
  CONTENT_COLUMNS,
  classifySessionColumn,
  namesForbiddenColumn,
  SESSION_COLUMN_CLASSES,
} from "../src/query/console/columns";
import {
  auditExportQuery,
  auditPageQuery,
  commandsQuery,
  decodeAuditCursor,
  drainedOutcomesQuery,
  encodeAuditCursor,
} from "../src/query/console/audit";
import {
  consoleDevicesQuery,
  consoleEmbeddingFactsQuery,
  consoleGrowthQuery,
  consolePeopleQuery,
  consolePostgresFactsQuery,
} from "../src/query/console/inventory";
import { consoleSessionTotalsQuery, consoleSessionsQuery } from "../src/query/console/sessions";
import {
  consoleUniversePredicate,
  foreignOrgCountQuery,
  foreignOrgLabel,
  universeConstrains,
} from "../src/query/console/universe";
import { classifyConnectError, consoleDbCopy, externalContainmentBanner, resolveConsoleDb, withStatementTimeout } from "../src/ui/console-db";
import { dataPathRows, EGRESS_TITLE, relayMethodNames } from "../src/ui/egress";
import { filterLogLines } from "../src/ui/console-read-port";
import { EventStreamRegistry, EVENTS_PER_SESSION_CAP } from "../src/ui/events";
import { Glob } from "bun";
import { AUDIT_RETENTION_LINE, logRetentionLine, readIdentityFacts } from "../src/ui/identity";
import { renderPdf } from "../src/ui/pdf";
import { redactCredentials, redactValue, REDACTED } from "../src/ui/redact";
import { reportLines, REPORT_TITLE } from "../src/ui/report";
import {
  handleReadRoute,
  parseExportRange,
  READ_AUDITED_PATHS,
  READ_PATHS,
  READ_ROUTES,
  type ConsoleExportAudit,
  type ConsoleReadPort,
} from "../src/ui/read-routes";
import { gate } from "../src/ui/routes";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import type { EgressInputs } from "../src/ui/egress";

const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;

const UNIVERSE = { orgExternalId: "org_orange" };

/** Every statement the console layer can build, so the boundary is asserted over
 *  the whole surface rather than over the ones somebody remembered. */
function everyConsoleStatement(): Array<{ name: string; sql: string }> {
  return [
    { name: "sessions", sql: render(consoleSessionsQuery({ universe: UNIVERSE, search: "checkout" })) },
    { name: "sessions:cursor", sql: render(consoleSessionsQuery({ universe: UNIVERSE, cursor: "MjAyNi0wNy0wMXwx" })) },
    { name: "totals", sql: render(consoleSessionTotalsQuery(UNIVERSE)) },
    { name: "foreign", sql: render(foreignOrgCountQuery(UNIVERSE)) },
    { name: "people", sql: render(consolePeopleQuery(UNIVERSE)) },
    { name: "devices", sql: render(consoleDevicesQuery()) },
    { name: "growth", sql: render(consoleGrowthQuery(UNIVERSE, 30)) },
    { name: "embeddings", sql: render(consoleEmbeddingFactsQuery()) },
    { name: "postgres", sql: render(consolePostgresFactsQuery(UNIVERSE)) },
    { name: "audit", sql: render(auditPageQuery({ from: "2026-07-01T00:00:00Z" })) },
    { name: "auditExport", sql: render(auditExportQuery({ action: "console.rotate" })) },
    { name: "commands", sql: render(commandsQuery()) },
    { name: "drained", sql: render(drainedOutcomesQuery(["a", "b"])) },
  ];
}

describe("the console boundary", () => {
  test("no console statement names a transcript table or a content column", () => {
    for (const { name, sql } of everyConsoleStatement()) {
      expect([name, namesForbiddenColumn(sql)]).toEqual([name, []]);
    }
  });

  test("the boundary names the two text columns explicitly, not by pattern", () => {
    expect(CONTENT_COLUMNS).toEqual(["last_user_text", "last_assistant_text"]);
    for (const column of CONTENT_COLUMNS) {
      expect(namesForbiddenColumn(`SELECT ${column} FROM hx.sessions`)).toContain(column);
    }
    for (const table of ["turns", "tool_calls", "v_turn_search"]) {
      expect(CONSOLE_DENIED_TABLES).toContain(table);
      expect(namesForbiddenColumn(`SELECT 1 FROM hx.${table}`)).toContain(table);
    }
  });

  test("column classification covers every granted column, in three classes", () => {
    for (const column of UI_SESSION_COLUMNS) {
      expect(SESSION_COLUMN_CLASSES.get(column)).toBeDefined();
    }
    expect(classifySessionColumn("title")).toBe("derived-from-content");
    expect(classifySessionColumn("last_user_text")).toBe("content");
    expect(classifySessionColumn("event_count")).toBe("metadata");
    // The grant itself must not carry the content columns.
    for (const column of CONTENT_COLUMNS) {
      expect(UI_SESSION_COLUMNS as readonly string[]).not.toContain(column);
    }
  });

  test("search touches five metadata fields and no content column", () => {
    const sql = render(consoleSessionsQuery({ universe: UNIVERSE, search: "x" })).toLowerCase();
    for (const field of CONSOLE_SEARCH_FIELDS) {
      const token = field === "repo" ? "r.slug" : `s.${field}`;
      expect(sql).toContain(token.toLowerCase());
    }
    expect(sql).not.toContain("last_user_text");
    expect(sql).not.toContain("last_assistant_text");
  });

  test("the MCP session projection is untouched", () => {
    // The console withholds these; the MCP tools, which answer under a
    // consent-resolved scope, still project them. Narrowing that projection here
    // would be a silent behaviour change on a surface this task does not own.
    expect(Object.keys(SESSION_META_SELECT)).toContain("lastUserText");
    expect(Object.keys(SESSION_META_SELECT)).toContain("lastAssistantText");
  });

  test("the console query layer never imports the MCP scope", async () => {
    const modules = ["columns", "universe", "sessions", "inventory", "audit", "index"];
    for (const name of modules) {
      const source = await Bun.file(`${import.meta.dir}/../src/query/console/${name}.ts`).text();
      const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((m) => m[1]);
      expect([name, imports.filter((m) => m.endsWith("/scope"))]).toEqual([name, []]);
      // The token may appear in prose explaining WHY it is absent; a call may not.
      expect([name, /\bscopePredicate\s*\(/.test(source)]).toEqual([name, false]);
    }
  });
});

describe("the universe predicate", () => {
  test("constrains org and soft-delete, and never matches everything", () => {
    const withOrg = render(consoleUniversePredicate(UNIVERSE));
    expect(universeConstrains(withOrg)).toEqual({ org: true, softDelete: true });
    const unbound = render(consoleUniversePredicate({ orgExternalId: "" }));
    expect(universeConstrains(unbound)).toEqual({ org: true, softDelete: true });
    // An unenrolled fortress narrows to the unattributed rows; it does not widen.
    expect(unbound).toContain("org_id IS NULL");
    expect(unbound).not.toContain("OR");
  });

  test("own-org plus unattributed, and nothing else", () => {
    const sql = render(consoleUniversePredicate(UNIVERSE));
    expect(sql).toContain("org_id IS NULL");
    expect(sql).toContain("external_id");
  });

  test("foreign-org rows are counted and labelled, never listed", () => {
    const counted = render(foreignOrgCountQuery(UNIVERSE));
    expect(counted).toContain("count(*)");
    expect(counted).toContain("org_id IS NOT NULL");
    expect(foreignOrgLabel(0)).toContain("No sessions");
    const label = foreignOrgLabel(3);
    expect(label).toContain("3 session");
    expect(label).toContain("another organization");
  });

  test("every statement that reads sessions carries the universe", () => {
    for (const name of ["sessions", "totals", "growth", "people", "postgres"]) {
      const found = everyConsoleStatement().find((s) => s.name === name);
      expect([name, universeConstrains(found?.sql ?? "").org]).toEqual([name, true]);
    }
  });
});

// -- the port double --------------------------------------------------------

interface Recorded {
  exports: Array<{ what: string; params: Record<string, unknown> }>;
}

function fakePort(overrides: Partial<ConsoleReadPort> = {}): ConsoleReadPort {
  const identity = {
    fortressId: "vault_1",
    boundOrgId: "org_orange",
    credentialWrittenAt: "2026-07-01T00:00:00.000Z",
    root: "/srv/fortress",
    daemonRoot: "/srv/fortress",
    rootMatch: "same" as const,
    paths: { root: "/srv/fortress", log: "/srv/fortress/logs/fortress.jsonl" },
    roles: [],
    postgresMode: "embedded" as const,
    retention: { logs: logRetentionLine({}), auditTrail: AUDIT_RETENTION_LINE },
  };
  const totals = { sessions: 3, people: 2, bytes: 10, tunnel: 1, gateway: 1, unknownProvenance: 1 };
  const foreign = { sessions: 2, label: foreignOrgLabel(2) };
  return {
    status: async () => ({
      daemon: "running",
      copy: "running",
      pid: 42,
      writtenAt: "2026-07-01T00:00:00.000Z",
      rootMatch: "same",
      database: { kind: "ready", mode: "embedded", dsn: "postgresql://hx_ui:secret@127.0.0.1:5432/hx" },
    }),
    sessions: async () => ({ rows: [], totals, foreign }),
    people: async () => [],
    devices: async () => [],
    growth: async () => [],
    facts: async () => ({
      postgres: null,
      embeddings: null,
      storage: {
        provider: "gcs",
        bucket: "b",
        region: null,
        versioning: "unavailable - the fortress key cannot read bucket configuration",
        lifecycle: "unavailable - the fortress key cannot read bucket configuration",
      },
    }),
    identity: async () => identity as never,
    metrics: async () => null,
    dataPaths: async () => ({ title: EGRESS_TITLE, rows: [] }),
    version: async () => ({ kind: "unavailable", reason: "offline", checkedAt: "", cached: false }),
    commands: async () => ({ rows: [], records: [], externalPostgres: false }),
    audit: async () => ({ rows: [] }),
    auditExport: async () => ({ rows: [], truncated: false }),
    spoolTail: async () => [],
    posture: async () => ({
      state: "unavailable",
      asOf: null,
      cloudOnlySessions: null,
      routedHere: null,
      qualification: "unqualified - posture unavailable, cloud-only sessions not checked",
    }),
    logsExport: async () => "{}\n",
    report: async () => ({
      generatedAt: "2026-07-01T00:00:00.000Z",
      version: "0.16.1",
      identity: identity as never,
      totals,
      foreign,
      storage: {
        provider: "gcs",
        bucket: "b",
        region: null,
        versioning: "unavailable - the fortress key cannot read bucket configuration",
        lifecycle: "unavailable - the fortress key cannot read bucket configuration",
      },
      posture: {
        state: "unavailable",
        asOf: null,
        cloudOnlySessions: null,
        routedHere: null,
        qualification: "unqualified",
      },
      dataPaths: [],
    }),
    openEvents: () => ({ ok: false, status: 429, reason: "no streams here", retryAfterMs: 1000 }),
    ...overrides,
  };
}

function ctxFor(port: ConsoleReadPort, recorded: Recorded, audit?: ConsoleExportAudit) {
  return {
    port,
    audit:
      audit ??
      ({
        async recordExport(entry) {
          recorded.exports.push({ what: entry.what, params: entry.params });
        },
      } satisfies ConsoleExportAudit),
    actor: "auditor",
    sessionId: "sess-1",
  };
}

async function get(path: string, port = fakePort(), recorded: Recorded = { exports: [] }) {
  const res = await handleReadRoute(new Request(`http://console.local${path}`), ctxFor(port, recorded));
  return { res, recorded };
}

describe("effect classes", () => {
  test("the read-audited set is exactly five routes", () => {
    const audited = READ_ROUTES.filter((r) => r.cls === "read-audited").map((r) => r.path).sort();
    expect(audited).toEqual(Object.values(READ_AUDITED_PATHS).sort());
    expect(audited).toHaveLength(5);
  });

  test("every other read route is plain read", () => {
    const plain = READ_ROUTES.filter((r) => r.cls === "read").map((r) => r.path);
    expect(plain).toContain(READ_PATHS.audit);
    expect(plain).toContain(READ_PATHS.spool);
    expect(plain).toContain(READ_PATHS.version);
    expect(plain).toContain(READ_PATHS.events);
  });

  test("a plain read never records an export, even when recording would throw", async () => {
    const port = fakePort();
    const exploding: ConsoleExportAudit = {
      async recordExport() {
        throw new Error("a read must not reach the audit spool");
      },
    };
    for (const path of Object.values(READ_PATHS)) {
      const res = await handleReadRoute(
        new Request(`http://console.local${path}`),
        ctxFor(port, { exports: [] }, exploding),
      );
      expect([path, res?.status]).toEqual([path, path === READ_PATHS.events ? 429 : 200]);
    }
  });

  test("every read-audited route records its own export with its parameters", async () => {
    const recorded: Recorded = { exports: [] };
    const port = fakePort();
    await handleReadRoute(new Request(`http://console.local${READ_AUDITED_PATHS.report}`), ctxFor(port, recorded));
    await handleReadRoute(new Request(`http://console.local${READ_AUDITED_PATHS.reportPdf}`), ctxFor(port, recorded));
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.logsExport}?module=host&lines=10`),
      ctxFor(port, recorded),
    );
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.auditExport}?from=2026-07-01&to=2026-07-02`),
      ctxFor(port, recorded),
    );
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.proofCopyAck}`, { method: "POST" }),
      ctxFor(port, recorded),
    );
    expect(recorded.exports.map((e) => e.what).sort()).toEqual([
      "audit export",
      "logs export",
      "proof-copy ack",
      "report PDF",
      "report payload",
    ]);
    // Never collapsed: each export drains with the parameters it ran under.
    const logs = recorded.exports.find((e) => e.what === "logs export");
    expect(logs?.params).toMatchObject({ module: "host", lines: 10 });
    const audit = recorded.exports.find((e) => e.what === "audit export");
    expect(audit?.params).toMatchObject({ from: "2026-07-01", to: "2026-07-02" });
  });

  test("a readonly session may reach every read and read-audited route", () => {
    for (const route of READ_ROUTES) {
      const decision = gate({ method: route.method, path: route.path, route, role: "readonly" });
      expect([route.path, decision.allow]).toEqual([route.path, true]);
    }
  });

  test("no signed-out caller reaches any of them", () => {
    for (const route of READ_ROUTES) {
      const decision = gate({ method: route.method, path: route.path, route, role: null });
      expect([route.path, decision.allow]).toEqual([route.path, false]);
    }
  });
});

describe("range and filter, enforced by the server", () => {
  test("a malformed range is refused rather than trimmed", () => {
    expect(parseExportRange(new URLSearchParams("from=yesterday")).ok).toBe(false);
    expect(parseExportRange(new URLSearchParams("from=2026-07-02&to=2026-07-01")).ok).toBe(false);
    expect(parseExportRange(new URLSearchParams(`action=${"x".repeat(300)}`)).ok).toBe(false);
  });

  test("a good range parses into the statement's own filters", () => {
    const parsed = parseExportRange(new URLSearchParams("from=2026-07-01T00:00:00Z&action=console.rotate"));
    expect(parsed.ok).toBe(true);
    const sql = render(auditExportQuery(parsed.ok ? parsed.range : {}));
    expect(sql).toContain("a.ts >=");
    expect(sql).toContain("a.action =");
    expect(sql).toContain("LIMIT");
  });

  test("the audit export refuses a bad range at the endpoint", async () => {
    const { res, recorded } = await get(`${READ_AUDITED_PATHS.auditExport}?from=nope`);
    expect(res?.status).toBe(400);
    // A refused export is not an export: nothing left, so nothing is recorded.
    expect(recorded.exports).toHaveLength(0);
  });

  test("an over-large export refuses rather than truncating", async () => {
    const port = fakePort({ auditExport: async () => ({ rows: [], truncated: true }) });
    const res = await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.auditExport}`),
      ctxFor(port, { exports: [] }),
    );
    expect(res?.status).toBe(413);
    expect(await res?.text()).toContain("narrow it");
  });

  test("the logs export is reachable and served as a file", async () => {
    const { res } = await get(`${READ_AUDITED_PATHS.logsExport}?lines=5`);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res?.headers.get("content-disposition")).toContain("hx-fortress-logs.jsonl");
  });

  test("audit cursors round-trip and reject a forged id", () => {
    const cursor = encodeAuditCursor({ ts: "2026-07-01T00:00:00Z", id: "11111111-2222-3333-4444-555555555555" });
    expect(decodeAuditCursor(cursor)).toEqual({
      ts: "2026-07-01T00:00:00Z",
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(decodeAuditCursor(Buffer.from("x|DROP TABLE").toString("base64url"))).toBeNull();
  });
});

describe("degraded states", () => {
  test("role-not-provisioned is distinct from a stopped Postgres", () => {
    const auth = classifyConnectError(Object.assign(new Error("password authentication failed for user hx_ui"), { code: "28P01" }));
    expect(auth.kind).toBe("role-not-provisioned");
    expect(consoleDbCopy(auth)).toContain("restart the fortress daemon");

    const down = classifyConnectError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" }));
    expect(down.kind).toBe("postgres-stopped");
    expect(consoleDbCopy(down)).not.toContain("role");

    expect(resolveConsoleDb({ pgJson: null, uiDatabaseUrl: null }).kind).toBe("not-configured");
  });

  test("the console's DSN carries a statement timeout", () => {
    const dsn = withStatementTimeout("postgresql://hx_ui:pw@127.0.0.1:5432/hx", 5000);
    expect(decodeURIComponent(dsn)).toContain("statement_timeout=5000");
  });

  test("the external banner states BOTH containment voids", () => {
    const banner = externalContainmentBanner().join(" ");
    expect(banner).toContain("command fence is void");
    expect(banner).toContain("audit tamper fence is void");
    expect(banner).toContain("does not own the tables");
  });

  test("external mode reports the external database on every surface", async () => {
    const external = resolveConsoleDb({
      pgJson: { mode: "external", databaseUrl: "postgresql://ops:pw@db.example.com:5432/hx" },
      uiDatabaseUrl: null,
    });
    expect(external).toMatchObject({ kind: "ready", mode: "external" });
    const rows = dataPathRows(externalEgress());
    const db = rows.find((r) => r.id === "metadata-database");
    expect(db?.peer).toContain("db.example.com");
    expect(db?.peer).toContain("external");
    expect(db?.notes?.join(" ")).toContain("leave this host");

    const port = fakePort({
      status: async () => ({
        daemon: "running",
        copy: "running",
        pid: 1,
        writtenAt: null,
        rootMatch: "same",
        database: external,
        externalBanner: externalContainmentBanner(),
      }),
    });
    const { res } = await get(READ_PATHS.status, port);
    const body = await res?.json();
    expect(JSON.stringify(body)).toContain("command fence is void");
  });
});

describe("staleness and the pre-heartbeat state", () => {
  test("a snapshot with no writtenAt renders pre-heartbeat, never stale", async () => {
    const port = fakePort({
      status: async () => ({
        daemon: "pre-heartbeat",
        copy: "pre-heartbeat daemon - restart to finish the upgrade",
        pid: 7,
        writtenAt: null,
        rootMatch: "unknown",
        database: { kind: "not-configured" },
      }),
    });
    const { res } = await get(READ_PATHS.status, port);
    const body = (await res?.json()) as { copy: string; writtenAt: string | null };
    expect(body.copy).toContain("restart to finish the upgrade");
    expect(body.copy).not.toContain("not responding");
    // No fabricated freshness: the absent timestamp stays absent.
    expect(body.writtenAt).toBeNull();
  });

  test("a cleanly stopped daemon reads stopped, and a silent one reads not responding", async () => {
    for (const [state, copy] of [
      ["stopped", "stopped"],
      ["stale", "not responding"],
    ] as const) {
      const port = fakePort({
        status: async () => ({
          daemon: state,
          copy,
          pid: null,
          writtenAt: null,
          rootMatch: "unknown",
          database: { kind: "not-configured" },
        }),
      });
      const { res } = await get(READ_PATHS.status, port);
      expect(((await res?.json()) as { copy: string }).copy).toBe(copy);
    }
  });
});

function externalEgress(): EgressInputs {
  return {
    ui: { ...UI_CONFIG_DEFAULTS, bind: "127.0.0.1", trustedProxies: [] },
    boundPort: 8788,
    postgres: { mode: "external", host: "db.example.com", database: "hx", tls: false },
    cloudUrl: "wss://let.ai/_api/hx-gateway/vault-tunnel",
    downloadBase: "https://let.ai/_api/hx-gateway/download",
    postgresBinariesUrl: "https://repo1.maven.org/maven2",
    bucket: { provider: "gcs", name: "orange-hx", region: "eu-north-1" },
    embeddingEndpoint: "https://api.openai.com/v1",
    ssoAdvertised: true,
  };
}

describe("the data-paths inventory", () => {
  test("is titled for what it is, and computed from configuration", () => {
    expect(EGRESS_TITLE).toBe("Data paths in and out of this host");
    const loopback = dataPathRows({
      ...externalEgress(),
      postgres: { mode: "embedded", host: "127.0.0.1", port: 54329, database: "hx" },
    });
    const db = loopback.find((r) => r.id === "metadata-database");
    expect(db?.peer).toContain("embedded, loopback");
    expect(db?.carries).toContain("transcript text and embeddings");
    expect(db?.notes?.join(" ")).toContain("Nothing leaves this host");
  });

  test("the console-listener row reports the effective remote-key source", () => {
    const ignored = dataPathRows(externalEgress()).find((r) => r.id === "console-listener");
    expect(ignored?.notes?.join(" ")).toContain("X-Forwarded-For ignored");
    expect(ignored?.notes?.join(" ")).toContain("trustedProxies");

    const honored = dataPathRows({
      ...externalEgress(),
      ui: { ...UI_CONFIG_DEFAULTS, trustedProxies: ["10.0.0.0/8"] },
    }).find((r) => r.id === "console-listener");
    expect(honored?.notes?.join(" ")).toContain("honored via trustedProxies");
    expect(honored?.notes?.join(" ")).toContain("10.0.0.0/8");
  });

  test("`ui config` prints the same sentence", async () => {
    const { printableUiConfig } = await import("../src/ui/config");
    const printed = printableUiConfig({ ...UI_CONFIG_DEFAULTS });
    const line = printed.find(([key]) => key === "remote-key source");
    expect(line?.[1]).toContain("X-Forwarded-For ignored");
  });

  test("the console-to-bucket row admits the key is write-capable", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "console-bucket");
    expect(row?.notes?.join(" ")).toContain("BUCKET-WRITE-CAPABLE");
  });

  test("the downloads row names the Postgres binaries host too", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "downloads");
    expect(row?.peer).toContain("repo1.maven.org");
    expect(row?.notes?.join(" ")).toContain("pgvector");
  });

  test("the relay row enumerates exactly the methods the dispatcher serves", async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../src/modules/session-vault/store/rpc.ts`,
    ).text();
    // The switch IS the authority. Reading it rather than a parallel constant is
    // the whole point: a method added to the dispatcher and forgotten here is a
    // data path the inventory would not mention.
    const switchBody = source.slice(source.indexOf("switch (req.method)"));
    const served = [...switchBody.matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]).sort();
    expect(served.length).toBeGreaterThan(10);
    expect(relayMethodNames()).toEqual(served);
  });

  test("the relay row does not claim it never carries transcript objects", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "relay-tunnel");
    expect(row?.carries).toContain("session bytes");
    expect(JSON.stringify(row)).not.toContain("never transcript");
  });
});

describe("identity and retention facts", () => {
  test("every path is resolved from a non-default root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-root-"));
    try {
      const paths = fortressPaths(root);
      const facts = await readIdentityFacts({
        paths,
        credentials: { orgId: "org_orange", fortressId: "vault_1", credential: "s3cr3t" },
        daemonRoot: root,
        postgresMode: "embedded",
        env: {},
        mtimeOf: async () => "2026-07-01T00:00:00.000Z",
      });
      for (const value of Object.values(facts.paths)) {
        expect(value.startsWith(root)).toBe(true);
      }
      expect(facts.root).toBe(root);
      expect(facts.rootMatch).toBe("same");
      expect(facts.fortressId).toBe("vault_1");
      // Never the credential itself.
      expect(JSON.stringify(facts)).not.toContain("s3cr3t");
      expect(facts.roles.map((r) => r.name)).toContain("hx_ui");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an external database reports no provisioned roles", async () => {
    const facts = await readIdentityFacts({
      paths: fortressPaths("/srv/fortress"),
      credentials: null,
      postgresMode: "external",
      env: {},
      mtimeOf: async () => null,
    });
    expect(facts.roles).toEqual([]);
    expect(facts.fortressId).toBeNull();
  });

  test("retention lines are derived, not invented", () => {
    expect(logRetentionLine({})).toBe("the last 16 MB across 5 rotated segments (6 files, oldest discarded)");
    expect(
      logRetentionLine({ FORTRESS_LOG_ROTATE_BYTES: String(4 * 1024 * 1024), FORTRESS_LOG_ROTATE_KEEP: "2" }),
    ).toBe("the last 4 MB across 2 rotated segments (3 files, oldest discarded)");
    expect(AUDIT_RETENTION_LINE).toContain("life of the database");
    expect(AUDIT_RETENTION_LINE).toContain("no delete sweep");
    expect(AUDIT_RETENTION_LINE).not.toMatch(/\d+\s*d(ays)?\b/);
  });
});

describe("bucket facts", () => {
  test("unreadable bucket configuration is reported honestly", async () => {
    const { res } = await get(READ_PATHS.facts);
    const body = (await res?.json()) as { storage: { versioning: string; lifecycle: string } };
    expect(body.storage.versioning).toContain("cannot read bucket configuration");
    expect(body.storage.lifecycle).toContain("cannot read bucket configuration");
  });

  test("the report carries the same honest answer", async () => {
    const { res } = await get(READ_AUDITED_PATHS.report);
    const payload = await res?.json();
    const lines = reportLines(payload as never).join("\n");
    expect(lines).toContain("cannot read bucket configuration");
    expect(lines).toContain(EGRESS_TITLE);
  });
});

describe("credentials never leave", () => {
  test("a DSN in a response body is redacted", () => {
    expect(redactCredentials("postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx")).toBe(
      `postgresql://hx_ui:${REDACTED}@127.0.0.1:5432/hx`,
    );
    expect(redactCredentials("Authorization: Bearer abcdef0123456789")).toContain(REDACTED);
    expect(redactCredentials("https://x/y?token=abcdef0123")).toContain(REDACTED);
    expect(redactCredentials("password = 'hunter22'")).toContain(REDACTED);
  });

  test("redaction reaches nested response values", () => {
    const out = redactValue({ a: [{ dsn: "postgres://u:pw@h/db" }] });
    expect(JSON.stringify(out)).not.toContain("pw@h");
  });

  test("no endpoint echoes the console's own password", async () => {
    for (const path of Object.values(READ_PATHS)) {
      if (path === READ_PATHS.events) continue;
      const { res } = await get(path);
      const text = await res?.text();
      expect([path, text?.includes("secret")]).toEqual([path, false]);
    }
  });

  test("an error body carries no credential either", async () => {
    const port = fakePort({
      status: async () => {
        throw new Error("connect failed: postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx");
      },
    });
    // The handler does not swallow it; the port's own classifier is what renders
    // it, and that path is redacted at the source.
    const state = classifyConnectError(
      new Error("connect failed: postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx"),
    );
    expect(JSON.stringify(state)).not.toContain("sup3rsecret");
    await expect(get(READ_PATHS.status, port)).rejects.toThrow();
  });
});

describe("the report PDF", () => {
  test("is rendered on the server and survives a hostile title", () => {
    const bytes = renderPdf(REPORT_TITLE, [
      "Session title: ) evil \\ (unbalanced",
      "a".repeat(400),
    ]);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("\\) evil \\\\ \\(unbalanced");
    expect(text).toContain("/Type /Catalog");
  });

  test("the endpoint serves it as a download", async () => {
    const { res } = await get(READ_AUDITED_PATHS.reportPdf);
    expect(res?.headers.get("content-type")).toBe("application/pdf");
    expect(res?.headers.get("content-disposition")).toContain("hx-fortress-report.pdf");
  });
});

describe("the hx_ui grant covers what the console reads", () => {
  test("every console read table is granted", () => {
    for (const table of ["users", "orgs", "repos", "devices", "session_facts"]) {
      expect(UI_READ_TABLES as readonly string[]).toContain(table);
    }
  });
});


describe("the logs export is filtered by the server", () => {
  const lines = [
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", module: "host", level: "info", msg: "a" }),
    JSON.stringify({ ts: "2026-07-01T06:00:00.000Z", module: "session_vault", level: "warn", msg: "b" }),
    JSON.stringify({ ts: "2026-07-02T00:00:00.000Z", module: "host", level: "error", msg: "c" }),
    "not json at all",
  ];

  test("no filter keeps everything, including a torn line", () => {
    expect(filterLogLines(lines, {})).toHaveLength(4);
  });

  test("a module filter narrows, and drops what it cannot classify", () => {
    const kept = filterLogLines(lines, { module: "host" });
    expect(kept).toHaveLength(2);
    expect(kept.join("")).not.toContain("not json at all");
  });

  test("a range is applied on the record's own timestamp", () => {
    expect(filterLogLines(lines, { from: "2026-07-01T05:00:00.000Z" })).toHaveLength(2);
    expect(filterLogLines(lines, { to: "2026-07-01T05:00:00.000Z" })).toHaveLength(1);
    expect(
      filterLogLines(lines, { from: "2026-07-01T05:00:00.000Z", to: "2026-07-01T07:00:00.000Z" }),
    ).toHaveLength(1);
  });

  test("level and module compose", () => {
    expect(filterLogLines(lines, { module: "host", level: "error" })).toHaveLength(1);
  });
});

describe("outbound call sites", () => {
  /** Every module that can open a connection to something outside this host,
   *  mapped to the inventory row that discloses it. A file that starts making
   *  outbound calls and is not mapped fails here rather than becoming a data
   *  path nobody wrote down. */
  const OUTBOUND: Record<string, string> = {
    "src/cloud/connection.ts": "relay-tunnel",
    "src/modules/session-vault/store/rpc.ts": "relay-tunnel",
    "src/modules/session-vault/store/gcs-store.ts": "console-bucket",
    "src/modules/session-vault/store/s3-store.ts": "console-bucket",
    "src/update.ts": "downloads",
    "src/ui/version-check.ts": "downloads",
    "src/host/postgres/acquire.ts": "downloads",
    "src/host/postgres/pgvector-artifact.ts": "downloads",
    "src/host/postgres/pgvector-install.ts": "downloads",
    "src/modules/embed-worker/openai.ts": "embeddings",
    // The signature sidecar rides the same origin as the artifact it verifies.
    "src/host/trust/verify.ts": "downloads",
    // Wires the fetch into the Postgres binary acquisition above.
    "src/host/postgres/index.ts": "downloads",
    "src/modules/session-vault/browser-enroll.ts": "enrollment",
    // Loopback only, and to this console's own port: the instance handshake that
    // decides whether a busy port is another console or a stranger.
    "src/ui/instance.ts": "console-listener",
  };

  test("every outbound module is disclosed by a row", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const found: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan({ cwd: root })) {
      if (file.endsWith(".test.ts")) continue;
      const source = await Bun.file(path.join(root, file)).text();
      const opensASocket =
        /\bfetch\(/.test(source) ||
        /fetchImpl/.test(source) ||
        /new WebSocket\(/.test(source) ||
        /new Storage\(/.test(source) ||
        /new S3Client\(/.test(source);
      if (opensASocket) found.push(file);
    }
    expect(found.length).toBeGreaterThan(5);
    const unmapped = found.filter((f) => !(f in OUTBOUND));
    expect(unmapped).toEqual([]);

    const rowIds = new Set(dataPathRows(externalEgress()).map((r) => r.id));
    for (const id of new Set(Object.values(OUTBOUND))) {
      expect([id, rowIds.has(id)]).toEqual([id, true]);
    }
  });
});

describe("the app keeps working while streams are open", () => {
  test("N tabs hold streams and every other read route still answers", async () => {
    const registry = new EventStreamRegistry();
    const port = fakePort({
      openEvents: ({ sessionId, userLogin }) =>
        registry.open({
          sessionId,
          userLogin,
          producer: {
            start(_sink, signal) {
              return new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          },
        }),
    });
    try {
      for (let tab = 0; tab < 3; tab += 1) {
        for (let i = 0; i < EVENTS_PER_SESSION_CAP; i += 1) {
          const res = await handleReadRoute(new Request(`http://console.local${READ_PATHS.events}`), {
            port,
            audit: { async recordExport() {} },
            actor: "marta",
            sessionId: `tab-${tab}`,
          });
          // Beyond the per-USER cap the extra tabs are refused, which is the
          // designed behaviour - what must NOT happen is the rest of the app
          // failing with them.
          expect([res?.status === 200 || res?.status === 429, true]).toEqual([true, true]);
        }
      }
      for (const p of [READ_PATHS.status, READ_PATHS.sessions, READ_PATHS.identity, READ_PATHS.facts]) {
        const res = await handleReadRoute(new Request(`http://console.local${p}`), {
          port,
          audit: { async recordExport() {} },
          actor: "marta",
          sessionId: "tab-0",
        });
        expect([p, res?.status]).toEqual([p, 200]);
      }
    } finally {
      registry.closeAll();
    }
  });
});
