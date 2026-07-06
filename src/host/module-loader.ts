import type { InstalledModuleRecord, ModuleInventoryStore } from "./module-inventory";
import { SIGNATURE_ENFORCE, verifyDetachedSignature } from "./trust/verify";
import type {
  HostLogger,
  LoadableRegistry,
  Module,
  ModuleInstallParams,
  ModuleLifecycleHandler,
} from "./types";

export interface ModuleLoaderDeps {
  registry: LoadableRegistry;
  inventory: ModuleInventoryStore;
  fetchArtifact: (url: string) => Promise<Uint8Array>;
  importModule: (artifactPath: string) => Promise<() => Module>;
  saveArtifact: (artifactPath: string, data: Uint8Array) => Promise<void>;
  deleteArtifact: (artifactPath: string) => Promise<void>;
  artifactPathFor: (moduleId: string, version: string) => string;
  logger: HostLogger;
}

export class ModuleLoader implements ModuleLifecycleHandler {
  constructor(private readonly deps: ModuleLoaderDeps) {}

  async loadFromInventory(): Promise<void> {
    const records = await this.deps.inventory.load();
    for (const record of records) {
      try {
        const factory = await this.deps.importModule(record.artifactPath);
        const module = factory();
        this.deps.registry.register(module);
        await this.deps.registry.startOne(module.id);
      } catch (error) {
        this.deps.logger.error(
          `Failed to load installed module from inventory: ${record.moduleId}`,
          error,
        );
      }
    }
  }

  async install(params: ModuleInstallParams): Promise<void> {
    const { moduleId, version, artifactUrl, checksum, signature } = params;
    const artifactPath = this.deps.artifactPathFor(moduleId, version);

    const data = await this.deps.fetchArtifact(artifactUrl);
    // Authenticity is the detached Ed25519 signature verified against the baked
    // trust anchors — NOT the hub-supplied `checksum` (integrity only; a
    // compromised hub could serve a matching hash for a trojaned artifact). A
    // present signature must verify; an absent one fails closed only when
    // enforcing (Release A = verify-if-present).
    if (signature) {
      await verifyDetachedSignature(data, signature);
    } else if (SIGNATURE_ENFORCE) {
      throw new Error(
        `Module ${moduleId} has no signature and signature enforcement is enabled`,
      );
    }

    await this.deps.saveArtifact(artifactPath, data);

    let module: Module;
    try {
      const factory = await this.deps.importModule(artifactPath);
      module = factory();
    } catch (error) {
      try {
        await this.deps.deleteArtifact(artifactPath);
      } catch (deleteError) {
        this.deps.logger.error(
          `Failed to clean up artifact after import error: ${artifactPath}`,
          deleteError,
        );
      }
      throw error;
    }

    if (this.deps.registry.has(moduleId)) {
      await this.deps.registry.stopOne(moduleId);
      this.deps.registry.unregister(moduleId);
    }

    this.deps.registry.register(module);
    await this.deps.registry.startOne(moduleId);

    const record: InstalledModuleRecord = {
      moduleId,
      version,
      artifactPath,
      checksum,
      installedAt: new Date().toISOString(),
    };
    await this.deps.inventory.add(record);
  }

  async uninstall(moduleId: string): Promise<void> {
    const records = await this.deps.inventory.load();
    const record = records.find((r) => r.moduleId === moduleId);
    if (!record) {
      throw new Error(`Module not installed: ${moduleId}`);
    }

    if (this.deps.registry.has(moduleId)) {
      const module = this.deps.registry.get(moduleId);
      try {
        await this.deps.registry.stopOne(moduleId);
      } catch (error) {
        this.deps.logger.error(`Failed to stop module during uninstall: ${moduleId}`, error);
      }
      try {
        await module?.uninstall?.();
      } catch (error) {
        this.deps.logger.error(`Failed to run uninstall hook for module: ${moduleId}`, error);
      }
      this.deps.registry.unregister(moduleId);
    }

    try {
      await this.deps.deleteArtifact(record.artifactPath);
    } catch (error) {
      this.deps.logger.error(
        `Failed to delete artifact during uninstall: ${record.artifactPath}`,
        error,
      );
    }

    await this.deps.inventory.remove(moduleId);
  }
}
