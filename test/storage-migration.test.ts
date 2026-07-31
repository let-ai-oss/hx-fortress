// Moving a fortress's objects to another bucket: what the engine does, in what
// order, and what it refuses to do.
//
// The stores here are in memory because the interesting part is never the copy —
// it is the arm→swap window, the barrier, the fence, and the two things a
// migration must never do: lose a write, or delete the bucket it came from.

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  FENCE_MARGIN_MS,
  MIGRATION_ARTIFACTS,
  copySession,
  runStorageMigration,
  sessionRef,
  type MigrationDeps,
  type MigrationEvent,
} from "../src/console/migration";
import {
  MIGRATION_COMMANDS,
  isMigrationCommand,
  runMigrationCommand,
  type MigrationRunnerDeps,
} from "../src/console/migration-runner";
import { IngestQuiesce } from "../src/console/pause-gate";
import { MIGRATION_PHASES, validateCommandParams } from "../src/console/command-params";
import { createCommandExecutors } from "../src/console/executors";
import { envManagedRefusal } from "../src/console/rotation";
import { OFFERED_COMMAND_KINDS } from "../src/ui/mutate-routes";
import { CONSOLE_TABLES, UI_TABLE_GRANTS } from "../src/host/postgres/console-plane";
import { expectedPrivilegeMatrix } from "../src/host/postgres/privilege-matrix";
import { migrations } from "../src/host/postgres/migrations/manifest";
import {
  credentialsPath,
  readVaultCredentials,
  writeVaultCredentials,
  type VaultCredentials,
} from "../src/modules/session-vault/credentials";
import type { HxDb } from "../src/host/postgres/db";
import type { ScopedLogger } from "../src/host/types";
import type {
  ComposeResult,
  DeleteSessionResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
  StagingUploadOptions,
} from "../src/modules/session-vault/store/types";
import type { ServiceManager } from "../src/service";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const LOGGER: ScopedLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;

function key(n: number): SessionKey {
  return { userId: "u1", family: "claude-code", sessionId: `s${n}` };
}

// ── an in-memory bucket ──────────────────────────────────────────────────────

class MemoryStore implements SessionStore {
  readonly canonical = new Map<string, string>();
  readonly artifacts = new Map<string, string>();
  /** Every destructive call, so a test can assert the SET is empty. */
  readonly deletes: string[] = [];
  selfTests = 0;
  /** Return different bytes than were written — a bucket that accepted and
   *  stored something else. */
  corrupt: string | null = null;
  /** Throw on the write of this session, once. */
  failOn: string | null = null;

  constructor(readonly name: string) {}

  private ref(k: SessionKey): string {
    return sessionRef(k);
  }
  signStagingUpload(_k: SessionKey, _c: string, opts?: StagingUploadOptions): Promise<SignedUpload> {
    return Promise.resolve({
      url: "https://example/put",
      objectName: "o",
      expiresAt: new Date(NOW + (opts?.ttlSeconds ?? 900) * 1000).toISOString(),
    });
  }
  readChunkText(): Promise<string> {
    return Promise.resolve("");
  }
  appendChunkToCanonical(): Promise<ComposeResult> {
    return Promise.resolve({ totalBytes: 0, componentCount: 0 });
  }
  statCanonical(k: SessionKey): Promise<number | null> {
    const text = this.canonical.get(this.ref(k));
    return Promise.resolve(text === undefined ? null : Buffer.byteLength(text));
  }
  signCanonicalDownload(): Promise<SignedDownload> {
    return Promise.resolve({ url: "https://example/get", expiresAt: "x" });
  }
  readCanonicalText(k: SessionKey): Promise<string> {
    const text = this.canonical.get(this.ref(k));
    if (text === undefined) return Promise.reject(new Error(`no canonical for ${this.ref(k)}`));
    return Promise.resolve(this.corrupt !== null && this.name !== "source" ? this.corrupt : text);
  }
  writeCanonicalText(k: SessionKey, text: string): Promise<void> {
    if (this.failOn === this.ref(k)) {
      this.failOn = null;
      return Promise.reject(new Error(`the target refused ${this.ref(k)}`));
    }
    this.canonical.set(this.ref(k), text);
    return Promise.resolve();
  }
  writeArtifact(k: SessionKey, name: string, text: string): Promise<void> {
    this.artifacts.set(`${this.ref(k)}/${name}`, text);
    return Promise.resolve();
  }
  readArtifactText(k: SessionKey, name: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.get(`${this.ref(k)}/${name}`) ?? null);
  }
  listSessionMetadata(): Promise<SessionMetadata[]> {
    return Promise.resolve([]);
  }
  listAllCanonicalKeys(): Promise<SessionKey[]> {
    return Promise.resolve(
      [...this.canonical.keys()].map((ref) => {
        const [userId, family, sessionId] = ref.split("/");
        return { userId: userId ?? "", family: family ?? "", sessionId: sessionId ?? "" };
      }),
    );
  }
  getBucketVersioning(): Promise<string> {
    return Promise.resolve("Enabled");
  }
  getLifecycle(): Promise<string> {
    return Promise.resolve("no lifecycle rules");
  }
  selfTest(): Promise<void> {
    this.selfTests += 1;
    return Promise.resolve();
  }
  deleteSession(k: SessionKey): Promise<DeleteSessionResult> {
    this.deletes.push(this.ref(k));
    this.canonical.delete(this.ref(k));
    return Promise.resolve({ complete: true, deleted: 1 });
  }
}

function seeded(count: number, name = "source"): MemoryStore {
  const store = new MemoryStore(name);
  for (let i = 0; i < count; i += 1) {
    store.canonical.set(sessionRef(key(i)), `${JSON.stringify({ type: "user", text: `s${i}` })}\n`);
    store.artifacts.set(`${sessionRef(key(i))}/session.json`, `{"id":"s${i}"}`);
  }
  return store;
}

interface Harness {
  deps: MigrationDeps;
  source: MemoryStore;
  target: MemoryStore;
  quiesce: IngestQuiesce;
  /** Every side effect, in the order it happened. */
  trace: string[];
  events: MigrationEvent[];
  now: () => number;
  advance: (ms: number) => void;
  version: number;
  armed: boolean;
}

function harness(over: Partial<MigrationDeps> & { sessions?: number } = {}): Harness {
  const source = (over.source as MemoryStore | undefined) ?? seeded(over.sessions ?? 3);
  const target = (over.target as MemoryStore | undefined) ?? new MemoryStore("target");
  const quiesce = new IngestQuiesce();
  const trace: string[] = [];
  const events: MigrationEvent[] = [];
  let clockMs = NOW;
  const state = { version: 3, armed: false };
  const deps: MigrationDeps = {
    mode: "switch",
    source,
    target,
    tombstones: async () => [],
    quiesce,
    armDrain: (on) => {
      state.armed = on;
      trace.push(`drain:${on ? "on" : "off"}`);
    },
    armPause: async (until) => {
      trace.push(`pause:${until.toISOString()}`);
      return "episode-1";
    },
    resumeIngest: async (id) => {
      trace.push(`resume:${id}`);
    },
    swapCredentials: async () => {
      trace.push("swap");
      state.version += 1;
      return state.version;
    },
    rebindStore: async () => {
      trace.push("rebind");
    },
    onEvent: (event) => events.push(event),
    clock: () => new Date(clockMs),
    sleep: async (ms) => {
      clockMs += ms;
    },
    ...over,
  };
  return {
    deps,
    source,
    target,
    quiesce,
    trace,
    events,
    now: () => clockMs,
    advance: (ms) => {
      clockMs += ms;
    },
    get version() {
      return state.version;
    },
    get armed() {
      return state.armed;
    },
  };
}

// ── the engine ───────────────────────────────────────────────────────────────

describe("what a run does, and stops at", () => {
  test("a plan touches neither bucket", async () => {
    const h = harness({ mode: "plan", sessions: 4 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", sessionsTotal: 4, sessionsCopied: 0 });
    expect(h.target.canonical.size).toBe(0);
    expect(h.target.selfTests).toBe(0);
    expect(h.trace).toEqual([]);
  });

  test("a copy moves the objects and their sidecars, and stops before the cut", async () => {
    const h = harness({ mode: "copy", sessions: 3 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", sessionsCopied: 3, switched: false, version: null });
    expect(h.target.canonical.size).toBe(3);
    expect(h.target.artifacts.get(`${sessionRef(key(0))}/session.json`)).toBe('{"id":"s0"}');
    // The candidate proves itself before anything is copied into it…
    expect(h.target.selfTests).toBe(1);
    // …and nothing was armed, paused or switched.
    expect(h.trace).toEqual([]);
  });

  test("a switch copies, cuts, rebinds and verifies", async () => {
    const h = harness({ sessions: 2 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", switched: true, version: 4, aborted: null });
    // The order is the whole point: the credentials move first, and the live
    // binding follows them.
    expect(h.trace).toEqual([
      "drain:on",
      `pause:${new Date(NOW + 5 * 60_000).toISOString()}`,
      "swap",
      "rebind",
      "resume:episode-1",
      "drain:off",
    ]);
  });
});

describe("proving the copy landed", () => {
  test("the checksum is taken from what the TARGET returns", async () => {
    const target = new MemoryStore("target");
    target.corrupt = "these are not the bytes that were sent\n";
    const h = harness({ target, sessions: 1 });
    await expect(runStorageMigration(h.deps)).rejects.toThrow(/checksum mismatch/);
    // Nothing was switched over a target the run stopped trusting.
    expect(h.trace).toEqual([]);
  });

  test("a copy interrupted mid-way is finished by the next run, not restarted", async () => {
    const source = seeded(4);
    const target = new MemoryStore("target");
    const recorded = new Set<string>();
    target.failOn = sessionRef(key(2));
    const first = harness({
      mode: "copy",
      source,
      target,
      recordCopied: async (object) => {
        recorded.add(sessionRef(object.key));
      },
      alreadyCopied: async () => recorded,
    });
    await expect(runStorageMigration(first.deps)).rejects.toThrow(/refused/);
    expect(recorded.size).toBe(2);

    const second = harness({
      mode: "copy",
      source,
      target,
      recordCopied: async (object) => {
        recorded.add(sessionRef(object.key));
      },
      alreadyCopied: async () => recorded,
    });
    const result = await runStorageMigration(second.deps);
    // Only what was missing: the two already proven are skipped.
    expect(result.sessionsCopied).toBe(2);
    expect(target.canonical.size).toBe(4);
  });

  test("a record whose object is gone is re-copied anyway", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    // The record claims both; the bucket holds neither.
    const claimed = new Set([sessionRef(key(0)), sessionRef(key(1))]);
    const h = harness({ mode: "copy", source, target, alreadyCopied: async () => claimed });
    const result = await runStorageMigration(h.deps);
    expect(result.sessionsCopied).toBe(2);
    expect(target.canonical.size).toBe(2);
  });

  test("the verify pass reports what the new binding cannot read", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Something removes it from the target after the copy but before the cut.
    const original = target.statCanonical.bind(target);
    let cut = false;
    target.statCanonical = async (k: SessionKey): Promise<number | null> =>
      cut && sessionRef(k) === sessionRef(key(1)) ? null : original(k);
    h.deps.rebindStore = async (): Promise<void> => {
      cut = true;
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    // Switched — and honest about what did not come with it. The source still
    // holds everything, which is what makes going back a credentials change.
    expect(result.switched).toBe(true);
    expect(result.aborted).toContain("not readable in the new bucket");
  });
});

describe("the drain, the barrier and the fence", () => {
  test("outstanding signatures run off BEFORE the pause is armed", async () => {
    const h = harness({ sessions: 1 });
    // A presigned PUT minted before the drain: it lands in the bucket without
    // passing through this process, so a pause cannot stop it.
    h.quiesce.noteSignature(new Date(NOW + 90_000));
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    const drainAt = h.trace.indexOf("drain:on");
    const pauseAt = h.trace.findIndex((t) => t.startsWith("pause:"));
    expect(drainAt).toBeLessThan(pauseAt);
    // The wait happened outside the pause: the deadline the pause was armed for
    // starts after the signature floor, not before it.
    const armed = Date.parse(h.trace[pauseAt]?.slice("pause:".length) ?? "");
    expect(armed).toBeGreaterThanOrEqual(NOW + 90_000);
  });

  test("a store that never goes quiet aborts, and ingest is resumed anyway", async () => {
    const h = harness({ sessions: 1, barrierMs: 5_000 });
    h.quiesce.enter();
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("did not go quiet");
    expect(result.switched).toBe(false);
    expect(h.trace).not.toContain("swap");
    // The pause must not outlive the run that armed it.
    expect(h.trace).toContain("resume:episode-1");
    expect(h.trace).toContain("drain:off");
  });

  test("a nearly-spent pause aborts before the cut rather than after it", async () => {
    const h = harness({ sessions: 1, swapPauseMs: FENCE_MARGIN_MS + 1_000 });
    // The barrier itself is instant; the delta inside the pause is what runs
    // long here, which is exactly the case the fence exists for.
    let passes = 0;
    const listAll = h.source.listAllCanonicalKeys.bind(h.source);
    h.source.listAllCanonicalKeys = async (): Promise<SessionKey[]> => {
      passes += 1;
      if (passes > 2) h.advance(FENCE_MARGIN_MS);
      return await listAll();
    };
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("nearly spent");
    expect(h.trace).not.toContain("swap");
  });

  test("the pause window is bounded, not open-ended", async () => {
    const h = harness({ sessions: 1, swapPauseMs: 30_000 });
    await runStorageMigration(h.deps);
    const armed = h.trace.find((t) => t.startsWith("pause:")) ?? "";
    // Armed for exactly what was asked for, from the clock at arm time.
    expect(Date.parse(armed.slice("pause:".length)) - NOW).toBe(30_000);
  });
});

describe("what the source is never asked to do", () => {
  test("no run deletes anything from the source bucket", async () => {
    const h = harness({
      sessions: 3,
      tombstones: async () => [key(0), key(1)],
    });
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    // The tombstones were replayed onto the TARGET…
    expect(h.target.deletes.sort()).toEqual([sessionRef(key(0)), sessionRef(key(1))].sort());
    // …and the source still holds everything it held, which is the rollback.
    expect(h.source.deletes).toEqual([]);
    expect(h.source.canonical.size).toBe(3);
  });

  test("a tombstoned session is absent from the target after the replay", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    // Copied before the delete: the object is in the target and the session is
    // gone from here. Without the replay, the cut resurrects it.
    target.canonical.set(sessionRef(key(9)), "resurrected\n");
    const h = harness({ source, target, tombstones: async () => [key(9)] });
    await runStorageMigration(h.deps);
    expect(target.canonical.has(sessionRef(key(9)))).toBe(false);
    expect(target.deletes).toEqual([sessionRef(key(9))]);
  });

  test("the engine contains no delete against the source, as source rather than as claim", () => {
    const engine = readFileSync(
      path.join(import.meta.dir, "..", "src", "console", "migration.ts"),
      "utf8",
    );
    expect(engine).not.toMatch(/source\.deleteSession/);
    expect(engine).not.toMatch(/source\.writeCanonicalText/);
    // The only delete in the file is the one aimed at the target.
    const deletes = engine.match(/\w+\.deleteSession\(/g) ?? [];
    expect(deletes).toEqual(["target.deleteSession("]);
  });
});

describe("one session", () => {
  test("carries its sidecars, and skips the ones it has none of", async () => {
    const source = seeded(1);
    const target = new MemoryStore("target");
    const copied = await copySession(source, target, key(0));
    expect(copied.checksum).toHaveLength(64);
    expect(copied.bytes).toBeGreaterThan(0);
    for (const name of MIGRATION_ARTIFACTS) {
      const present = await target.readArtifactText(key(0), name);
      expect(present === null || name === "session.json").toBe(true);
    }
  });
});

// ── the runner ───────────────────────────────────────────────────────────────

interface FakeDb {
  db: HxDb;
  statements: string[];
}

function fakeDb(over: { episode?: boolean; openRun?: string | null } = {}): FakeDb {
  const statements: string[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const sql = render(statement);
      statements.push(sql);
      if (sql.includes("FROM hx.ingest_control")) {
        return over.episode
          ? [
              {
                id: "episode-7",
                paused_until: new Date(Date.now() + 60_000),
                resumed_at: null,
                row_written_at: new Date(),
                reason: "storage migration",
              },
            ]
          : [];
      }
      if (sql.includes("INSERT INTO hx.ingest_control")) return [{ id: "episode-9" }];
      if (sql.includes("FROM hx.migration_runs")) {
        return over.openRun === undefined || over.openRun === null ? [] : [{ id: over.openRun }];
      }
      if (sql.includes("INSERT INTO hx.migration_runs")) return [{ id: "run-1" }];
      if (sql.includes("FROM hx.migration_objects")) return [];
      if (sql.includes("FROM hx.deleted_sessions")) return [];
      return [];
    },
  } as unknown as HxDb;
  return { db, statements };
}

const TARGET_CREDS: VaultCredentials = {
  store: "s3",
  bucket: "hx-fortress-seed-secondary",
  region: "us-east-1",
};

function runnerDeps(over: Partial<MigrationRunnerDeps> = {}): MigrationRunnerDeps {
  const source = seeded(2);
  const target = new MemoryStore("target");
  return {
    db: () => fakeDb().db,
    store: () => source,
    buildTarget: () => target,
    quiesce: new IngestQuiesce(),
    setDrain: () => {},
    rebindStore: async () => {},
    targetCredentials: async () => TARGET_CREDS,
    env: {},
    logger: LOGGER,
    ...over,
  };
}

let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "hx-migrate-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  await writeVaultCredentials({
    store: "s3",
    bucket: "hx-fortress-seed-primary",
    region: "us-east-1",
    openaiApiKey: "sk-embedding-key",
    version: 4,
  });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("what a command refuses before it copies anything", () => {
  test("an env-managed fortress, by naming the variable", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ env: { FORTRESS_STORAGE_BUCKET: "from-env" } }), {
        command: "arm",
        target: null,
      }),
    ).rejects.toThrow(envManagedRefusal("storage"));
  });

  test("a target that is the bucket this fortress already serves", async () => {
    await expect(
      runMigrationCommand(
        runnerDeps({
          targetCredentials: async () => ({ ...TARGET_CREDS, bucket: "hx-fortress-seed-primary" }),
        }),
        { command: "arm", target: null },
      ),
    ).rejects.toThrow(/already serves from/);
  });

  test("a named bucket the credential file does not name", async () => {
    await expect(
      runMigrationCommand(runnerDeps(), { command: "swap", target: "somebody-elses-bucket" }),
    ).rejects.toThrow(/not the one these credentials name/);
  });

  test("a credential reference that was already consumed", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ targetCredentials: async () => null }), {
        command: "arm",
        target: null,
      }),
    ).rejects.toThrow(/already consumed, expired or unreadable/);
  });

  test("a fortress with no database to record the run in", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ db: () => null }), { command: "arm", target: null }),
    ).rejects.toThrow(/database is not available/);
  });
});

describe("arm, swap, resume", () => {
  test("arm copies, leaves the run open, and raises the short-TTL floor", async () => {
    const fake = fakeDb();
    const target = new MemoryStore("target");
    const drain: boolean[] = [];
    const outcome = await runMigrationCommand(
      runnerDeps({
        db: () => fake.db,
        buildTarget: () => target,
        setDrain: (on) => void drain.push(on),
      }),
      { command: "arm", target: TARGET_CREDS.bucket },
    );
    expect(outcome).toContain("copied to hx-fortress-seed-secondary");
    expect(outcome).toContain("swap when ready");
    expect(target.canonical.size).toBe(2);
    expect(drain).toEqual([true]);
    // credentials.json still names the source: an arm is not a cut.
    expect((await readVaultCredentials())?.bucket).toBe("hx-fortress-seed-primary");
    // The run stays resumable — a copy closed early is a resume that starts over.
    const finish = fake.statements.filter((s) => s.includes("UPDATE hx.migration_runs")).at(-1) ?? "";
    expect(finish).toContain("finished_at = finished_at");
  });

  test("the swap writes credentials.json through the one door, and bumps the version", async () => {
    const fake = fakeDb();
    let rebinds = 0;
    const outcome = await runMigrationCommand(
      runnerDeps({ db: () => fake.db, rebindStore: async () => void (rebinds += 1) }),
      { command: "swap", target: TARGET_CREDS.bucket },
    );
    const after = await readVaultCredentials();
    expect(after?.bucket).toBe("hx-fortress-seed-secondary");
    // The version the console's live reader watches for MOVED…
    expect(after?.version).toBe(5);
    // …the embedding key, which belongs to neither bucket, survived…
    expect(after?.openaiApiKey).toBe("sk-embedding-key");
    // …the live binding followed the file…
    expect(rebinds).toBe(1);
    expect(outcome).toContain("credentials.json is at version 5");
    // …and the run is closed, because the cut is terminal.
    const finish = fake.statements.filter((s) => s.includes("UPDATE hx.migration_runs")).at(-1) ?? "";
    expect(finish).toContain("finished_at = now()");
  });

  test("the swap leaves no lock behind for the next writer", async () => {
    await runMigrationCommand(runnerDeps(), { command: "swap", target: TARGET_CREDS.bucket });
    await expect(readFile(`${credentialsPath()}.lock`, "utf8")).rejects.toThrow();
  });

  test("resume clears the episode and lowers the floor", async () => {
    const fake = fakeDb({ episode: true });
    const drain: boolean[] = [];
    const outcome = await runMigrationCommand(
      runnerDeps({ db: () => fake.db, setDrain: (on) => void drain.push(on) }),
      { command: "resume", target: null },
    );
    expect(drain).toEqual([false]);
    expect(outcome).toContain("episode-7");
    expect(fake.statements.some((s) => s.includes("UPDATE hx.ingest_control"))).toBe(true);
  });

  test("resume on a fortress that was never paused says so instead of failing", async () => {
    const outcome = await runMigrationCommand(runnerDeps({ db: () => fakeDb().db }), {
      command: "resume",
      target: null,
    });
    expect(outcome).toContain("no pause was armed");
  });
});

// ── the plane ────────────────────────────────────────────────────────────────

describe("the command surface", () => {
  test("the console's three phases are the runner's three commands", () => {
    expect([...MIGRATION_PHASES]).toEqual([...MIGRATION_COMMANDS]);
    for (const phase of MIGRATION_PHASES) expect(isMigrationCommand(phase)).toBe(true);
    expect(isMigrationCommand("teleport")).toBe(false);
    expect(validateCommandParams("run_migration", { phase: "arm" }).ok).toBe(true);
    expect(validateCommandParams("run_migration", { phase: "teleport" }).ok).toBe(false);
  });

  test("this build runs the kind, and a row asking for a step it has no name for fails", async () => {
    const calls: unknown[] = [];
    const executors = createCommandExecutors({
      logger: LOGGER,
      store: () => null,
      downloadBaseUrl: async () => null,
      service: {} as unknown as ServiceManager,
      cmdCredsDir: path.join(home, "cmd-creds"),
      env: {},
      db: () => null,
      rebindStore: async () => {},
      setCloudCredential: async () => {
        throw new Error("not wired");
      },
      status: async () => null,
      embeddingEndpoint: () => null,
      runAudit: async () => {
        throw new Error("not wired");
      },
      runMigration: async (args) => {
        calls.push(args);
        return "moved";
      },
      setCloudWitness: async () => {},
      acknowledgeFinding: async () => {},
      onBinarySwapped: () => {},
    });
    await expect(
      executors.run_migration({
        id: "c1",
        params: { phase: "swap", target: "b" },
        credentialRef: "a".repeat(32),
      }),
    ).resolves.toBe("moved");
    expect(calls).toEqual([{ command: "swap", target: "b", credentialRef: "a".repeat(32) }]);
    await expect(
      executors.run_migration({ id: "c2", params: { phase: "teleport" }, credentialRef: null }),
    ).rejects.toThrow(/does not run a teleport migration step/);
  });

  test("the console offers no control for it until one exists to submit", () => {
    // The kind is executable; a control that could mint the row is a surface of
    // its own, and a kind offered without one queues work nothing drives.
    expect(OFFERED_COMMAND_KINDS).not.toContain("run_migration");
  });
});

describe("the run record", () => {
  test("0019 creates it, with the cloud-served read roles revoked at creation", () => {
    const runs = migrations.find((m) => m.name === "0019_migration_runs");
    expect(runs).toBeDefined();
    const sql = runs?.sql ?? "";
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."migration_runs"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."migration_objects"');
    expect(sql).toContain("REVOKE ALL ON hx.migration_runs FROM hx_readonly");
    expect(sql).toContain("REVOKE ALL ON hx.migration_objects FROM hx_app_ro");
  });

  test("the console reads it and writes neither table", () => {
    const matrix = expectedPrivilegeMatrix();
    for (const table of ["migration_runs", "migration_objects"]) {
      expect(CONSOLE_TABLES).toContain(table as (typeof CONSOLE_TABLES)[number]);
      expect(UI_TABLE_GRANTS.find((g) => g.table === table)?.privileges).toEqual(["SELECT"]);
      expect(matrix[`t:hx_ui:${table}:SELECT`]).toBe(true);
      expect(matrix[`t:hx_ui:${table}:INSERT`]).toBe(false);
      // The daemon runs the move, so it owns the record of it.
      expect(matrix[`t:hx_app_rw:${table}:INSERT`]).toBe(true);
      // A run names buckets and session ids; the cloud-served read roles have no
      // business with either.
      expect(matrix[`t:hx_readonly:${table}:SELECT`]).toBe(false);
      expect(matrix[`t:hx_app_ro:${table}:SELECT`]).toBe(false);
    }
  });
});
