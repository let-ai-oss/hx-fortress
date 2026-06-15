import { FileCredentialStore, SUPPORTED_PROTOCOL_VERSION, WsCloudConnection } from "../cloud";
import type { WsCloudConnectionDeps } from "../cloud";
import packageJson from "../../package.json";
import { FileConfigStore } from "./config";
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
  const connectionDependencies: WsCloudConnectionDeps = {
    dispatcher: registry,
    credentialStore: new FileCredentialStore(paths.credentials),
    identity: {
      version,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    },
    logger,
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
  });

  await (dependencies.run ?? runHost)(runtime);
}
