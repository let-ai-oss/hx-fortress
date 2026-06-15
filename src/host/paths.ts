import os from "node:os";
import path from "node:path";

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertModuleId(moduleId: string): void {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
}

export function defaultFortressRoot(): string {
  return path.join(os.homedir(), ".let", "fortress");
}

export function fortressPaths(root = defaultFortressRoot()) {
  const modules = path.join(root, "modules");

  return {
    root,
    config: path.join(root, "config.json"),
    credentials: path.join(root, "identity", "credentials.json"),
    moduleInventory: path.join(modules, "inventory.json"),
    log: path.join(root, "logs", "fortress.jsonl"),
    status: path.join(root, "runtime", "status.json"),
    moduleConfig(moduleId: string): string {
      assertModuleId(moduleId);
      return path.join(modules, moduleId, "config.json");
    },
    moduleArtifacts(moduleId: string): string {
      assertModuleId(moduleId);
      return path.join(modules, moduleId, "artifacts");
    },
  };
}
