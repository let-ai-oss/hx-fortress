import { readFile } from "node:fs/promises";

import { MODULE_ID_PATTERN } from "./host/paths";
import type {
  ConnectionState,
  HostState,
  HostStatusSnapshot,
  ModuleRuntimeStatus,
  ModuleState,
} from "./host/types";

export interface StatusReader {
  read(): Promise<HostStatusSnapshot | null>;
}

const HOST_STATES = new Set<HostState>([
  "stopped",
  "starting",
  "running",
  "draining",
  "failed",
]);
const CONNECTION_STATES = new Set<ConnectionState>([
  "offline",
  "connecting",
  "connected",
  "closing",
]);
const MODULE_STATES = new Set<ModuleState>([
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);

export class FileStatusReader implements StatusReader {
  constructor(private readonly statusPath: string) {}

  async read(): Promise<HostStatusSnapshot | null> {
    let contents: string;
    try {
      contents = await readFile(this.statusPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw invalidStatus("unable to read status.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidStatus("malformed JSON");
    }

    return parseStatus(value);
  }
}

function parseStatus(value: unknown): HostStatusSnapshot {
  try {
    if (!isRecord(value)) throw new Error("root must be an object");
    if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    if (!isRecord(value.host)) throw new Error("host must be an object");
    if (!HOST_STATES.has(value.host.state as HostState)) {
      throw new Error("host.state is invalid");
    }
    if (!Number.isInteger(value.host.pid) || Number(value.host.pid) <= 0) {
      throw new Error("host.pid must be a positive integer");
    }
    assertNullableString(value.host.startedAt, "host.startedAt");
    assertString(value.host.updatedAt, "host.updatedAt");
    assertNullableString(value.host.error, "host.error");

    if (!isRecord(value.connection)) {
      throw new Error("connection must be an object");
    }
    if (!CONNECTION_STATES.has(value.connection.state as ConnectionState)) {
      throw new Error("connection.state is invalid");
    }
    assertNullableString(value.connection.reason, "connection.reason");
    assertNullableString(value.connection.message, "connection.message");
    if (!Array.isArray(value.modules)) {
      throw new Error("modules must be an array");
    }

    const modules = value.modules.map(parseModule);
    return {
      schemaVersion: 1,
      host: {
        state: value.host.state as HostState,
        pid: Number(value.host.pid),
        startedAt: value.host.startedAt as string | null,
        updatedAt: value.host.updatedAt as string,
        error: value.host.error as string | null,
      },
      connection: {
        state: value.connection.state as ConnectionState,
        reason: value.connection.reason as string | null,
        message: value.connection.message as string | null,
      },
      modules,
    };
  } catch (error) {
    throw invalidStatus(errorMessage(error));
  }
}

function parseModule(value: unknown, index: number): ModuleRuntimeStatus {
  if (!isRecord(value)) throw new Error(`modules[${index}] must be an object`);
  if (typeof value.id !== "string" || !MODULE_ID_PATTERN.test(value.id)) {
    throw new Error(`modules[${index}].id is invalid`);
  }
  if (!MODULE_STATES.has(value.state as ModuleState)) {
    throw new Error(`modules[${index}].state is invalid`);
  }
  assertNullableString(value.error, `modules[${index}].error`);
  return {
    id: value.id,
    state: value.state as ModuleState,
    error: value.error as string | null,
  };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
}

function assertNullableString(
  value: unknown,
  field: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${field} must be a string or null`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function invalidStatus(reason: string): Error {
  return new Error(`Invalid Fortress status: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}
