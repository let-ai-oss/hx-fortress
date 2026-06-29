import type { MsgData, MsgReply } from "../protocol";

export interface MessageDispatcher {
  dispatch(data: MsgData): Promise<MsgReply | undefined>;
}

export interface FortressPostgresConfig {
  version?: string;
  binariesUrl?: string;
  dataDir?: string;
  port?: number;
  externalUrl?: string;
}

export interface FortressConfig {
  schemaVersion: 1;
  cloud: {
    url: string;
  };
  gateway: {
    publicUrl: string;
  };
  modules: {
    enabled: string[];
  };
  postgres?: FortressPostgresConfig;
}

export interface ConfigStore {
  load(): Promise<FortressConfig>;
}

export type ConnectionState = "offline" | "connecting" | "connected" | "closing";

export interface ConnectionStatusSnapshot {
  state: ConnectionState;
  reason: string | null;
  message: string | null;
}

export type ModuleState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface ModuleRuntimeStatus {
  id: string;
  state: ModuleState;
  error: string | null;
}

export type HostState = "stopped" | "starting" | "running" | "draining" | "failed";

export interface HostStatusSnapshot {
  schemaVersion: 1;
  host: {
    state: HostState;
    pid: number;
    startedAt: string | null;
    updatedAt: string;
    error: string | null;
  };
  connection: {
    state: ConnectionState;
    reason: string | null;
    message: string | null;
  };
  postgres: {
    phase: PostgresPhase;
    reason: string | null;
  };
  modules: ModuleRuntimeStatus[];
}

export interface StatusStore {
  write(snapshot: HostStatusSnapshot): Promise<void>;
}

export type ModuleStartResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

export type ModuleStopResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

/** Payload for the fortress→cloud realtime invalidation (MC-2415), carried up
 *  the tunnel after an hx ingest so the cloud can refresh the user's live
 *  "my sessions" queries. */
export interface HxIngestNotification {
  /** Cloud user id (hx_users.external_id) whose sessions changed. */
  userExternalId: string;
  /** Org the session is attributed to (cloud id), or null for personal. */
  orgExternalId: string | null;
}

export interface CloudConnection {
  state(): ConnectionState;
  status(): ConnectionStatusSnapshot;
  open(config: FortressConfig): Promise<void>;
  close(): Promise<void>;
  /** Best-effort push of an hx ingest notification to the cloud. No-op when the
   *  tunnel isn't currently open. */
  notifyIngest(evt: HxIngestNotification): void;
}

export interface ModuleSupervisor {
  startAll(moduleIds: readonly string[]): Promise<readonly ModuleStartResult[]>;
  stopAll(): Promise<readonly ModuleStopResult[]>;
  snapshot(): readonly ModuleRuntimeStatus[];
}

export interface HostLogger {
  error(message: string, error?: unknown): void;
}

export type Clock = () => Date;

export interface LogRecord {
  ts: string;
  module: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface ScopedLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** The enrolled Fortress identity handed down to modules after the cloud
 *  connection authenticates. Contains the org/fortress binding issued by the
 *  hub at enrollment time. */
export interface EnrolledIdentity {
  orgId: string;
  fortressId: string;
  credential: string;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly logger: ScopedLogger;
  /** Populated once the Fortress cloud connection has authenticated. Null if
   *  the host is not yet enrolled or identity could not be loaded. */
  readonly fortressIdentity: EnrolledIdentity | null;
}

export interface Module {
  readonly id: string;
  init?(context: ModuleContext): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  update?(): Promise<void> | void;
  uninstall?(): Promise<void> | void;
  onMessage(data: MsgData): Promise<MsgReply | void> | MsgReply | void;
}

export interface LoadableRegistry {
  register(module: Module): void;
  has(id: string): boolean;
  get(id: string): Module | undefined;
  startOne(id: string): Promise<ModuleStartResult>;
  stopOne(id: string): Promise<ModuleStopResult>;
  unregister(id: string): void;
}

export interface ModuleInstallParams {
  moduleId: string;
  version: string;
  artifactUrl: string;
  checksum: string;
}

export interface ModuleLifecycleHandler {
  install(params: ModuleInstallParams): Promise<void>;
  uninstall(moduleId: string): Promise<void>;
}

export type PostgresPhase = "acquiring" | "initializing" | "ready" | "failed";

export interface PostgresStatusSnapshot {
  phase: PostgresPhase;
  reason: string | null;
}

export interface PostgresProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): PostgresStatusSnapshot;
  isReady(): boolean;
  dsn(): string | null;
}
