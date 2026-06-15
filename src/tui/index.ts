import { createTuiApp } from "./app";
import { startFortress, stopFortress } from "../cli-lifecycle";
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

type FortressPaths = ReturnType<typeof fortressPaths>;
type TuiServiceStateReader = Pick<ServiceManager, "state">;
type TuiLifecycleManager = Pick<ServiceManager, "install" | "name" | "state" | "stop">;

interface TuiModelDependencies {
  serviceStateReader?: TuiServiceStateReader;
  statusReader?: Pick<StatusReader, "read">;
  inventoryStore?: Pick<ModuleInventoryStore, "load">;
  updateStatusProvider?: Pick<UpdateStatusProvider, "load">;
  paths?: FortressPaths;
}

interface TuiActionDependencies {
  serviceManager?: TuiLifecycleManager;
  executablePath?: string;
  writeLine?: (line: string) => void;
}

interface TuiDependencies extends TuiModelDependencies, TuiActionDependencies {
  runTerminalRenderer?: typeof runTerminalRenderer;
}

export async function runFortressTui(
  options: RunTerminalRendererOptions = {},
  dependencies: TuiDependencies = {},
): Promise<number> {
  const paths = dependencies.paths ?? fortressPaths();
  const serviceManager = dependencies.serviceManager ?? getServiceManager();
  const serviceStateReader =
    dependencies.serviceStateReader ?? dependencies.serviceManager ?? serviceManager;
  const writeLine = dependencies.writeLine ?? (() => {});
  const model = await loadMainScreenModel({
    serviceStateReader,
    statusReader: dependencies.statusReader,
    inventoryStore: dependencies.inventoryStore,
    updateStatusProvider: dependencies.updateStatusProvider,
    paths,
  });
  const modelDeps = {
    serviceStateReader,
    statusReader: dependencies.statusReader,
    inventoryStore: dependencies.inventoryStore,
    updateStatusProvider: dependencies.updateStatusProvider,
    paths,
  };
  const app = createTuiApp({
    model,
    reloadModel: () => loadMainScreenModel(modelDeps),
    actions: {
      start: async () =>
        await startFortress({
          manager: serviceManager,
          executablePath: dependencies.executablePath ?? process.execPath,
          paths,
          writeLine,
        }),
      stop: async () =>
        await stopFortress({
          manager: serviceManager,
          writeLine,
        }),
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
  dependencies: TuiModelDependencies & { paths: FortressPaths },
) {
  const serviceStateReader =
    dependencies.serviceStateReader ?? getServiceManager();
  const inventory =
    dependencies.inventoryStore ?? new FsModuleInventoryStore(dependencies.paths);
  const statusReader =
    dependencies.statusReader ?? new FileStatusReader(dependencies.paths.status);
  const updates =
    dependencies.updateStatusProvider ?? new NoUpdateStatusProvider();

  const [service, snapshot, installedModules, updateMap] = await Promise.all([
    loadServiceState(serviceStateReader),
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
