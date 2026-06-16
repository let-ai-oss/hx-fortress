import {
  FileCredentialStore,
  FilePendingEnrollmentStore,
  SUPPORTED_PROTOCOL_VERSION,
  WsCloudConnection,
} from "../cloud";
import type { WsCloudConnectionDeps } from "../cloud";
import packageJson from "../../package.json";
import createSessionVaultModule from "../modules/session-vault/module";
import { ensureDefaultConfig, FileConfigStore } from "./config";
import { FileLogSink } from "./file-log-sink";
import { BusHostLogger, LogBus } from "./logging";
import { ModuleRegistry } from "./module-registry";
import { fortressPaths } from "./paths";
import { runHost, type HostLifecycle } from "./run-host";
import { HostRuntime } from "./runtime";
import { FileStatusStore } from "./status";
import type { CloudConnection } from "./types";

export interface HostMainDependencies {
  root?: string;
  version?: string;
  createConnection?: (dependencies: WsCloudConnectionDeps) => CloudConnection;
  run?: (runtime: HostLifecycle) => Promise<void>;
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
  registry.register(createSessionVaultModule());
  const credentialStore = new FileCredentialStore(paths.credentials);
  const pendingEnrollmentStore = new FilePendingEnrollmentStore(paths.pendingEnrollment);

  const pendingEnrollment = await pendingEnrollmentStore.load().catch(() => null);

  if (pendingEnrollment) {
    await ensureDefaultConfig(paths, pendingEnrollment.cloudUrl);
  }

  const connectionDependencies: WsCloudConnectionDeps = {
    dispatcher: registry,
    credentialStore,
    identity: {
      version,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    },
    logger,
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

  await (dependencies.run ?? runHost)(runtime);
}
