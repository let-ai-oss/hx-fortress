import type {
  Clock,
  CloudConnection,
  ConfigStore,
  HostLogger,
  HostState,
  HostStatusSnapshot,
  ModuleSupervisor,
  PostgresProvider,
  StatusStore,
} from "./types";

export interface HostRuntimeDependencies {
  configStore: ConfigStore;
  connection: CloudConnection;
  postgres: PostgresProvider;
  supervisor: ModuleSupervisor;
  statusStore: StatusStore;
  logger: HostLogger;
  clock?: Clock;
  pid?: number;
  /** Called after the cloud connection opens and before modules start. Use to
   *  propagate the Fortress identity into the module supervisor. */
  afterConnect?: () => Promise<void>;
  /** Optional secret-free view of the session_vault storage config, folded into
   *  each status snapshot. Returns null when no vault is configured (Low). */
  vaultStatus?: () => Record<string, unknown> | null;
}

export class HostRuntime {
  private readonly clock: Clock;
  private readonly pid: number;
  private state: HostState = "stopped";
  private startedAt: string | null = null;
  private error: string | null = null;
  private started = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: HostRuntimeDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.pid = dependencies.pid ?? process.pid;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Host runtime has already started");
    this.started = true;
    this.state = "starting";
    const startedAt = this.clock().toISOString();
    this.startedAt = startedAt;
    await this.writeStatus(startedAt);

    try {
      const config = await this.dependencies.configStore.load();
      await this.dependencies.postgres.start();
      await this.dependencies.connection.open(config);
      await this.dependencies.afterConnect?.();
      await this.dependencies.supervisor.startAll(config.modules.enabled);

      this.state = "running";
      await this.writeStatus(this.clock().toISOString());
    } catch (error) {
      await this.closeConnectionAfterFailedStart();
      this.state = "failed";
      this.error = errorMessage(error);
      await this.writeStatus(this.clock().toISOString());
      throw error;
    }
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.performStop();
    }
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.state = "draining";
    await this.writeStatus(this.clock().toISOString());

    try {
      await this.dependencies.supervisor.stopAll();
    } catch (error) {
      this.error = errorMessage(error);
      this.dependencies.logger.error("Failed to stop Fortress modules", error);
    }

    if (this.dependencies.connection.state() !== "offline") {
      try {
        await this.dependencies.connection.close();
      } catch (error) {
        this.error = errorMessage(error);
        this.dependencies.logger.error(
          "Failed to close Fortress cloud connection",
          error,
        );
      }
    }

    try {
      await this.dependencies.postgres.stop();
    } catch (error) {
      this.error = errorMessage(error);
      this.dependencies.logger.error("Failed to stop Fortress Postgres", error);
    }

    this.state = "stopped";
    await this.writeStatus(this.clock().toISOString());
  }

  private async writeStatus(updatedAt: string): Promise<void> {
    // Secret-free vault view (Low) — only included when a vault is configured, so
    // a snapshot without one keeps its exact prior shape.
    const vault = this.dependencies.vaultStatus?.() ?? null;
    const snapshot: HostStatusSnapshot = {
      schemaVersion: 1,
      host: {
        state: this.state,
        pid: this.pid,
        startedAt: this.startedAt,
        updatedAt,
        error: this.error,
      },
      connection: this.dependencies.connection.status(),
      postgres: this.dependencies.postgres.status(),
      modules: this.dependencies.supervisor.snapshot().map((module) => ({ ...module })),
      ...(vault ? { vault } : {}),
    };
    try {
      await this.dependencies.statusStore.write(snapshot);
    } catch (error) {
      this.dependencies.logger.error(
        "Failed to write Fortress runtime status",
        error,
      );
    }
  }

  private async closeConnectionAfterFailedStart(): Promise<void> {
    if (this.dependencies.connection.state() === "offline") return;
    try {
      await this.dependencies.connection.close();
    } catch (error) {
      this.dependencies.logger.error(
        "Failed to close Fortress cloud connection after startup error",
        error,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
