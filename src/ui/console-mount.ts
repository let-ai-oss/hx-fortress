// Assembling the read surface the console serves from.
//
// The handlers and the port were built to be testable without any of this: the
// port is an interface, and every dependency below is a function the port calls
// when it needs an answer. This module is the one place where those functions
// are the REAL ones — a live Postgres handle, the daemon's runtime files, the
// resolved configuration and the vault's own credential file.
//
// Two properties are deliberate and worth stating.
//
// NOTHING HERE THROWS ON A BROKEN FORTRESS. Every resolver answers with null,
// with an empty value or with a named degraded state, because the console's
// whole job on a broken fortress is to say what is broken. A mount that refused
// to build without Postgres would give an operator a blank page at exactly the
// moment they needed a diagnosis.
//
// THE DATABASE HANDLE IS LAZY AND RE-RESOLVED. The daemon writes pg.json on its
// first console-capable boot and provisions the console's role on every boot,
// so a console started first must pick both up without a restart — and a
// connection that fails is classified into the three distinct facts an operator
// can act on rather than one "database unavailable".

import { readFile } from "node:fs/promises";

import { FileCredentialStore, type CloudCredential } from "../cloud/credentials";
import { readVaultCredentials } from "../modules/session-vault/credentials";
import { AuditSpool } from "../console/audit-spool";
import { parseFortressConfig } from "../host/config";
import type { fortressPaths } from "../host/paths";
import { createHxDb, type HxDb } from "../host/postgres/db";
import { readPgJson } from "../host/postgres/pg-json";
import { DEFAULT_PG_BINARIES_URL } from "../host/postgres/resolve";
import { getServiceManager } from "../service";
import { FileStatusReader } from "../status-reader";
import { downloadBaseFromCloudUrl } from "../update";
import { classifyConnectError, resolveConsoleDb, type ConsoleDbState } from "./console-db";
import { createConsoleReadPort } from "./console-read-port";
import type { UiConfig } from "./config";
import type { EgressInputs } from "./egress";
import { createLogEventProducer } from "./log-events";
import type { ConsoleExportAudit, ConsoleReadPort } from "./read-routes";
import type { UiRuntime } from "./runtime";

export interface ConsoleMountOptions {
  paths: ReturnType<typeof fortressPaths>;
  runtime: UiRuntime;
  /** The port actually bound, which may differ from the configured one. */
  boundPort: number;
  /** The lifecycle owner, resolved once by the caller: a host service manager,
   *  or the orchestrator that supervises this container. */
  serviceManager: string;
  env?: Record<string, string | undefined>;
}

export interface ConsoleMount {
  port: ConsoleReadPort;
  audit: ConsoleExportAudit;
  /** Resolves once the facts that are read from disk are in hand. Awaited before
   *  the console binds, so the FIRST page a browser gets is answered with the
   *  same truth as the tenth — an enrolled fortress must never render "not
   *  enrolled" for one poll because a file read had not finished. */
  ready: Promise<void>;
}

/**
 * The export record.
 *
 * It is a PAIR, and the intent half is fsynced before the read runs. A record
 * written only on success would be missing for exactly the copies that matter —
 * the ones that failed halfway, after bytes had already been read.
 */
function exportAudit(spoolDir: string): ConsoleExportAudit {
  const spool = new AuditSpool({ dir: spoolDir });
  return {
    async recordExport(entry) {
      await spool.append({
        actor: entry.actor,
        sessionRef: entry.sessionRef,
        tier: null,
        action: `console.export.${entry.what.replaceAll(" ", "_")}`,
        params: entry.params,
        kind: "intent",
        refSeq: null,
        outcome: null,
        error: null,
        origin: "console",
      });
    },
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function createConsoleMount(options: ConsoleMountOptions): ConsoleMount {
  const { paths, runtime } = options;
  const env = options.env ?? process.env;
  const status = new FileStatusReader(paths.status);
  const service = getServiceManager();
  const credentialStore = new FileCredentialStore(paths.credentials);

  let handle: { db: HxDb; dsn: string } | null = null;
  let databaseState: ConsoleDbState = { kind: "not-configured" };
  let resolving: Promise<void> | null = null;

  /** Resolve coordinates and open a handle, at most once at a time. A failure
   *  leaves the classified state behind and lets the next call try again. */
  const ensureDb = async (): Promise<void> => {
    const pgJson = await readPgJson(paths.pgJson).catch(() => null);
    const config = await runtime.readConfig().catch(() => null);
    const state = resolveConsoleDb({
      pgJson,
      uiDatabaseUrl: config?.databaseUrl ?? null,
    });
    if (state.kind !== "ready") {
      handle = null;
      databaseState = state;
      return;
    }
    if (handle?.dsn === state.dsn) {
      databaseState = state;
      return;
    }
    try {
      const db = createHxDb(state.dsn);
      // A handle is not a connection: prove it before a page renders as though
      // the database answered.
      await db.execute("SELECT 1" as never);
      handle = { db, dsn: state.dsn };
      databaseState = state;
    } catch (err) {
      handle = null;
      databaseState = classifyConnectError(err);
    }
  };

  const refresh = (): Promise<void> => {
    resolving ??= ensureDb().finally(() => {
      resolving = null;
    });
    return resolving;
  };

  /** Widened once the credential resolves: until then the console's universe is
   *  the unattributed sessions alone, which is exactly what an unenrolled host
   *  holds. Mutated in place so the predicate follows an enrollment that
   *  completes while the console is already serving. */
  const universe = { orgExternalId: "" };
  let vaultBucket: { provider: string; name: string; region: string | null } | null = null;
  let downloadBase: string | null = null;

  const bucket = (): { provider: string; name: string; region: string | null } | null => vaultBucket;

  const cloudUrl = async (): Promise<string | null> => {
    const raw = await readJson<unknown>(paths.config);
    if (!raw) return null;
    try {
      return parseFortressConfig(raw).cloud.url;
    } catch {
      return null;
    }
  };

  const egress = async (): Promise<EgressInputs> => {
    const config: UiConfig = await runtime.readConfig();
    const pgJson = await readPgJson(paths.pgJson).catch(() => null);
    const cloud = await cloudUrl();
    const postgres: EgressInputs["postgres"] =
      pgJson === null
        ? { mode: "unknown" }
        : pgJson.mode === "embedded"
          ? { mode: "embedded", host: pgJson.host, port: pgJson.port, database: pgJson.database }
          : {
              mode: "external",
              host: hostOf(pgJson.databaseUrl),
              database: databaseOf(pgJson.databaseUrl),
              tls: /sslmode=(require|verify)/.test(pgJson.databaseUrl),
            };
    return {
      ui: config,
      boundPort: options.boundPort,
      postgres,
      cloudUrl: cloud,
      downloadBase: cloud ? downloadBaseFromCloudUrl(cloud) : null,
      postgresBinariesUrl: env.FORTRESS_PG_BINARIES_URL ?? DEFAULT_PG_BINARIES_URL,
      bucket: bucket(),
      // The console never holds the embedding key, so the row is present only
      // when the daemon's own configuration names an endpoint.
      embeddingEndpoint: env.FORTRESS_OPENAI_BASE_URL ?? null,
      ssoAdvertised: config.sso,
    };
  };

  const port = createConsoleReadPort({
    paths,
    universe,
    db: () => {
      void refresh();
      return handle?.db ?? null;
    },
    database: () => databaseState,
    status: () => status.read().catch(() => null),
    service: () => service.state().catch(() => ({ loaded: false, pid: null })),
    credentials: () => credentialStore.load().catch(() => null),
    egress,
    // The console process does not build a store: it would need the same
    // bucket-write-capable credential the daemon holds, for facts it can report
    // honestly as unreadable instead.
    store: () => null,
    bucket,
    streams: runtime.streams,
    producer: createLogEventProducer({ logPath: paths.log, env }),
    downloadBase: () => downloadBase,
    serviceManager: () => options.serviceManager,
    env,
  });

  const ready = Promise.all([
    refresh(),
    credentialStore
      .load()
      .then((credential: CloudCredential | null) => {
        if (credential?.orgId) universe.orgExternalId = credential.orgId;
      })
      .catch(() => {}),
    readVaultCredentials()
      .then((creds) => {
        if (creds) {
          vaultBucket = { provider: creds.store, name: creds.bucket, region: creds.region ?? null };
        }
      })
      .catch(() => {
        // No vault credentials is a state the storage panel already renders.
      }),
    cloudUrl().then((url) => {
      downloadBase = url ? downloadBaseFromCloudUrl(url) : null;
    }),
  ]).then(() => undefined);

  return { port, audit: exportAudit(paths.auditSpool), ready };
}

function hostOf(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return "unparseable";
  }
}

function databaseOf(dsn: string): string {
  try {
    return new URL(dsn).pathname.replace(/^\//, "") || "unnamed";
  } catch {
    return "unparseable";
  }
}
