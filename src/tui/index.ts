import { createTuiApp } from "./app";
import { FsModuleInventoryStore } from "../host/module-inventory";
import { fortressPaths } from "../host/paths";
import { FileStatusReader } from "../status-reader";
import { getServiceManager, type ServiceState } from "../service";
import { buildMainScreenModel } from "./model";
import { runTerminalRenderer, type RunTerminalRendererOptions } from "./terminal";
import { NoUpdateStatusProvider } from "./update-status";
import type { HostStatusSnapshot } from "../host/types";
import type { InstalledModuleRecord } from "../host/module-inventory";
import type { ModuleUpdateMap } from "./types";

export async function runFortressTui(
  options: RunTerminalRendererOptions = {},
): Promise<number> {
  const model = await loadMainScreenModel();
  const app = createTuiApp({
    model,
    actions: {
      start: async () => {
        throw new Error("start is not wired in this build yet");
      },
      stop: async () => {
        throw new Error("stop is not wired in this build yet");
      },
      update: async (version) => {
        throw new Error(`update ${version} is not wired in this build yet`);
      },
    },
  });

  return await runTerminalRenderer(app, options);
}

async function loadMainScreenModel() {
  const paths = fortressPaths();
  const serviceManager = getServiceManager();
  const inventory = new FsModuleInventoryStore(paths);
  const statusReader = new FileStatusReader(paths.status);
  const updates = new NoUpdateStatusProvider();

  const [service, snapshot, installedModules, updateMap] = await Promise.all([
    loadServiceState(serviceManager),
    loadSnapshot(statusReader),
    loadInstalledModules(inventory),
    loadUpdates(updates),
  ]);

  return buildMainScreenModel({
    service,
    snapshot,
    installedModules,
    updates: updateMap,
  });
}

async function loadServiceState(
  serviceManager: ReturnType<typeof getServiceManager>,
): Promise<ServiceState> {
  try {
    return await serviceManager.state();
  } catch {
    return { loaded: false, pid: null };
  }
}

async function loadSnapshot(
  statusReader: FileStatusReader,
): Promise<HostStatusSnapshot | null> {
  try {
    return await statusReader.read();
  } catch {
    return null;
  }
}

async function loadInstalledModules(
  inventory: FsModuleInventoryStore,
): Promise<InstalledModuleRecord[]> {
  try {
    return await inventory.load();
  } catch {
    return [];
  }
}

async function loadUpdates(
  updates: NoUpdateStatusProvider,
): Promise<ModuleUpdateMap> {
  try {
    return await updates.load();
  } catch {
    return {};
  }
}
