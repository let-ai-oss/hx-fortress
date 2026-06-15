import type { ConnectionState, ModuleRuntimeStatus } from "./host/types";
import type { StatusReader } from "./status-reader";
import type { ServiceManager } from "./service/types";

type WriteLine = (line: string) => void;

interface FortressPathsView {
  log: string;
  serviceLog: string;
}

interface StartDependencies {
  manager: ServiceManager;
  executablePath: string;
  paths: FortressPathsView;
  writeLine: WriteLine;
}

interface StopDependencies {
  manager: ServiceManager;
  writeLine: WriteLine;
}

interface StatusDependencies {
  manager: ServiceManager;
  statusReader: StatusReader;
  writeLine: WriteLine;
}

export async function startFortress(
  dependencies: StartDependencies,
): Promise<void> {
  const before = await dependencies.manager.state();
  if (before.pid !== null) {
    dependencies.writeLine(
      `Fortress is running (${dependencies.manager.name}, pid ${before.pid}).`,
    );
    dependencies.writeLine(`logs: ${dependencies.paths.log}`);
    return;
  }

  await dependencies.manager.install({
    executablePath: dependencies.executablePath,
    serviceLogPath: dependencies.paths.serviceLog,
  });

  const after = await dependencies.manager.state();
  if (after.pid !== null) {
    dependencies.writeLine(
      `Fortress started (${dependencies.manager.name}, pid ${after.pid}).`,
    );
  } else {
    dependencies.writeLine(
      `Fortress loaded (${dependencies.manager.name}). It will start automatically.`,
    );
  }
  dependencies.writeLine(`logs: ${dependencies.paths.log}`);
  dependencies.writeLine("status: hx-fortress status");
}

export async function stopFortress(
  dependencies: StopDependencies,
): Promise<void> {
  const result = await dependencies.manager.stop();
  if (result.wasRunning) {
    dependencies.writeLine(
      `Fortress stopped (${dependencies.manager.name}). Run \`hx-fortress start\` to resume.`,
    );
    return;
  }
  dependencies.writeLine(
    "Fortress is not running - nothing to stop. Run `hx-fortress start` to start it.",
  );
}

export async function statusFortress(
  dependencies: StatusDependencies,
): Promise<void> {
  const serviceState = await dependencies.manager.state();
  if (serviceState.pid === null) {
    if (serviceState.loaded) {
      dependencies.writeLine(
        `Fortress:   loaded, not running (${dependencies.manager.name})`,
      );
    } else {
      dependencies.writeLine(
        "Fortress:   stopped - run `hx-fortress start` to resume",
      );
    }
    dependencies.writeLine("Connection: offline");
    dependencies.writeLine("Modules:    unavailable");
    return;
  }

  dependencies.writeLine(
    `Fortress:   running (${dependencies.manager.name}, pid ${serviceState.pid})`,
  );

  const snapshot = await dependencies.statusReader.read();
  if (!snapshot || snapshot.host.pid !== serviceState.pid) {
    dependencies.writeLine("Connection: starting");
    dependencies.writeLine("Modules:    unavailable");
    return;
  }

  dependencies.writeLine(
    `Connection: ${connectionLabel(snapshot.connection.state)}`,
  );
  writeModules(snapshot.modules, dependencies.writeLine);
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "enrolling";
    case "offline":
    case "closing":
      return "offline";
  }
}

function writeModules(
  modules: readonly ModuleRuntimeStatus[],
  writeLine: WriteLine,
): void {
  if (modules.length === 0) {
    writeLine("Modules:    none");
    return;
  }

  const sorted = [...modules].sort((left, right) => left.id.localeCompare(right.id));
  const width = Math.max(...sorted.map((module) => module.id.length));
  writeLine("Modules:");
  for (const module of sorted) {
    writeLine(`  ${module.id.padEnd(width)}  ${module.state}`);
  }
}
