import { createTuiApp } from "./app";
import { FsModuleInventoryStore } from "../host/module-inventory";
import { fortressPaths } from "../host/paths";
import { FileStatusReader } from "../status-reader";
import { getServiceManager, type ServiceState } from "../service";
import { buildMainScreenModel } from "./model";
import { runTerminalRenderer, type RunTerminalRendererOptions } from "./terminal";
import {
  NoUpdateStatusProvider,
  type UpdateStatusProvider,
} from "./update-status";
import type { HostStatusSnapshot } from "../host/types";
import type {
  InstalledModuleRecord,
  ModuleInventoryStore,
} from "../host/module-inventory";
import type { ModuleUpdateMap } from "./types";
import type { StatusReader } from "../status-reader";
import type { ServiceManager } from "../service";

interface TuiDependencies {
  serviceManager?: Pick<ServiceManager, "state">;
  statusReader?: Pick<StatusReader, "read">;
  inventoryStore?: Pick<ModuleInventoryStore, "load">;
  updateStatusProvider?: Pick<UpdateStatusProvider, "load">;
  runTerminalRenderer?: typeof runTerminalRenderer;
}

export async function runFortressTui(
  options: RunTerminalRendererOptions = {},
  dependencies: TuiDependencies = {},
): Promise<number> {
  const model = await loadMainScreenModel(dependencies);
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

  return await (dependencies.runTerminalRenderer ?? runTerminalRenderer)(
    app,
    options,
  );
}

async function loadMainScreenModel(
  dependencies: TuiDependencies,
) {
  const paths = fortressPaths();
  const serviceManager = dependencies.serviceManager ?? getServiceManager();
  const inventory =
    dependencies.inventoryStore ?? new FsModuleInventoryStore(paths);
  const statusReader =
    dependencies.statusReader ?? new FileStatusReader(paths.status);
  const updates =
    dependencies.updateStatusProvider ?? new NoUpdateStatusProvider();

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
  serviceManager: Pick<ServiceManager, "state">,
): Promise<ServiceState> {
  return await serviceManager.state();
}

async function loadSnapshot(
  statusReader: Pick<StatusReader, "read">,
): Promise<HostStatusSnapshot | null> {
  return await statusReader.read();
}

async function loadInstalledModules(
  inventory: Pick<ModuleInventoryStore, "load">,
): Promise<InstalledModuleRecord[]> {
  try {
    return await inventory.load();
  } catch {
    return [];
  }
}

async function loadUpdates(
  updates: Pick<UpdateStatusProvider, "load">,
): Promise<ModuleUpdateMap> {
  try {
    return await updates.load();
  } catch {
    return {};
  }
}
