import {
  FileCredentialStore,
  FilePendingEnrollmentStore,
  SUPPORTED_PROTOCOL_VERSION,
  WsCloudConnection,
} from "../cloud";
import type { PendingEnrollment, WsCloudConnectionDeps } from "../cloud";
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
  resolveGatewayConfig,
} from "./config";
import { FileLogSink } from "./file-log-sink";
import { BusHostLogger, LogBus } from "./logging";
import { ModuleRegistry } from "./module-registry";
import { fortressPaths } from "./paths";
import { buildPostgresProvider } from "./postgres";
import { createHxDb, type HxDb } from "./postgres/db";
import { runHost, type HostLifecycle } from "./run-host";
import { HostRuntime } from "./runtime";
import { FileStatusStore } from "./status";
import type { CloudConnection } from "./types";
import { FileSigningKeyStore } from "../gateway/signing-key-store";
import { startGatewayServer, type GatewayHandle } from "../gateway/server";

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
  const bus = new LogBus(new FileLogSink(paths.log));
  const logger = new BusHostLogger(bus);
  const registry = new ModuleRegistry(bus);
  const vaultModule = createSessionVaultModule();
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
  });

  const vaultCreds = await readVaultCredentials();

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
  let gatewayHandle: GatewayHandle | null = null;
  if (gateway.enabled) {
    // Lazily build (and memoize) the Drizzle handle the first time Postgres is
    // ready — the gateway starts before the cluster finishes booting.
    let hxDb: HxDb | null = null;
    const resolveHxDb = (): HxDb | null => {
      if (hxDb) return hxDb;
      const dsn = postgres.dsn();
      if (!dsn) return null;
      hxDb = createHxDb(dsn);
      return hxDb;
    };
    gatewayHandle = startGatewayServer({
      port: gateway.port,
      logger: bus.scopeFor("gateway"),
      signingKey: () => signingKeyStore.load(),
      store: () => vaultModule.getStore(),
      postgresReady: () => postgres.isReady(),
      db: resolveHxDb,
    });
  }

  try {
    await (dependencies.run ?? runHost)(runtime);
  } finally {
    gatewayHandle?.stop();
  }
}
