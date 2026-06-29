import os from "node:os";
import path from "node:path";

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertModuleId(moduleId: string): void {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
}

export function defaultFortressRoot(): string {
  // FORTRESS_ROOT lets a container mount all persisted state (config.json,
  // credentials.json, signing-key) on a single volume; otherwise default to the
  // operator's home directory.
  const fromEnv = process.env.FORTRESS_ROOT?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".let", "fortress");
}

export function fortressPaths(root = defaultFortressRoot()) {
  const modules = path.join(root, "modules");
  const postgres = path.join(root, "postgres");

  return {
    root,
    config: path.join(root, "config.json"),
    postgresRoot: postgres,
    postgresCache: path.join(postgres, "cache"),
    postgresSocket: path.join(postgres, "socket"),
    defaultPgData: path.join(root, "pgdata"),
    postgresVersionDir(version: string): string {
      return path.join(postgres, version);
    },
    credentials: path.join(root, "identity", "credentials.json"),
    pendingEnrollment: path.join(root, "identity", "pending-enrollment.json"),
    signingKey: path.join(root, "identity", "signing-key"),
    moduleInventory: path.join(modules, "inventory.json"),
    log: path.join(root, "logs", "fortress.jsonl"),
    serviceLog: path.join(root, "logs", "service.log"),
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
