import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AuditSpool, readSpool } from "../src/console/audit-spool";
import { parseCommandOutcomes } from "../src/ui/corroboration";
import { MetricsRegistry, writeMetrics } from "../src/console/metrics";
import {
  drainParkedArtifacts,
  parkArtifact,
  ParkReplayLatch,
  readParkedArtifacts,
} from "../src/console/artifact-replay";
import type { SessionKey } from "../src/modules/session-vault/store/types";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const KEY: SessionKey = { userId: "u", family: "f", sessionId: "s" };

describe("the audit spool", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-spool-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes an append-only intent/outcome PAIR, never an in-place amend", async () => {
    const spool = new AuditSpool({ dir: path.join(root, "audit"), fileId: "f1", clock: () => NOW });
    const intent = await spool.intent("rotate_credentials", { sessionRef: "cmd-1" });
    await spool.outcome(intent, "done");
    const records = await readSpool(path.join(root, "audit"));
    expect(records.map((r) => r.kind)).toEqual(["intent", "outcome"]);
    expect(records[0].seq).toBe(1);
    expect(records[1].refSeq).toBe(1);
    // A crash between the two is itself evidence — the intent stays on disk
    // with no outcome answering it.
    expect(records[1].seq).toBe(2);
  });

  test("is 0600 in a 0700 directory — the medium a SQL adversary cannot reach", async () => {
    const dir = path.join(root, "audit");
    const spool = new AuditSpool({ dir, fileId: "f1" });
    await spool.intent("self_test");
    expect((await stat(spool.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("daemon-produced records are marked system origin", async () => {
    // The origin follows the WRITER rather than a field each caller remembers to
    // set: a record whose origin says "console" for work the daemon did is a
    // record that names the wrong actor.
    const spool = new AuditSpool({ dir: path.join(root, "audit"), fileId: "f1", writer: "daemon" });
    const intent = await spool.intent("run_checkup");
    // The daemon role holds NO admin_audit INSERT, so these reach Postgres
    // only through the drain.
    expect(intent.origin).toBe("system");
  });

  test("the drain key is (file, seq), so a re-read is idempotent", async () => {
    const dir = path.join(root, "audit");
    const a = new AuditSpool({ dir, fileId: "aaa" });
    const b = new AuditSpool({ dir, fileId: "bbb" });
    await a.intent("x");
    await b.intent("y");
    const records = await readSpool(dir);
    const keys = records.map((r) => `${r.fileId}:${r.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("an intent alone corroborates nothing - only a matching outcome does", async () => {
    // There is no id-only matcher any more, deliberately: under D7 the daemon
    // writes its outcome record even when its complete_command call was refused
    // because the row was already terminal, so "an outcome record exists for
    // this id" would render an attacker's payload as corroborated success. The
    // one predicate compares status AND payload digest.
    const dir = path.join(root, "audit");
    const spool = new AuditSpool({ dir, fileId: "f1" });
    const intent = await spool.intent("console.command.outcome", { sessionRef: "cmd-9" });
    const parse = async (): Promise<unknown[]> =>
      parseCommandOutcomes(
        (await readSpool(dir)).map((r) => ({
          action: r.action,
          kind: r.kind,
          sessionRef: r.sessionRef,
          params: r.params,
        })),
      );
    expect(await parse()).toEqual([]);
    await spool.outcome(intent, "done");
    // Still nothing: an outcome with no digest in its params is not a comparable
    // record, which is what keeps a pre-digest build from corroborating anything.
    expect(await parse()).toEqual([]);
  });
});

describe("metrics.json", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-metrics-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a source that is switched OFF publishes nothing, not a zero", () => {
    // A zero and "the direct gateway is not enabled here" read identically on
    // a dashboard and mean opposite things.
    const registry = new MetricsRegistry();
    registry.registerGauge("gateway.enabled", () => null);
    registry.registerGauge("store.in_flight_writes", () => 0);
    const snapshot = registry.snapshot(NOW);
    expect(snapshot.gauges).toEqual({ "store.in_flight_writes": 0 });
  });

  test("a declared counter is present at zero", () => {
    const registry = new MetricsRegistry();
    registry.declareCounter("ingest.paused_refusals");
    expect(registry.snapshot(NOW).counters["ingest.paused_refusals"]).toBe(0);
    registry.increment("ingest.paused_refusals", 3);
    expect(registry.snapshot(NOW).counters["ingest.paused_refusals"]).toBe(3);
  });

  test("a throwing gauge is omitted rather than crashing the publish", () => {
    const registry = new MetricsRegistry();
    registry.registerGauge("bad", () => {
      throw new Error("nope");
    });
    expect(registry.snapshot(NOW).gauges).toEqual({});
  });

  test("is written 0600 with its own write timestamp", async () => {
    const file = path.join(root, "runtime", "metrics.json");
    const registry = new MetricsRegistry();
    registry.increment("x");
    await writeMetrics(file, registry.snapshot(NOW));
    const parsed = JSON.parse(await readFile(file, "utf8")) as { writtenAt: string; counters: Record<string, number> };
    expect(parsed.writtenAt).toBe(NOW.toISOString());
    expect(parsed.counters.x).toBe(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("the artifact replay park", () => {
  let root = "";
  let file = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-park-"));
    file = path.join(root, "runtime", "artifact-replay.jsonl");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a refused deferred write is parked, then replayed after resume", async () => {
    await parkArtifact(file, { key: KEY, name: "session.json", text: "{}", parkedAt: NOW.toISOString() });
    expect((await readParkedArtifacts(file)).length).toBe(1);

    const written: string[] = [];
    const result = await drainParkedArtifacts(file, async (entry) => {
      written.push(entry.name);
    });
    expect(result).toEqual({ replayed: 1, failed: 0 });
    expect(written).toEqual(["session.json"]);
    expect(await readParkedArtifacts(file)).toEqual([]);
  });

  test("a replay that fails again is re-parked, never dropped", async () => {
    await parkArtifact(file, { key: KEY, name: "session.json", text: "{}", parkedAt: NOW.toISOString() });
    const result = await drainParkedArtifacts(file, async () => {
      throw new Error("still down");
    });
    expect(result).toEqual({ replayed: 0, failed: 1 });
    expect((await readParkedArtifacts(file)).length).toBe(1);
  });

  test("draining an empty park is a no-op", async () => {
    expect(await drainParkedArtifacts(file, async () => {})).toEqual({ replayed: 0, failed: 0 });
  });

  test("a pause that lapsed on its own deadline still owes a replay", () => {
    const latch = new ParkReplayLatch();
    latch.settle(0);
    expect(latch.due(false)).toBe(false);
    // Armed. Nothing to drain while the gate is shut — the writes are still
    // being refused.
    expect(latch.due(true)).toBe(false);
    // The deadline passes with nobody resuming anything. There is no edge here:
    // the cached pause simply answers "open" the next time it is asked, which is
    // why a paused→open comparison never fired and the park sat there forever.
    expect(latch.due(false)).toBe(true);
  });

  test("a daemon that restarted mid-pause owes one before it observes anything", () => {
    expect(new ParkReplayLatch().due(false)).toBe(true);
  });

  test("entries that failed again stay owed", () => {
    const latch = new ParkReplayLatch();
    latch.settle(1);
    expect(latch.due(false)).toBe(true);
    latch.settle(0);
    expect(latch.due(false)).toBe(false);
  });

  test("a write parked DURING the drain is not truncated away", async () => {
    await parkArtifact(file, { key: KEY, name: "a.json", text: "{}", parkedAt: NOW.toISOString() });
    await drainParkedArtifacts(file, async () => {
      // Arrives while the previous batch is being replayed — the file was
      // rotated aside first, so this lands in a fresh one.
      await parkArtifact(file, { key: KEY, name: "b.json", text: "{}", parkedAt: NOW.toISOString() });
    });
    expect((await readParkedArtifacts(file)).map((e) => e.name)).toEqual(["b.json"]);
  });
});
