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
  writeVaultCredentials,
} from "../modules/session-vault/credentials.js";
import { applyHeadlessBootstrap } from "./headless-bootstrap";
import {
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
  resolveEmbedConfig,
  resolveGatewayConfig,
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
import type { CloudConnection, HxIngestNotification } from "./types";
import { FileSigningKeyStore } from "../gateway/signing-key-store";
import { startGatewayServer, type GatewayHandle } from "../gateway/server";
import { createMcpTunnelHandler } from "../mcp/tunnel-handler";
import type { McpTunnelRequest, McpTunnelResult } from "../protocol";

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

export async function runFortressHost(
  dependencies: HostMainDependencies = {},
): Promise<void> {
  const root = dependencies.root;
  const version = dependencies.version ?? packageJson.version;
  const paths = fortressPaths(root);
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
  // wired). Shared by the tunnel module (relayed commits) and the direct
  // gateway so both ingest into the same hx-db handle.
  let hxDb: HxDb | null = null;
  const resolveHxDb = (): HxDb | null => {
    if (hxDb) return hxDb;
    const dsn = postgres.dsn();
    if (!dsn) return null;
    hxDb = createHxDb(dsn);
    return hxDb;
  };
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
  const vaultModule = createSessionVaultModule({ db: resolveHxDb, notify: emitIngest });
  registry.register(vaultModule);
  const credentialStore = new FileCredentialStore(paths.credentials);
  const pendingEnrollmentStore = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  const signingKeyStore = new FileSigningKeyStore(paths.signingKey);

  // Cloud-service run mode: materialize storage credentials + a pending
  // enrollment from the environment before reading them off disk, so a fresh
  // container enrolls with zero interaction. No-op when the headless env is
  // absent (e.g. a normal operator install driven by the enroll wizard).
  await applyHeadlessBootstrap({
    env: process.env,
    credentialStore,
    pendingEnrollmentStore,
    writeVaultCredentials,
    logger: bus.scopeFor("fortress"),
  });

  const pendingEnrollment = await resolvePendingEnrollmentForStartup(
    pendingEnrollmentStore,
  );

  if (pendingEnrollment) {
    await ensureEnrollmentConfig(paths, pendingEnrollment.cloudUrl);
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
    identity: {
      version,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      storageKind: vaultCreds?.store ?? undefined,
      bucketRegion: vaultCreds?.region ?? undefined,
      bucket: vaultCreds?.bucket ?? undefined,
      gatewayUrl: gateway.gatewayUrl,
    },
    logger,
    signingKeyStore,
    mcp: mcpTunnel,
    // MC-2368: report collection counts on the heartbeat once the DB is ready.
    collectionStats: async () => {
      const db = resolveHxDb();
      return db ? computeCollectionStats(db) : null;
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
    async afterConnect() {
      // Load the saved Fortress identity and make it available to modules.
      // Works for both the fresh-enrollment path (onEnrolled already set it)
      // and returning connections (credential already existed on disk).
      const cred = await credentialStore.load().catch(() => null);
      registry.setFortressIdentity(cred);
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

  // Tunnel-MCP now has db+store+embedder — repoint the holder to the real
  // handler so the reverse tunnel serves the same hx_* tools as the HTTP gateway.
  mcpTunnel.handle = createMcpTunnelHandler({
    db: resolveHxDb,
    store: () => vaultModule.getStore(),
    embedder,
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
      db: resolveHxDb,
      embedder,
      notify: emitIngest,
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
      dsn: () => postgres.dsn(),
      embedder,
      dbMax: embedConfig.dbMax,
      concurrency: embedConfig.concurrency,
      batchSize: embedConfig.batchSize,
      maxPerPass: embedConfig.maxPerPass,
      debounceMs: embedConfig.debounceMs,
      maxWaitMs: embedConfig.maxWaitMs,
      logger: bus.scopeFor("embed-worker"),
    });
    setEmbedSignalHandler(() => embedWorker?.signal());
    embedWorker.start();
  }

  try {
    await (dependencies.run ?? runHost)(runtime);
  } finally {
    gatewayHandle?.stop();
    setEmbedSignalHandler(() => {});
    await embedWorker?.stop();
  }
}
