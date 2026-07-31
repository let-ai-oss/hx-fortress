import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  FileCredentialStore,
  FilePendingEnrollmentStore,
  SUPPORTED_PROTOCOL_VERSION,
  WsCloudConnection,
} from "../cloud";
import type { PendingEnrollment, WsCloudConnectionDeps } from "../cloud";
import { computeCollectionStats } from "../query/collection-stats";
import packageJson from "../../package.json";
import createSessionVaultModule from "../modules/session-vault/module";
import {
  readVaultCredentials,
  redactCredentials,
  writeVaultCredentials,
  type VaultCredentials,
} from "../modules/session-vault/credentials.js";
import { applyHeadlessBootstrap } from "./headless-bootstrap";
import { adoptDaemonHome } from "./daemon-home";
import {
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
  resolveEmbedConfig,
  resolveGatewayConfig,
  rosterInactivePurgeDays,
} from "./config";
import {
  createEmbedWorker,
  createOpenAIEmbedder,
  setEmbedSignalHandler,
  type Embedder,
  type EmbedWorker,
} from "../modules/embed-worker";
import { FileLogSink } from "./file-log-sink";
import { MultiLogSink, StdoutLogSink } from "./stdout-log-sink";
import { BusHostLogger, LogBus } from "./logging";
import { ModuleRegistry } from "./module-registry";
import { fortressPaths } from "./paths";
import { buildPostgresProvider } from "./postgres";
import { createHxDb, type HxDb } from "./postgres/db";
import { runHost, type HostLifecycle } from "./run-host";
import { HostRuntime } from "./runtime";
import { FileStatusStore } from "./status";
import { FileStatusReader } from "../status-reader";
import type { CloudConnection, HxIngestNotification } from "./types";
import { FileSigningKeyStore } from "../gateway/signing-key-store";
import { startGatewayServer, type GatewayHandle } from "../gateway/server";
import { verifyGrant, type GrantClaims } from "../gateway/capability-token";
import { createMcpTunnelHandler } from "../mcp/tunnel-handler";
import type { McpTunnelRequest, McpTunnelResult } from "../protocol";
import { parseBooleanEnv } from "../env";
import { createGuarantor, guarantorEnabled, type Guarantor } from "../ingest/guarantor";
import { setReconcileSignalHandler } from "../ingest/reconcile-signal";
import { drainParkedArtifacts, parkArtifact } from "../console/artifact-replay";
import { createCommandGateway } from "../console/command-gateway";
import { pollCommands, runBootFence } from "../console/commands";
import { createCommandExecutors } from "../console/executors";
import { getServiceManager } from "../service";
import { getUiServiceControl, restartUiUnitDetached } from "../ui/service-control";
import { downloadBaseFromCloudUrl } from "../update";
import { readConsoleAdvertisement } from "../ui/advertise";
import { runAuditForFortress } from "../console/audit-runner";
import { runMigrationCommand } from "../console/migration-runner";
import { buildDirectStore } from "../modules/session-vault/store";
import { purgeInactiveRoster, replaceRoster } from "../console/roster";
import {
  clearRosterPurgeIntent,
  publishRosterPurge,
  readRosterPurgeIntent,
} from "../console/roster-signal";
import { createWitnessClient } from "../console/audit-witness";
import {
  postureFreshness,
  POSTURE_REFRESH_MS,
  RoutingPostureCache,
  routingPosturePath,
} from "../cloud/fortress-query";
import { readAcknowledgements } from "../console/audit-store";
import {
  clearWitnessIntent,
  publishAcks,
  publishAuditSettings,
  readWitnessIntent,
} from "../console/witness-signal";
import { sql as sqlTag } from "drizzle-orm";
import { DaemonAudit } from "../console/daemon-audit";
import { LiveUiConfig, effectiveUiEnabled } from "../ui/config";
import { consumeCredentialRef, sweepCmdCreds } from "../console/cmd-creds";
import { effectivePause, PauseState } from "../console/ingest-control";
import { readCurrentEpisode } from "../console/ingest-control-db";
import { IngestQuiesce } from "../console/pause-gate";
import { MetricsRegistry, startMetricsPublisher } from "../console/metrics";
import { clearPauseAnchor, stampPauseAnchor } from "../console/runtime-files";

export interface HostMainDependencies {
  root?: string;
  version?: string;
  createConnection?: (dependencies: WsCloudConnectionDeps) => CloudConnection;
  run?: (runtime: HostLifecycle) => Promise<void>;
}

export async function resolvePendingEnrollmentForStartup(
  pendingEnrollmentStore: FilePendingEnrollmentStore,
): Promise<PendingEnrollment | null> {
  return pendingEnrollmentStore.load().catch(() => null);
}

/** ws(s) origin (protocol + host + port) of a URL, or null when unparseable. */
export function wsOrigin(u: string): string | null {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** M-8 · decide whether a pending-enrollment.json should be honored at startup.
 *  A pending enrollment is the operator's fresh (re-)bootstrap intent, but a file
 *  an attacker drops next to an ALREADY-ENROLLED fortress would otherwise re-home
 *  it (its own token + its own cloud origin) to the attacker's org — handing over
 *  the fortress's bucket + data. So once a credential is saved, honor a pending
 *  enrollment only when its cloudUrl shares the enrolled cloud origin, unless
 *  FORTRESS_ALLOW_REENROLL is explicitly set. */
export function isPendingEnrollmentTrusted(args: {
  savedCredentialExists: boolean;
  pendingCloudUrl: string;
  enrolledCloudUrl: string | null;
  allowReenroll: boolean;
}): boolean {
  if (!args.savedCredentialExists) return true; // fresh install — nothing to hijack
  if (args.allowReenroll) return true; // explicit operator opt-in
  const enrolled = args.enrolledCloudUrl ? wsOrigin(args.enrolledCloudUrl) : null;
  const pending = wsOrigin(args.pendingCloudUrl);
  return enrolled !== null && pending !== null && enrolled === pending;
}

export async function runFortressHost(
  dependencies: HostMainDependencies = {},
): Promise<void> {
  const root = dependencies.root;
  const version = dependencies.version ?? packageJson.version;
  const paths = fortressPaths(root);
  // ONCE, and before anything reads or writes a credential — the bootstrap
  // below rebuilds credentials.json, and a home adopted after that write would
  // leave the file the fortress is serving from and the one it just wrote in two
  // different places. Never inside readVaultCredentials: that is a pure read the
  // console's read class reaches, and re-homing a process is an effect.
  const homeResolution = adoptDaemonHome({});
  // On a non-interactive host (the Railway cloud service — no TTY) tee every
  // record to stdout as well, so the platform's log capture actually shows
  // fortress activity + connection errors. File-only leaves logs in
  // logs/service.log inside the container, invisible to Railway (which then
  // shows just "Starting Container"). A local operator install runs in a TTY
  // and keeps file-only so its terminal / TUI stays clean.
  const fileSink = new FileLogSink(paths.log);
  const sink = process.stdout.isTTY
    ? fileSink
    : new MultiLogSink([fileSink, new StdoutLogSink()]);
  const bus = new LogBus(sink);
  const logger = new BusHostLogger(bus);
  const registry = new ModuleRegistry(bus);
  // Lazily built once Postgres is ready (the cluster boots after modules are
  // wired). Two role-scoped handles (de-superuser least-privilege): the RW
  // handle (hx_app_rw) is the ingest write path shared by the tunnel module +
  // the direct gateway; the RO handle (hx_app_ro) is the SELECT-only read path
  // for the MCP tools (HTTP /mcp + the reverse tunnel). Embedded mode splits the
  // two roles; external mode resolves both to the operator's single URL.
  let hxDbRw: HxDb | null = null;
  const resolveHxDb = (): HxDb | null => {
    if (hxDbRw) return hxDbRw;
    const dsn = postgres.dsn("rw");
    if (!dsn) return null;
    hxDbRw = createHxDb(dsn);
    return hxDbRw;
  };
  let hxDbRo: HxDb | null = null;
  const resolveHxDbRead = (): HxDb | null => {
    if (hxDbRo) return hxDbRo;
    const dsn = postgres.dsn("ro");
    if (!dsn) return null;
    hxDbRo = createHxDb(dsn);
    return hxDbRo;
  };
  // The store-write pause plane. The state is what the gate consults on every
  // bucket-mutating call; the counter is what a pre-swap quiesce barrier waits
  // on. Both are created before the store so the gate can be composed around
  // it, and refreshed from Postgres on the status-heartbeat cadence.
  const pauseState = new PauseState();
  const quiesce = new IngestQuiesce();
  // The drain latch: while it is up, new staging signatures are cut short so the
  // pre-swap barrier has a bounded floor to wait out. In MEMORY on purpose — a
  // restart clears it, which bounds an armed migration nobody followed up.
  let drainArmed = false;
  const parkedArtifactsPath = path.join(paths.runtimeRoot, "artifact-replay.jsonl");
  const metrics = new MetricsRegistry();
  metrics.declareCounter("ingest.paused_refusals");
  metrics.registerGauge("ingest.pause_seconds_remaining", () => {
    const until = pauseState.pausedUntil();
    return until ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : 0;
  });
  metrics.registerGauge("store.in_flight_writes", () => quiesce.pending);
  // A gauge that returns null is OMITTED rather than published as 0 — "the
  // direct gateway is off on this fortress" and "the gateway served nothing"
  // read identically as a zero and mean opposite things.
  metrics.registerGauge("gateway.enabled", () => (gateway.enabled ? 1 : null));

  // Fortress→cloud realtime bridge (MC-2415): ingest paths emit invalidations
  // here; the closure is repointed at the live connection once it's built below
  // (the connection is constructed after the module that needs to emit). A
  // no-op until then, so any ingest before the tunnel is up is simply not
  // signalled (the client's own refetch recovers the list).
  const hubNotify: { send: (evt: HxIngestNotification) => void } = { send: () => {} };
  // MC-2430 tunnel-MCP: late-bound like hubNotify — the connection is built
  // before the embedder/store below, so hand it a holder and repoint it once
  // db+store+embedder exist. Replies "not ready" until then.
  const mcpTunnel: { handle: (req: McpTunnelRequest) => Promise<McpTunnelResult> } = {
    handle: async () => ({ method: "callTool", content: JSON.stringify({ error: "mcp_tunnel_not_ready" }), isError: true }),
  };
  const emitIngest = (evt: HxIngestNotification): void => hubNotify.send(evt);
  // The vault RPC dispatch takes both handles: writes (ingest RPCs) run on the RW
  // handle; the "my sessions" metadata read (listSessions) runs on the SELECT-only
  // RO handle (least-privilege — the read branch never needs DML).
  const vaultModule = createSessionVaultModule({
    db: resolveHxDb,
    dbRead: resolveHxDbRead,
    notify: emitIngest,
    // Closure to the provider declared below (same late-binding as resolveHxDb):
    // only invoked at wedge-escalation time, long after startup completes.
    stopEmbeddedPostgres: () => postgres.stop(),
    pause: { state: pauseState, quiesce, armed: () => drainArmed },
  });
  registry.register(vaultModule);
  const credentialStore = new FileCredentialStore(paths.credentials);
  const pendingEnrollmentStore = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  const signingKeyStore = new FileSigningKeyStore(paths.signingKey);

  // H-4 · verify a tunnel/reverse-tunnel capability GRANT offline against the
  // PINNED per-org signing key + the enrolled org id. Shared by the cloud
  // connection (vault RPC) and the reverse-tunnel MCP handler. Throws (⇒ the
  // caller rejects the grant) before the key is pinned or the org id is known.
  const verifyGrantFn = async (
    token: string,
    opts: { purpose: "ingest" | "read"; requireScope?: boolean },
  ): Promise<GrantClaims> => {
    const key = await signingKeyStore.pinnedKey();
    if (!key) throw new Error("no pinned signing key");
    const orgId = (await credentialStore.load().catch(() => null))?.orgId ?? null;
    if (!orgId) throw new Error("fortress org id unknown");
    // requireScope is the CALLER's decision (vault-RPC own-object reads pass false;
    // the scope-bound tunnel-MCP read path passes true) — forward it unchanged.
    return verifyGrant(token, key, orgId, opts);
  };

  if (homeResolution.adopted) {
    // Said out loud, with what was looked at: an operator comparing this against
    // the volume they think they mounted is the only way a home that moved
    // between image versions ever gets noticed.
    bus.scopeFor("fortress").info("serving from an adopted fortress home", {
      home: homeResolution.home,
      searched: homeResolution.searched,
    });
  }

  // Cloud-service run mode: materialize storage credentials + a pending
  // enrollment from the environment before reading them off disk, so a fresh
  // container enrolls with zero interaction. No-op when the headless env is
  // absent (e.g. a normal operator install driven by the enroll wizard).
  await applyHeadlessBootstrap({
    env: process.env,
    credentialStore,
    pendingEnrollmentStore,
    writeVaultCredentials,
    readVaultCredentials,
    logger: bus.scopeFor("fortress"),
  });

  let pendingEnrollment = await resolvePendingEnrollmentForStartup(
    pendingEnrollmentStore,
  );

  if (pendingEnrollment) {
    // M-8 · gate a hijack-drop pending enrollment BEFORE its config/token loads:
    // once a credential is saved, only honor a pending enrollment at the same
    // enrolled cloud origin (or under FORTRESS_ALLOW_REENROLL).
    const savedCredential = await credentialStore.load().catch(() => null);
    const enrolledConfig = await new FileConfigStore(paths).load().catch(() => null);
    const trusted = isPendingEnrollmentTrusted({
      savedCredentialExists: savedCredential !== null,
      pendingCloudUrl: pendingEnrollment.cloudUrl,
      enrolledCloudUrl: enrolledConfig?.cloud.url ?? null,
      allowReenroll: parseBooleanEnv(process.env.FORTRESS_ALLOW_REENROLL),
    });
    if (trusted) {
      await ensureEnrollmentConfig(paths, pendingEnrollment.cloudUrl);
    } else {
      bus.scopeFor("fortress").warn(
        "ignoring a pending enrollment for an already-enrolled fortress: its cloudUrl origin " +
          "differs from the enrolled one; set FORTRESS_ALLOW_REENROLL to re-enroll",
        {
          enrolledOrigin: enrolledConfig ? wsOrigin(enrolledConfig.cloud.url) : null,
          pendingOrigin: wsOrigin(pendingEnrollment.cloudUrl),
        },
      );
      // Fall through to `hello` with the saved credential — the hijack token
      // never loads (enrollToken below reads pendingEnrollment?.token).
      pendingEnrollment = null;
    }
  }
  await ensureGatewayPublicUrlConfigured(paths);
  await ensureCoreModulesEnabled(paths);

  // let configuredGatewayUrl: string | undefined;
  // try {
  //   configuredGatewayUrl = (await new FileConfigStore(paths).load()).gateway.publicUrl;
  // } catch {
  //   configuredGatewayUrl = undefined;
  // }
  const gateway = resolveGatewayConfig(process.env,
    //configuredGatewayUrl
  );

  // Read the persisted config (if any) only to pick up postgres overrides;
  // a fresh install has no config.json yet, so fall back to defaults. The
  // runtime reloads and validates the full config itself on start().
  const hostConfig = await new FileConfigStore(paths).load().catch(() => null);
  const postgres = buildPostgresProvider({
    env: process.env,
    config: hostConfig ?? {
      schemaVersion: 1,
      cloud: { url: "" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: [] },
    },
    paths,
    logger: bus.scopeFor("postgres"),
  });

  const vaultCreds = await readVaultCredentials();

  // MC-2471: fail-fast — the fortress indexes sessions for semantic search by
  // creating OpenAI vector embeddings in its local Postgres DB. Without a key
  // that search can't work, so refuse to start rather than silently degrade to
  // keyword-only search. Set it in the enroll wizard, or FORTRESS_OPENAI_API_KEY.
  if (!resolveEmbedConfig(process.env, vaultCreds?.openaiApiKey).enabled) {
    throw new Error(
      "hx-fortress needs an OpenAI API key to create vector embeddings for semantic " +
        "search of the sessions stored in its local Postgres DB. Add it in the enroll " +
        "wizard (hx-fortress enroll) or set FORTRESS_OPENAI_API_KEY, then start again.",
    );
  }

  const connectionDependencies: WsCloudConnectionDeps = {
    dispatcher: registry,
    credentialStore,
    // Composed at EVERY connection attempt, not once at boot: consoleUrl and
    // runtimeKind are read from ui.json and the environment as they stand now,
    // so `ui sso off` and `ui disable` reach the hub on the next reconnect
    // instead of being overwritten by whatever boot happened to read.
    identity: async () => ({
      version,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      storageKind: vaultCreds?.store ?? undefined,
      bucketRegion: vaultCreds?.region ?? undefined,
      bucket: vaultCreds?.bucket ?? undefined,
      gatewayUrl: gateway.gatewayUrl,
      ...(await readConsoleAdvertisement({
        config: new LiveUiConfig(paths.uiConfig),
        env: process.env,
      })),
    }),
    logger,
    signingKeyStore,
    verifyGrant: verifyGrantFn,
    mcp: mcpTunnel,
    // MC-2368: report collection counts on the heartbeat once the DB is ready.
    collectionStats: async () => {
      const db = resolveHxDb();
      return db ? computeCollectionStats(db) : null;
    },
    // The roster arrives unsolicited, on connect and whenever the hub recomputes
    // it. Stored as it lands so the console never has to ask the cloud a
    // question at read time.
    onRoster: async (roster) => {
      const db = postgres.isReady() ? resolveHxDb() : null;
      if (!db) throw new Error("the fortress database is not available");
      const applied = await replaceRoster(db, roster);
      bus.scopeFor("roster").info("applied the roster let.ai sent", {
        members: applied.received,
        departed: applied.deactivated,
      });
    },
    enrollToken: pendingEnrollment?.token,
    async onEnrolled(cred) {
      await pendingEnrollmentStore.clear().catch((err) => {
        logger.error("Failed to clear pending enrollment token", err);
      });
      registry.setFortressIdentity(cred);
    },
  };
  const connection =
    dependencies.createConnection?.(connectionDependencies) ??
    new WsCloudConnection(connectionDependencies);
  // Now that the tunnel connection exists, route ingest notifications to it.
  hubNotify.send = (evt) => connection.notifyIngest(evt);
  const runtime = new HostRuntime({
    configStore: new FileConfigStore(paths),
    connection,
    postgres,
    supervisor: registry,
    statusStore: new FileStatusStore(paths),
    logger,
    // Published so a console can prove by file identity that it is looking at
    // THIS install rather than a second daemon on another root.
    root: paths.root,
    afterPostgres: () => bootConsolePlane(),
    // Low · fold a secret-free vault view into each status snapshot (never keys).
    vaultStatus: () => (vaultCreds ? redactCredentials(vaultCreds) : null),
    async afterConnect() {
      // Load the saved Fortress identity and make it available to modules.
      // Works for both the fresh-enrollment path (onEnrolled already set it)
      // and returning connections (credential already existed on disk).
      const cred = await credentialStore.load().catch(() => null);
      registry.setFortressIdentity(cred);
      // The hub is reachable as of now — ask for its view of this organization
      // immediately instead of waiting out the refresh interval.
      void refreshPosture();
    },
  });

  // Start the direct-ingest gateway alongside the tunnel when the operator has
  // exposed a public URL. It presigns against the same live session_vault store
  // the tunnel RPCs use, and verifies capability tokens with the org public key
  // the hub pushes over the tunnel (cached on disk for offline restarts).
  // The same Bun.serve gateway also serves the hx_* MCP server at POST /mcp
  // (A5) — so the MCP endpoint boots here, with the gateway, whenever a public
  // URL is configured.
  // The fortress's OpenAI embedder (A3) — null when FORTRESS_OPENAI_API_KEY is
  // absent, so the embed worker stays off and hx_semantic_search degrades to
  // keyword. Shared by the gateway's semantic tool and the embed worker.
  const embedConfig = resolveEmbedConfig(process.env, vaultCreds?.openaiApiKey);
  const embedder: Embedder | null = embedConfig.enabled
    ? createOpenAIEmbedder({
        apiKey: embedConfig.apiKey,
        model: embedConfig.model,
        dimensions: embedConfig.dimensions,
        baseUrl: embedConfig.baseUrl,
      })
    : null;
  // MC-2517 · the QUERY-path embedder (hx_semantic_search, served over the tunnel
  // and the HTTP gateway) is BOUNDED — each OpenAI attempt is time-capped and
  // retried a few times (config.queryTimeoutMs / queryMaxRetries). A stalled
  // embeddings call then fails fast with a typed `unavailable` the agent relays,
  // instead of hanging the MCP call until the workbench's 60s ceiling kills it
  // silently. The background embed worker keeps the unbounded `embedder` above (it
  // tolerates slow OpenAI and just retries next pass). Same key/model/dimensions/
  // baseUrl, so vector distances stay comparable across the two.
  const queryEmbedder: Embedder | null = embedConfig.enabled
    ? createOpenAIEmbedder({
        apiKey: embedConfig.apiKey,
        model: embedConfig.model,
        dimensions: embedConfig.dimensions,
        baseUrl: embedConfig.baseUrl,
        timeoutMs: embedConfig.queryTimeoutMs,
        maxRetries: embedConfig.queryMaxRetries,
      })
    : null;
  // H-7 · loud one-time warning when conversational text is embedded against the
  // PUBLIC OpenAI endpoint — it carries no zero-retention/DPA guarantee. Steer the
  // operator at a zero-retention endpoint via FORTRESS_OPENAI_BASE_URL.
  if (embedConfig.enabled && embedConfig.baseUrl === "https://api.openai.com/v1") {
    bus
      .scopeFor("embed-worker")
      .warn(
        "embeddings egress to the public OpenAI endpoint (no zero-retention/DPA guarantee); " +
          "set FORTRESS_OPENAI_BASE_URL to a zero-retention endpoint",
      );
  }

  // Tunnel-MCP now has db+store+embedder — repoint the holder to the real
  // handler so the reverse tunnel serves the same hx_* tools as the HTTP gateway.
  mcpTunnel.handle = createMcpTunnelHandler({
    // Read-only tools → the SELECT-only RO handle (least-privilege).
    db: resolveHxDbRead,
    store: () => vaultModule.getStore(),
    // MC-2517 · the bounded query embedder (fails fast on a stalled OpenAI call).
    embedder: queryEmbedder,
    // H-4 · a tunnel MCP read runs under a verified read grant (scope-bound).
    verifyGrant: verifyGrantFn,
  }).handle;

  let gatewayHandle: GatewayHandle | null = null;
  if (gateway.enabled) {
    gatewayHandle = startGatewayServer({
      port: gateway.port,
      logger: bus.scopeFor("gateway"),
      signingKey: () => signingKeyStore.load(),
      // The fortress's own org id (from the enrolled cloud credential) lets the
      // gateway reject a capability token whose `aud` names a different org —
      // anti cross-org replay. Null before enrollment (no token verifies then).
      ownOrgId: () => credentialStore.load().then((c) => c?.orgId ?? null).catch(() => null),
      store: () => vaultModule.getStore(),
      postgresReady: () => postgres.isReady(),
      // RW handle for the ingest write path; RO handle for the /mcp read tools.
      db: resolveHxDb,
      dbRead: resolveHxDbRead,
      // MC-2517 · the bounded query embedder (fails fast on a stalled OpenAI call).
      embedder: queryEmbedder,
      notify: emitIngest,
      quiesce,
      parkArtifact: (entry) => parkArtifact(parkedArtifactsPath, entry),
    });
  }

  // Boot the embed worker beside the gateway (A3). It owns its OWN capped
  // Bun.SQL handle (resolved lazily once the cluster's dsn is available — the
  // shared createHxDb handle is uncapped) and drains the anti-join of un-embedded
  // indexable turns; ingest signals it post-commit (debounced + max-wait capped).
  // Runs whenever a key is configured, independent of the public gateway (ingest
  // also arrives over the tunnel).
  let embedWorker: EmbedWorker | null = null;
  if (embedder) {
    embedWorker = createEmbedWorker({
      // The embed worker writes embeddings + budget rows → the RW role.
      dsn: () => postgres.dsn("rw"),
      embedder,
      dbMax: embedConfig.dbMax,
      concurrency: embedConfig.concurrency,
      batchSize: embedConfig.batchSize,
      maxPerPass: embedConfig.maxPerPass,
      debounceMs: embedConfig.debounceMs,
      maxWaitMs: embedConfig.maxWaitMs,
      dailyTokenBudget: embedConfig.dailyTokenBudget,
      logger: bus.scopeFor("embed-worker"),
    });
    setEmbedSignalHandler(() => embedWorker?.signal());
    embedWorker.start();
  }

  // Component G (MC-2606) — the guarantor. Re-indexes any canonical transcript
  // that reached the bucket but has NO hx.sessions row (the row-less state behind
  // the title incident), re-running the FULL ingest so rows, FTS, tool_calls,
  // session_facts, dimensions, embeddings and the real title are all rebuilt. ON
  // by default (FORTRESS_GUARANTOR_DISABLED turns it off). Reads the same lazily-
  // resolved RW db + live vault store the gateway uses, so it's safe to start
  // before either is ready (a pass that finds them down just reschedules).
  //
  // Pacing knobs (optional): a boot-drain of the whole backlog re-ingests every
  // orphan at once, which enqueues all their turns for embedding at the daily
  // budget. Titles/rows appear immediately (written in the ingest txn); only
  // embeddings lag. Unbounded by default (fast restore, accept a short semantic-
  // search lag); FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS caps a pass so the
  // backlog drains across the hourly sweeps instead. FORTRESS_CORRECT_TITLES
  // opts into the one-time backfill of pre-existing fallback/empty titles (off by
  // default — it re-reads every such canonical, and restores already get their
  // real title from the cascade).
  let guarantor: Guarantor | null = null;
  if (guarantorEnabled()) {
    const maxOrphansRaw = Number(process.env.FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS);
    const maxOrphans =
      Number.isFinite(maxOrphansRaw) && maxOrphansRaw > 0 ? Math.trunc(maxOrphansRaw) : undefined;
    const batchDelayRaw = Number(process.env.FORTRESS_GUARANTOR_BATCH_DELAY_MS);
    const batchDelayMs =
      Number.isFinite(batchDelayRaw) && batchDelayRaw >= 0 ? Math.trunc(batchDelayRaw) : undefined;
    guarantor = createGuarantor({
      db: resolveHxDb,
      store: () => vaultModule.getStore(),
      logger: bus.scopeFor("guarantor"),
      correctExistingTitles: parseBooleanEnv(process.env.FORTRESS_CORRECT_TITLES),
      reconcile: { maxOrphans, batchDelayMs },
    });
    guarantor.start();
    // A known best-effort-mirror failure (PG down / index threw after the
    // canonical was stored) nudges the guarantor to re-index the orphan soon,
    // rather than waiting for the next hourly sweep.
    setReconcileSignalHandler(() => guarantor?.signal());
  } else {
    bus.scopeFor("guarantor").warn("guarantor disabled (FORTRESS_GUARANTOR_DISABLED)");
  }

  // Republished every 10s, and once immediately: an ABSENT metrics.json means
  // "no daemon", so the file has to exist as soon as one does rather than a
  // tick later.
  const metricsPublisher = startMetricsPublisher({
    registry: metrics,
    filePath: paths.metrics,
    onError: (err) =>
      bus.scopeFor("fortress").warn("could not publish metrics", {
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  void metricsPublisher.flush();

  // Refreshes the cached pause deadline on the status-heartbeat cadence. A
  // FAILED read keeps the last known deadline: losing Postgres must never
  // REOPEN the gate under a migration that armed the pause and then lost its
  // database.
  const consoleLog = bus.scopeFor("console");
  // The daemon's spool writer. Its general records are gated on the EFFECTIVE
  // enablement predicate, read live so `ui enable` lands without a restart;
  // command transitions ignore that gate entirely, because a command row
  // existing already implies a console and a rotation performed while the
  // console was down must still be corroborable when it comes back.
  const uiConfigReader = new LiveUiConfig(paths.uiConfig);
  const daemonAudit = new DaemonAudit({
    dir: paths.auditSpool,
    consoleEnabled: async () => effectiveUiEnabled(await uiConfigReader.read(), process.env),
    onError: (error) =>
      consoleLog.warn("an audit record could not be spooled", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });

  const refreshPause = async (): Promise<void> => {
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    let row;
    try {
      row = await readCurrentEpisode(db);
    } catch {
      pauseState.observeUnavailable();
      return;
    }
    const now = new Date();
    let firstObservedAt: Date | null = null;
    if (row && row.resumedAt === null) {
      // Keyed by EPISODE. An anchor kept merely because a file was there let an
      // expired-but-unresumed episode hand its own exhausted bound to the next
      // one, which made that pause expired the moment it was armed — the barrier
      // a storage-migration swap waits on would then be a no-op nobody could see.
      firstObservedAt = new Date(
        (await stampPauseAnchor(paths.pauseAnchor, row.id, now)).firstObservedAt,
      );
    } else {
      // Cleared on resume, so a later episode can never anchor to an earlier one.
      await clearPauseAnchor(paths.pauseAnchor);
    }
    const pause = effectivePause({ row, firstObservedAt, now });
    const wasPaused = pauseState.isPaused(now);
    pauseState.observe(pause);
    if (pause.capped) {
      consoleLog.warn("ingest pause deadline exceeds the cap and was clamped", {
        requested: row?.pausedUntil.toISOString() ?? null,
        effective: pause.pausedUntil?.toISOString() ?? null,
      });
    }
    if (wasPaused && !pauseState.isPaused(now)) {
      // Writes are open again — replay everything the gate refused.
      const store = vaultModule.getStore();
      if (store) {
        const result = await drainParkedArtifacts(parkedArtifactsPath, (entry) =>
          store.writeArtifact(entry.key, entry.name, entry.text),
        );
        if (result.replayed > 0 || result.failed > 0) {
          consoleLog.info("replayed parked artifact writes after resume", {
            replayed: result.replayed,
            failed: result.failed,
          });
          await daemonAudit.record("system.artifact_replay", {
            params: { engine: "artifact replay", count: result.replayed },
          });
        }
      }
    }
  };
  const pauseTimer = setInterval(() => void refreshPause(), 5_000);
  (pauseTimer as { unref?: () => void }).unref?.();

  // The two questions only the hub can answer, and the one transport there is to
  // ask them over. A connection that cannot ask (no tunnel, a test double) leaves
  // `askHub` undefined, and both callers below degrade to "unavailable" — which
  // the console renders as NOT CHECKED, never as a clean answer.
  const askHub = connection.request?.bind(connection);
  const postureCache = new RoutingPostureCache(routingPosturePath(paths.runtimeRoot));
  const askWitness = createWitnessClient({
    request: askHub,
    onUnavailable: (reason) =>
      consoleLog.info("the residency audit could not ask let.ai about this run", { reason }),
  });
  const refreshPosture = async (): Promise<void> => {
    if (!askHub) return;
    try {
      const result = await askHub({ kind: "routingPosture" });
      const data = result.kind === "routingPosture" ? result.routingPosture : undefined;
      if (!data) {
        await postureCache.recordUnavailable("the hub answered without a routing posture");
        return;
      }
      await postureCache.write({ fetchedAt: new Date().toISOString(), data });
    } catch (err) {
      // Recorded WITH its timestamp rather than left alone: a snapshot that stops
      // being refreshed would otherwise keep reading as current forever.
      await postureCache
        .recordUnavailable(err instanceof Error ? err.message : String(err))
        .catch(() => {});
    }
  };
  const postureTimer = setInterval(() => void refreshPosture(), POSTURE_REFRESH_MS);
  (postureTimer as { unref?: () => void }).unref?.();

  /** Boot order: role provisioning (inside postgres.start) → FENCE → any poll.
   *  Fence-first is unachievable under the embedded apparatus — ensureAppRoles
   *  is what CREATES hx.reject_command, and Postgres resolves the function at
   *  parse time, so the statement errors even against zero rows. */
  /** Rows the boot fence found still ours; only these may be re-claimed. */
  let redriveIds: ReadonlySet<string> = new Set();
  /** pid + a boot-unique id. Observability only — never a security predicate. */
  const claimedBy = `${process.pid}:${randomUUID()}`;
  /** Set by the update executor once a new binary is in place; acted on only
   *  after the poll pass that wrote the outcome record has returned. */
  let restartAfterUpdate = false;
  const commandExecutors = createCommandExecutors({
    logger: consoleLog,
    store: () => vaultModule.getStore(),
    cmdCredsDir: paths.cmdCreds,
    env: process.env,
    db: () => (postgres.isReady() ? resolveHxDb() : null),
    // The ONLY way a rotation reaches the running daemon. A module restart
    // would answer tunnel RPCs with an error the cloud does not classify as
    // retryable while it was down.
    rebindStore: () => vaultModule.rebindStore(),
    setCloudCredential: async (credential) => {
      const current = await credentialStore.load();
      if (!current) throw new Error("this fortress is not enrolled, so it holds no cloud credential");
      const updated = { ...current, credential };
      await credentialStore.save(updated);
      registry.setFortressIdentity(updated);
      return updated;
    },
    status: () => new FileStatusReader(paths.status).read().catch(() => null),
    embeddingEndpoint: () => (embedConfig.enabled ? embedConfig.baseUrl : null),
    runAudit: () =>
      runAuditForFortress({
        db: () => (postgres.isReady() ? resolveHxDb() : null),
        store: () => vaultModule.getStore(),
        // The fortress asks and the hub answers. A timeout, a dead socket or a
        // hub too old to know the frame all come back as no answer at all, which
        // the run reports as an unasked witness by name.
        askWitness,
        postureFresh: async () =>
          postureFreshness(await postureCache.read(), Date.now()) === "fresh",
        publish: (acks) =>
          publishAcks(
            paths.runtimeRoot,
            acks.map((ack) => ({
              org: ack.org,
              sessionId: ack.sessionId,
              acknowledgedAt: ack.acknowledgedAt,
              acknowledgedBy: ack.acknowledgedBy,
              reason: ack.reason,
            })),
          ),
      }),
    runMigration: ({ command, target, credentialRef }) =>
      runMigrationCommand(
        {
          db: () => (postgres.isReady() ? resolveHxDb() : null),
          store: () => vaultModule.getStore(),
          // The DIRECT backend for the candidate: the migration is the only
          // thing writing this bucket, and a guarded store would escalate a
          // wedge by exiting the daemon over a bucket nothing serves from yet.
          buildTarget: (credentials) => buildDirectStore(credentials),
          quiesce,
          // The gate the swap proves itself against is the one that refuses
          // writes — this cached state, and the refresh that fills it — never
          // the deadline the run asked the database for.
          gate: () => ({ pausedUntil: pauseState.pausedUntil(), capped: pauseState.capped }),
          refreshGate: refreshPause,
          setDrain: (on) => {
            drainArmed = on;
          },
          // The ONLY way the swapped credentials reach the running daemon, and
          // the same factory init() uses: a bare backend here would serve every
          // later write with no pause gate, no deadline and no rebuild policy.
          rebindStore: () => vaultModule.rebindStore(),
          targetCredentials: () =>
            credentialRef
              ? consumeCredentialRef<VaultCredentials>(paths.cmdCreds, credentialRef)
              : Promise.resolve(null),
          env: process.env,
          logger: consoleLog,
        },
        { command, target },
      ),
    setCloudWitness: (enabled) => applyCloudWitness(enabled),
    acknowledgeFinding: async ({ org, sessionId, reason }) => {
      const db = postgres.isReady() ? resolveHxDb() : null;
      if (!db) throw new Error("the fortress database is not available");
      // Through the fenced routine, never a direct INSERT: an acknowledgement is
      // not re-derivable, and one INSERT ... SELECT would acknowledge every
      // residency finding this organization has, permanently.
      await db.execute(
        sqlTag`SELECT hx.acknowledge_finding(${org}, ${sessionId}, ${"console operator"}, ${reason})`,
      );
      await publishAcksFromDb();
    },
    downloadBaseUrl: async () => {
      const loaded = await new FileConfigStore(paths).load().catch(() => null);
      if (!loaded?.cloud.url) return null;
      try {
        return downloadBaseFromCloudUrl(loaded.cloud.url);
      } catch {
        return null;
      }
    },
    service: getServiceManager(),
    onBinarySwapped: () => {
      restartAfterUpdate = true;
    },
  });

  /**
   * One poll pass over the command queue.
   *
   * The daemon is the only executor: the console can ask, and the write role
   * cannot even ask. A pass that finds nothing costs one indexed SELECT.
   */
  async function pollConsolePlane(): Promise<void> {
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    try {
      await pollCommands(
        {
          gateway: createCommandGateway(db),
          inFlightPath: paths.commandsInFlight,
          claimedBy,
          logger: consoleLog,
          onTransition: daemonAudit.onTransition,
          executors: commandExecutors,
        },
        redriveIds,
      );
    } catch (err) {
      consoleLog.error("console command poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!restartAfterUpdate) return;
    restartAfterUpdate = false;
    // AFTER the outcome record reached disk. The console unit goes first
    // because the daemon's own restart ends this process.
    try {
      if (await getUiServiceControl().installed()) restartUiUnitDetached({});
      await getServiceManager().restart();
    } catch (err) {
      consoleLog.error("the fortress could not restart onto the new binary", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Flip the egress toggle through the fenced routine, then republish it for
   *  `hx-fortress audit witness show` — which has no database credential and
   *  must not be given one. */
  async function applyCloudWitness(enabled: boolean): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) throw new Error("the fortress database is not available");
    await db.execute(sqlTag`SELECT hx.set_cloud_witness(${enabled})`);
    await publishAuditSettings(paths.runtimeRoot, enabled);
  }

  async function publishAcksFromDb(): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) return;
    const acks = await readAcknowledgements(db).catch(() => []);
    await publishAcks(paths.runtimeRoot, acks);
  }

  /**
   * The terminal's half of `audit witness on|off`, and of the corrective
   * re-confirmation pass.
   *
   * The CLI writes its intent and signals; the daemon is what holds the database
   * and what executes the fenced routine. That split is what keeps hx_ui the
   * console process alone rather than every shell on this host.
   */
  async function applyWitnessIntent(): Promise<void> {
    const intent = await readWitnessIntent(paths.runtimeRoot).catch(() => null);
    if (!intent) return;
    try {
      await daemonAudit.run(
        "system.audit_witness",
        { engine: "audit witness", kind: intent.enabled ? "on" : "off" },
        async () => {
          await applyCloudWitness(intent.enabled);
          for (const row of intent.reconfirm ?? []) {
            const db = postgres.isReady() ? resolveHxDb() : null;
            if (!db) break;
            await db.execute(
              sqlTag`SELECT hx.acknowledge_finding(${row.org}, ${row.sessionId}, ${"terminal operator"}, ${row.reason})`,
            );
          }
          await publishAcksFromDb();
          return { enabled: intent.enabled };
        },
      );
    } catch (err) {
      consoleLog.error("could not apply the audit witness intent", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await clearWitnessIntent(paths.runtimeRoot).catch(() => {});
  }

  /**
   * Roster retention.
   *
   * Departed members are kept for a configurable window and then removed — the
   * one place in this system where people-data ages out on its own. It reads the
   * retention from config.json at every sweep rather than caching it at boot, so
   * shortening it takes effect on the next pass instead of the next restart.
   */
  async function sweepRoster(requestedDays: number | null = null): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) return;
    const configured = rosterInactivePurgeDays(
      await new FileConfigStore(paths).load().catch(() => null),
    );
    const days = requestedDays ?? configured;
    try {
      await daemonAudit.run(
        "system.roster_purge",
        { engine: "roster retention", kind: `${days}d` },
        async () => {
          const removed = await purgeInactiveRoster(db, days);
          await publishRosterPurge(paths.runtimeRoot, {
            at: new Date().toISOString(),
            removed,
            days,
          });
          if (removed > 0) {
            consoleLog.info("purged departed roster members", { removed, days });
          }
          return { removed, days };
        },
      );
    } catch (err) {
      consoleLog.error("the roster retention sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The terminal's half of `roster purge-inactive`: it writes the intent and
   *  signals, because it holds no database credential and must not. */
  async function applyRosterPurgeIntent(): Promise<void> {
    const intent = await readRosterPurgeIntent(paths.runtimeRoot).catch(() => null);
    if (!intent) return;
    await sweepRoster(intent.days);
    await clearRosterPurgeIntent(paths.runtimeRoot).catch(() => {});
  }

  // One signal, every pending intent: the terminal writes a file and nudges, and
  // the daemon applies whichever files are there when it wakes.
  process.on("SIGUSR2", () => {
    void applyWitnessIntent();
    void applyRosterPurgeIntent();
  });

  const rosterTimer = setInterval(() => void sweepRoster(), 24 * 60 * 60_000);
  (rosterTimer as { unref?: () => void }).unref?.();

  const commandTimer = setInterval(() => void pollConsolePlane(), 1_000);
  (commandTimer as { unref?: () => void }).unref?.();

  async function bootConsolePlane(): Promise<void> {
    await refreshPause();
    // A fortress that is off for a month must not wait another day for the
    // retention it already owes.
    await sweepRoster();
    // Orphaned credential files are secrets on disk for commands that will
    // never run; sweep them as soon as the daemon is up, not only on a timer.
    const swept = await sweepCmdCreds(paths.cmdCreds).catch(() => ({ deleted: [] }));
    if (swept.deleted.length > 0) {
      consoleLog.info("swept expired command credentials", { count: swept.deleted.length });
    }
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    try {
      await daemonAudit.run("system.command_fence", { engine: "command fence" }, async () => {
        const fence = await runBootFence({
          gateway: createCommandGateway(db),
          inFlightPath: paths.commandsInFlight,
          claimedBy,
          logger: consoleLog,
          onTransition: daemonAudit.onTransition,
        });
        redriveIds = new Set(fence.redriven);
        return fence;
      });
    } catch (err) {
      consoleLog.error("console command boot fence failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await (dependencies.run ?? runHost)(runtime);
  } finally {
    clearInterval(pauseTimer);
    clearInterval(postureTimer);
    clearInterval(rosterTimer);
    clearInterval(commandTimer);
    metricsPublisher.stop();
    gatewayHandle?.stop();
    setEmbedSignalHandler(() => {});
    setReconcileSignalHandler(() => {});
    await embedWorker?.stop();
    await guarantor?.stop();
  }
}
