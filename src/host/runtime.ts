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
  /** Called once Postgres is up, before the connection opens. The console
   *  command fence belongs here: it calls the SECURITY DEFINER routines that
   *  role provisioning has just created, and it must run before anything polls
   *  the queue. A failure here is logged, not fatal — the daemon's job is to
   *  serve ingest, and a fence that could not run leaves rows untouched. */
  afterPostgres?: () => Promise<void>;
  /** Optional secret-free view of the session_vault storage config, folded into
   *  each status snapshot. Returns null when no vault is configured (Low). */
  vaultStatus?: () => Record<string, unknown> | null;
  /** The RESOLVED fortress root, published so a reader can prove it is looking
   *  at the same install. Omitted ⇒ the field is absent, which readers treat as
   *  a pre-console file rather than a mismatch. */
  root?: string;
  /** Status heartbeat cadence. A reader distinguishes "running" from "the
   *  process is gone" by the age of the last write, so the file has to be
   *  rewritten even when nothing changed. */
  heartbeatMs?: number;
}

/** Default status heartbeat cadence. */
export const STATUS_HEARTBEAT_MS = 5_000;

export class HostRuntime {
  private readonly clock: Clock;
  private readonly pid: number;
  private state: HostState = "stopped";
  private startedAt: string | null = null;
  private error: string | null = null;
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private updatedAt: string | null = null;

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
      await this.dependencies.afterPostgres?.();
      await this.dependencies.connection.open(config);
      await this.dependencies.afterConnect?.();
      await this.dependencies.supervisor.startAll(config.modules.enabled);

      this.state = "running";
      await this.writeStatus(this.clock().toISOString());
      this.startHeartbeat();
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

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    const every = this.dependencies.heartbeatMs ?? STATUS_HEARTBEAT_MS;
    if (every <= 0) return;
    this.heartbeat = setInterval(() => {
      // Only the write timestamp moves; `updatedAt` still marks the last real
      // state change, so a reader can tell a fresh heartbeat from a transition.
      const now = this.clock().toISOString();
      void this.writeStatus(this.updatedAt ?? now, now);
    }, every);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async performStop(): Promise<void> {
    this.stopHeartbeat();
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

  private async writeStatus(updatedAt: string, writtenAt: string = updatedAt): Promise<void> {
    // Secret-free vault view (Low) — only included when a vault is configured, so
    // a snapshot without one keeps its exact prior shape.
    const vault = this.dependencies.vaultStatus?.() ?? null;
    this.updatedAt = updatedAt;
    const snapshot: HostStatusSnapshot = {
      schemaVersion: 1,
      host: {
        state: this.state,
        pid: this.pid,
        startedAt: this.startedAt,
        updatedAt,
        error: this.error,
        writtenAt,
        ...(this.dependencies.root ? { root: this.dependencies.root } : {}),
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
