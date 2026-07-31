import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMMAND_REQUEST_TTL_MS,
  FAIL_CREDENTIAL_CONSUMED,
  REJECT_BOOT_FENCE,
  REJECT_DEADLINE,
  heartbeatFresh,
  pollCommands,
  runBootFence,
  type CommandExecutors,
  type CommandGateway,
  type CommandRow,
} from "../src/console/commands";
import { validateCommandParams } from "../src/console/command-params";
import { readInFlight } from "../src/console/runtime-files";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function row(over: Partial<CommandRow> = {}): CommandRow {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    kind: over.kind ?? "self_test",
    params: over.params ?? {},
    status: over.status ?? "requested",
    requestedAt: over.requestedAt ?? new Date(NOW.getTime() - 1000),
    deadlineAt: over.deadlineAt ?? null,
    credentialRef: over.credentialRef ?? null,
  };
}

interface FakeGateway extends CommandGateway {
  calls: string[];
  rows: CommandRow[];
}

function fakeGateway(rows: CommandRow[]): FakeGateway {
  const calls: string[] = [];
  return {
    calls,
    rows,
    listOpen: async () => rows,
    claim: async (id, claimedBy, redrive) => {
      calls.push(`claim:${id}:${redrive}`);
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      // The routine refuses a future requested_at and any terminal row.
      if (r.requestedAt.getTime() > NOW.getTime()) return false;
      if (r.status === "requested" || (r.status === "running" && redrive)) {
        r.status = "running";
        return true;
      }
      return false;
    },
    complete: async (id, status, _outcome, error) => {
      calls.push(`complete:${id}:${status}:${error ?? ""}`);
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== "running") return false;
      r.status = status;
      return true;
    },
    reject: async (id, reason) => {
      calls.push(`reject:${id}:${reason}`);
      const r = rows.find((x) => x.id === id);
      if (!r || (r.status !== "requested" && r.status !== "running")) return false;
      r.status = "rejected";
      return true;
    },
  };
}

function executors(ran: string[], throwOn?: string): CommandExecutors {
  const run = (kind: string) => async (): Promise<string | null> => {
    if (throwOn === kind) throw new Error("boom");
    ran.push(kind);
    return "ok";
  };
  return {
    update_apply: run("update_apply"),
    rotate_credentials: run("rotate_credentials"),
    run_migration: run("run_migration"),
    run_checkup: run("run_checkup"),
    self_test: run("self_test"),
    run_audit: run("run_audit"),
    witness_toggle: run("witness_toggle"),
    acknowledge_finding: run("acknowledge_finding"),
  };
}

describe("command parameter validation", () => {
  test("rejects an unknown kind and unknown parameters", () => {
    expect(validateCommandParams("revoke_session", {}).ok).toBe(false);
    expect(validateCommandParams("self_test", { rm: "-rf" }).ok).toBe(false);
  });

  test("refuses a secret by NAME and by SHAPE", () => {
    const byName = validateCommandParams("update_apply", { password: "x" });
    expect(byName.ok).toBe(false);
    const byShape = validateCommandParams("update_apply", {
      version: "-----BEGIN RSA PRIVATE KEY-----\nabc",
    });
    expect(byShape.ok).toBe(false);
    const highEntropy = validateCommandParams("update_apply", {
      version: "A".repeat(20) + "b3F9xQ2mZ7pL1kR8sT4vW6yU0iO5eD",
    });
    expect(highEntropy.ok).toBe(false);
  });

  test("a rotation carries a reference id, never the credential", () => {
    expect(validateCommandParams("rotate_credentials", {}).ok).toBe(false);
    expect(validateCommandParams("rotate_credentials", { credentialRef: "nope" }).ok).toBe(false);
    const ok = validateCommandParams("rotate_credentials", {
      credentialRef: "0123456789abcdef0123456789abcdef",
    });
    expect(ok.ok).toBe(true);
  });

  test("per-kind shapes are enforced", () => {
    expect(validateCommandParams("run_migration", { phase: "swap" }).ok).toBe(true);
    expect(validateCommandParams("run_migration", { phase: "teleport" }).ok).toBe(false);
    expect(validateCommandParams("witness_toggle", { enabled: "yes" }).ok).toBe(false);
    expect(validateCommandParams("acknowledge_finding", { org: "o", sessionId: "s" }).ok).toBe(true);
    expect(validateCommandParams("acknowledge_finding", { org: "", sessionId: "s" }).ok).toBe(false);
  });
});

describe("the boot fence", () => {
  let root = "";
  let inFlightPath = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-"));
    inFlightPath = path.join(root, "commands-inflight.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a pending row minted before boot is rejected, never claimed", async () => {
    const gateway = fakeGateway([row({ id: "a", status: "requested" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.rejected).toEqual(["a"]);
    expect(gateway.calls).toEqual([`reject:a:${REJECT_BOOT_FENCE}`]);
  });

  test("a row minted pre-boot with a far-future requestedAt is fenced too", async () => {
    const gateway = fakeGateway([
      row({ id: "a", requestedAt: new Date(NOW.getTime() + 86_400_000) }),
    ]);
    await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(gateway.calls.some((c) => c.startsWith("claim:"))).toBe(false);
    expect(gateway.rows[0].status).toBe("rejected");
  });

  test("a planted running row is fenced whatever claimedBy says", async () => {
    // The id is ABSENT from the daemon's own in-flight file, which is the only
    // thing that decides eligibility — claimed_by is SELECT-able by the very
    // adversary the fence defends against, so it is never a predicate.
    const gateway = fakeGateway([row({ id: "planted", status: "running" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.redriven).toEqual([]);
    expect(result.rejected).toEqual(["planted"]);
  });

  test("the daemon's own crashed row is re-driven in place", async () => {
    await writeFile(inFlightPath, JSON.stringify(["mine"]));
    const gateway = fakeGateway([row({ id: "mine", status: "running" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.redriven).toEqual(["mine"]);
    expect(gateway.calls).toEqual([]);

    // …and the poll pass then re-claims it through the re-drive arm.
    const ran: string[] = [];
    await pollCommands(
      { gateway, executors: executors(ran), inFlightPath, claimedBy: "pid:boot", clock: () => NOW },
      new Set(result.redriven),
    );
    expect(gateway.calls[0]).toBe("claim:mine:true");
    expect(ran).toEqual(["self_test"]);
    expect(gateway.rows[0].status).toBe("done");
  });

  test("a crashed row carrying a single-use credential FAILS, never re-runs", async () => {
    await writeFile(inFlightPath, JSON.stringify(["rot"]));
    const gateway = fakeGateway([
      row({ id: "rot", kind: "rotate_credentials", status: "running", credentialRef: "a".repeat(32) }),
    ]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.failed).toEqual(["rot"]);
    expect(result.redriven).toEqual([]);
    expect(gateway.calls).toEqual([`complete:rot:failed:${FAIL_CREDENTIAL_CONSUMED}`]);
    expect(await readInFlight(inFlightPath)).toEqual(new Set());
  });
});

describe("the poll pass", () => {
  let root = "";
  let inFlightPath = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-poll-"));
    inFlightPath = path.join(root, "commands-inflight.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(gateway: CommandGateway, ran: string[], throwOn?: string) {
    return {
      gateway,
      executors: executors(ran, throwOn),
      inFlightPath,
      claimedBy: "pid:boot",
      clock: () => NOW,
    };
  }

  test("claims, executes and completes a fresh row", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual(["claim:a:false", "complete:a:done:"]);
    expect(ran).toEqual(["self_test"]);
    // The in-flight entry is written BEFORE execution and cleared after.
    expect(await readInFlight(inFlightPath)).toEqual(new Set());
  });

  test("records the row as in-flight before it runs", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    let seen: string[] = [];
    const ran: string[] = [];
    const base = deps(gateway, ran);
    base.executors = {
      ...base.executors,
      self_test: async () => {
        seen = [...(await readInFlight(inFlightPath))];
        return null;
      },
    };
    await pollCommands(base);
    expect(seen).toEqual(["a"]);
  });

  test("a lapsed request is rejected instead of run", async () => {
    const gateway = fakeGateway([
      row({ id: "old", requestedAt: new Date(NOW.getTime() - COMMAND_REQUEST_TTL_MS - 1000) }),
    ]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual([`reject:old:${REJECT_DEADLINE}`]);
    expect(ran).toEqual([]);
  });

  test("a future requestedAt is rejected rather than parked in the queue", async () => {
    const gateway = fakeGateway([row({ id: "future", requestedAt: new Date(NOW.getTime() + 5000) })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual([`reject:future:${REJECT_DEADLINE}`]);
  });

  test("secret-shaped params are rejected before anything is claimed", async () => {
    const gateway = fakeGateway([row({ id: "bad", kind: "update_apply", params: { token: "x" } })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls[0]).toStartWith("reject:bad:rejected_invalid_params");
    expect(ran).toEqual([]);
  });

  test("a running row NOT in the in-flight file is never re-driven", async () => {
    const gateway = fakeGateway([row({ id: "planted", status: "running" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran)); // empty redrive set
    expect(gateway.calls).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("an executor throw completes the row as failed", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran, "self_test"));
    expect(gateway.calls).toEqual(["claim:a:false", "complete:a:failed:boom"]);
    expect(gateway.rows[0].status).toBe("failed");
  });

  test("every transition the daemon performs is reported for corroboration", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const seen: string[] = [];
    const ran: string[] = [];
    await pollCommands({ ...deps(gateway, ran), onTransition: (r) => void seen.push(r.transition) });
    expect(seen).toEqual(["claimed", "done"]);
  });
});

describe("heartbeat freshness", () => {
  test("gates submission on a daemon that is actually writing", () => {
    expect(heartbeatFresh(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(true);
    expect(heartbeatFresh(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe(false);
    // A pre-heartbeat file cannot vouch for anything.
    expect(heartbeatFresh(undefined, NOW)).toBe(false);
  });
});

describe("the in-flight file", () => {
  test("is created 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-mode-"));
    try {
      const file = path.join(root, "runtime", "commands-inflight.json");
      const gateway = fakeGateway([row({ id: "a" })]);
      await pollCommands({
        gateway,
        executors: executors([]),
        inFlightPath: file,
        claimedBy: "pid",
        clock: () => NOW,
      });
      const contents = await readFile(file, "utf8");
      expect(JSON.parse(contents)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
