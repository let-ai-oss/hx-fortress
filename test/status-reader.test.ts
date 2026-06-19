import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileStatusReader } from "../src/status-reader";
import type { HostStatusSnapshot } from "../src/host/types";

describe("FileStatusReader", () => {
  let root: string;
  let statusPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-status-reader-"));
    statusPath = path.join(root, "runtime", "status.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns null when status.json does not exist", async () => {
    await expect(new FileStatusReader(statusPath).read()).resolves.toBeNull();
  });

  test("returns a valid snapshot and tolerates unknown fields", async () => {
    const value = { ...snapshot(), futureField: true };
    await writeStatus(value);

    await expect(new FileStatusReader(statusPath).read()).resolves.toEqual(
      snapshot(),
    );
  });

  test("rejects malformed JSON without exposing contents", async () => {
    await writeStatusText('{"credential":"secret"');

    await expect(new FileStatusReader(statusPath).read()).rejects.toThrow(
      "Invalid Fortress status: malformed JSON",
    );
  });

  test("validates the host pid", async () => {
    await writeStatus({
      ...snapshot(),
      host: { ...snapshot().host, pid: 0 },
    });

    await expect(new FileStatusReader(statusPath).read()).rejects.toThrow(
      "Invalid Fortress status: host.pid must be a positive integer",
    );
  });

  test("validates connection and module states", async () => {
    await writeStatus({
      ...snapshot(),
      connection: { state: "unknown" },
    });
    await expect(new FileStatusReader(statusPath).read()).rejects.toThrow(
      "Invalid Fortress status: connection.state is invalid",
    );

    await writeStatus({
      ...snapshot(),
      modules: [{ id: "Bad/Module", state: "running", error: null }],
    });
    await expect(new FileStatusReader(statusPath).read()).rejects.toThrow(
      "Invalid Fortress status: modules[0].id is invalid",
    );
  });

  async function writeStatus(value: unknown): Promise<void> {
    await writeStatusText(JSON.stringify(value));
  }

  async function writeStatusText(value: string): Promise<void> {
    await mkdir(path.dirname(statusPath), { recursive: true });
    await writeFile(statusPath, value);
  }
});

function snapshot(): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    host: {
      state: "running",
      pid: 1234,
      startedAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-15T10:00:01.000Z",
      error: null,
    },
    connection: {
      state: "connected",
      reason: null,
      message: null,
    },
    modules: [
      {
        id: "session_vault",
        state: "running",
        error: null,
      },
    ],
  };
}
