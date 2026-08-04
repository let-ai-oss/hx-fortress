// The verdict matrix, the layering that keeps an acknowledged copy from being a
// permanent failure, and the two terminal verbs the corrective rung needs.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalKeyOf,
  DEFAULT_AUDIT_LIMITS,
  failingFindings,
  runResidencyAudit,
  type AuditSessionRow,
} from "../src/console/audit-engine";
import { createWitnessClient } from "../src/console/audit-witness";
import { WITNESS_MAX_IDS, type FortressQueryPayload } from "../src/protocol";
import { FortressQueryUnavailable } from "../src/cloud/fortress-query";
import {
  acknowledgeable,
  rollUp,
  sessionCheckPasses,
  unknownProvenanceCause,
  verdictFor,
  VERDICT_CAUSE,
  VERDICT_HEADLINE,
  witnessEligible,
} from "../src/console/audit-verdicts";
import { runAuditVerb } from "../src/cli-audit-verbs";
import { fortressPaths } from "../src/host/paths";
import {
  publishAcks,
  publishAuditSettings,
  readWitnessIntent,
  WITNESS_SIGNAL,
} from "../src/console/witness-signal";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { runAuditForFortress } from "../src/console/audit-runner";
import { verifySessionResidency } from "../src/ui/residency-verify";
import { CONSOLE_TABLES, UI_TABLE_GRANTS } from "../src/host/postgres/console-plane";
import { migrations } from "../src/host/postgres/migrations/manifest";
import type { HxDb } from "../src/host/postgres/db";
import type { SessionStore } from "../src/modules/session-vault/store/types";

const ORG = "org-1";

function row(over: Partial<AuditSessionRow> = {}): AuditSessionRow {
  return { org: ORG, family: "claude", sessionId: "s1", userId: "u1", ingestChannel: "tunnel", ...over };
}

describe("the verdict matrix", () => {
  test("the incident is not_delivered_here, and nothing else is", () => {
    expect(
      verdictFor({
        fortressPresent: false,
        letaiCopy: false,
        anyDestinationRecord: true,
        ingestChannel: "tunnel",
        acknowledged: false,
      }),
    ).toBe("not_delivered_here");
    // No destination record at all is benign legacy, and its own verdict.
    expect(
      verdictFor({
        fortressPresent: false,
        letaiCopy: false,
        anyDestinationRecord: false,
        ingestChannel: "tunnel",
        acknowledged: false,
      }),
    ).toBe("no_record");
  });

  test("a copy at let.ai is a SEPARATE, weaker finding", () => {
    const verdict = verdictFor({
      fortressPresent: true,
      letaiCopy: true,
      anyDestinationRecord: true,
      ingestChannel: "tunnel",
      acknowledged: false,
    });
    expect(verdict).toBe("also_at_letai");
    // Per SESSION it fails until acknowledged...
    expect(sessionCheckPasses(verdict, false)).toBe(false);
    expect(sessionCheckPasses(verdict, true)).toBe(true);
    // ...and only this one can be cleared that way.
    expect(acknowledgeable("also_at_letai")).toBe(true);
    expect(acknowledgeable("not_delivered_here")).toBe(false);
    expect(sessionCheckPasses("not_delivered_here", true)).toBe(false);
  });

  test("a reconciled session reports unknown provenance, never not-applicable", () => {
    expect(witnessEligible("reconciled")).toBe(false);
    const verdict = verdictFor({
      fortressPresent: true,
      letaiCopy: false,
      anyDestinationRecord: false,
      ingestChannel: "reconciled",
      acknowledged: false,
    });
    expect(verdict).toBe("unknown_provenance");
    expect(unknownProvenanceCause("reconciled")).toContain("index outage");
    expect(unknownProvenanceCause(null)).toContain("predates channel tracking");
    // A direct upload is the other bucket, with its own label.
    expect(
      verdictFor({
        fortressPresent: true,
        letaiCopy: false,
        anyDestinationRecord: false,
        ingestChannel: "gateway",
        acknowledged: false,
      }),
    ).toBe("not_applicable");
    expect(VERDICT_HEADLINE.not_applicable).toContain("id never sent");
  });
});

describe("the fleet roll-up", () => {
  const base = {
    sessionsChecked: 10,
    confirmed: 10,
    alsoAtLetai: 0,
    alsoAtLetaiAcknowledged: 0,
    notDeliveredHere: 0,
    noRecord: 0,
    unknownProvenance: 0,
    notApplicable: 0,
  };

  test("an acknowledged copy qualifies the verdict and never fails it", () => {
    const result = rollUp(
      { ...base, confirmed: 8, alsoAtLetai: 2, alsoAtLetaiAcknowledged: 2 },
      { fresh: true },
    );
    expect(result.verdict).toBe("qualified");
    expect(result.qualification).toContain("2 historical let.ai copies, acknowledged");
  });

  test("an UNacknowledged one fails, and the incident always fails", () => {
    expect(rollUp({ ...base, alsoAtLetai: 1 }, { fresh: true }).verdict).toBe("failed");
    expect(
      rollUp({ ...base, notDeliveredHere: 1, alsoAtLetaiAcknowledged: 0 }, { fresh: true }).verdict,
    ).toBe("failed");
  });

  test("is never clean without a fresh posture", () => {
    expect(rollUp(base, { fresh: true }).verdict).toBe("clean");
    const stale = rollUp(base, { fresh: false });
    expect(stale.verdict).toBe("qualified");
    expect(stale.qualification).toContain("could not be refreshed");
  });

  test("the unknown-provenance and direct-upload shares qualify it too", () => {
    expect(rollUp({ ...base, confirmed: 8, unknownProvenance: 2 }, { fresh: true }).verdict).toBe(
      "qualified",
    );
    expect(rollUp({ ...base, confirmed: 8, notApplicable: 2 }, { fresh: true }).verdict).toBe(
      "qualified",
    );
  });
});

describe("one audit run", () => {
  const deps = (over: Partial<Parameters<typeof runResidencyAudit>[0]> = {}) => ({
    sessions: async () => [row()],
    listCanonical: async () => new Set([canonicalKeyOf(row())]),
    headCanonical: async () => true,
    askWitness: async () => ({ copies: new Set<string>(), known: new Set(["s1"]) }),
    acknowledged: async () => new Set<string>(),
    postureFresh: async () => true,
    sleep: async () => {},
    ...over,
  });

  test("HEADs only what the listing disagreed about", async () => {
    const heads: string[] = [];
    const result = await runResidencyAudit(
      deps({
        sessions: async () => [row({ sessionId: "here" }), row({ sessionId: "missing" })],
        listCanonical: async () => new Set([canonicalKeyOf(row({ sessionId: "here" }))]),
        headCanonical: async (r) => {
          heads.push(r.sessionId);
          return false;
        },
        askWitness: async () => ({ copies: new Set<string>(), known: new Set(["missing"]) }),
      }),
    );
    expect(heads).toEqual(["missing"]);
    expect(result.counts.confirmed).toBe(1);
    expect(result.counts.notDeliveredHere).toBe(1);
    expect(result.verdict).toBe("failed");
  });

  test("stops at the per-run budget instead of running the bucket dry", async () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ sessionId: `s${i}` }));
    const result = await runResidencyAudit(
      deps({
        sessions: async () => many,
        listCanonical: async () => new Set<string>(),
        headCanonical: async () => true,
        limits: { ...DEFAULT_AUDIT_LIMITS, perRunBudget: 5 },
      }),
    );
    expect(result.truncated).toBe(true);
    expect(result.opsSpent).toBeLessThanOrEqual(6);
    expect(result.counts.sessionsChecked).toBeLessThan(many.length);
  });

  test("a switched-off witness is never read as 'no copies'", async () => {
    const result = await runResidencyAudit(deps({ askWitness: null }));
    // Nothing was asked, so the run cannot be clean however healthy it looks.
    expect(result.verdict).toBe("qualified");
    expect(result.counts.confirmed).toBe(1);
  });

  test("an acknowledged copy stays out of the failing list across runs", async () => {
    const withCopy = deps({
      askWitness: async () => ({ copies: new Set(["s1"]), known: new Set(["s1"]) }),
      acknowledged: async () => new Set(["org-1 s1"]),
    });
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await runResidencyAudit(withCopy);
      expect(result.counts.alsoAtLetai).toBe(1);
      expect(result.counts.alsoAtLetaiAcknowledged).toBe(1);
      expect(failingFindings(result.findings)).toEqual([]);
      expect(result.verdict).toBe("qualified");
      expect(result.qualification).toContain("acknowledged");
    }
  });
});

describe("the witness client", () => {
  // The ids a question carries, taken through its discriminator: an answer to
  // `routingPosture` has none, and reading the field off the union unnarrowed is
  // how a mock ends up answering a question that was never asked.
  const asked = (query: FortressQueryPayload): readonly string[] =>
    query.kind === "residencyWitness" ? query.sessionIds : [];
  const answer = (ids: readonly string[]) => ({
    kind: "residencyWitness" as const,
    residencyWitness: ids.map((sessionId) => ({
      sessionId,
      // The hub's DELIVERY RECORD. Named apart from the fortress's own canonical
      // HEAD (VerdictInput.fortressPresent) because they are different facts,
      // and the audit exists to catch the case where they disagree.
      hubRoutedHere: true,
      letaiCopy: sessionId === "copied",
      anyDestinationRecord: true,
    })),
  });

  test("asks in bounded batches, one at a time", async () => {
    const batches: number[] = [];
    let inFlight = 0;
    const ask = createWitnessClient({
      request: async (query) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        const ids = asked(query);
        batches.push(ids.length);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        return answer(ids);
      },
    });
    const ids = Array.from({ length: WITNESS_MAX_IDS + 3 }, (_, i) => `s${i}`);
    const result = await ask(ids);
    expect(batches).toEqual([WITNESS_MAX_IDS, 3]);
    expect(result?.known.size).toBe(ids.length);
  });

  test("a timeout is no answer at all — never an empty one", async () => {
    const reasons: string[] = [];
    const ask = createWitnessClient({
      request: async () => {
        throw new FortressQueryUnavailable("timeout");
      },
      onUnavailable: (reason) => reasons.push(reason),
    });
    expect(await ask(["s1"])).toBeNull();
    expect(reasons[0]).toContain("timeout");
  });

  test("a hub too old to answer, and a hub that answered something else, both read as unavailable", async () => {
    // The old hub never replies; the transport times the question out for it.
    const silent = createWitnessClient({
      request: () => new Promise(() => {}) as never,
      batchSize: 2,
    });
    expect(await Promise.race([silent(["s1"]), Promise.resolve("pending")])).toBe("pending");

    // A well-formed answer to a DIFFERENT question. It is not a malformed frame
    // — it is a hub answering something nobody asked, and reading its absent
    // witness array as "no copies" is the failure this guards.
    const wrongShape = createWitnessClient({
      request: async () => ({
        kind: "routingPosture" as const,
        routingPosture: { cloudOnlySessions: 0, routedHere: 3, computedAt: "2026-08-01T00:00:00.000Z" },
      }),
    });
    expect(await wrongShape(["s1"])).toBeNull();
  });

  test("one failed batch abandons the whole answer", async () => {
    let calls = 0;
    const ask = createWitnessClient({
      batchSize: 1,
      request: async (query) => {
        calls += 1;
        if (calls === 2) throw new FortressQueryUnavailable("offline");
        return answer(asked(query));
      },
    });
    // The first batch DID come back — returning it would report the second
    // batch's sessions as having no copy, which nobody established.
    expect(await ask(["copied", "s2"])).toBeNull();
  });

  test("a transport that cannot ask says so, and nothing else", async () => {
    const ask = createWitnessClient({});
    expect(await ask(["s1"])).toBeNull();
    // Nothing eligible is a complete answer about nothing.
    expect(await createWitnessClient({ request: async () => answer([]) })([])).toEqual({
      copies: new Set(),
      known: new Set(),
    });
  });

  test("maps the two booleans the engine reads", async () => {
    const ask = createWitnessClient({ request: async (q) => answer(asked(q)) });
    const result = await ask(["copied", "plain"]);
    expect([...(result?.copies ?? [])]).toEqual(["copied"]);
    expect(result?.known.size).toBe(2);
  });
});

describe("an unasked witness is named", () => {
  const base = {
    sessions: async () => [row()],
    listCanonical: async () => new Set([canonicalKeyOf(row())]),
    headCanonical: async () => true,
    acknowledged: async () => new Set<string>(),
    postureFresh: async () => true,
    sleep: async () => {},
  };

  test("unreachable and switched off are different sentences, and neither says 'no copy'", async () => {
    const unreachable = await runResidencyAudit({
      ...base,
      askWitness: createWitnessClient({
        request: async () => {
          throw new FortressQueryUnavailable("timeout");
        },
      }),
    });
    expect(unreachable.witness).toBe("unavailable");
    expect(unreachable.verdict).toBe("qualified");
    expect(unreachable.qualification).toContain("let.ai could not be asked");

    const off = await runResidencyAudit({ ...base, askWitness: null });
    expect(off.witness).toBe("off");
    expect(off.qualification).toContain("switched off");
    for (const run of [unreachable, off]) {
      expect(run.qualification).not.toContain("no copy was found");
      expect(run.verdict).not.toBe("clean");
    }
  });

  test("an answered witness leaves the run able to be clean", async () => {
    const run = await runResidencyAudit({
      ...base,
      askWitness: createWitnessClient({
        request: async (q) => ({
          kind: "residencyWitness" as const,
          residencyWitness: (q.kind === "residencyWitness" ? q.sessionIds : []).map((sessionId) => ({
            sessionId,
            hubRoutedHere: true,
            letaiCopy: false,
            anyDestinationRecord: true,
          })),
        }),
      }),
    });
    expect(run.witness).toBe("attested");
    expect(run.verdict).toBe("clean");
  });
});

describe("the session-verify dialog", () => {
  test("renders the attested arm only when a run actually asked", () => {
    const base = {
      family: "claude",
      sessionId: "s1",
      row: { bytesUploaded: 10, ingestChannel: "tunnel", lastActivityAt: null },
      canonicalBytes: 10,
      stagingOrphans: 0,
    };
    const unchecked = verifySessionResidency(base);
    expect(unchecked.checks.find((c) => c.name === "let.ai copy")?.state).toBe("not-checked");

    const attested = verifySessionResidency({
      ...base,
      witness: { letaiCopy: true, anyDestinationRecord: true, acknowledged: false },
    });
    const check = attested.checks.find((c) => c.name === "let.ai copy");
    expect(check?.state).toBe("failed");
    expect(check?.detail).toContain(VERDICT_CAUSE.also_at_letai);

    const cleared = verifySessionResidency({
      ...base,
      witness: { letaiCopy: true, anyDestinationRecord: true, acknowledged: true },
    });
    expect(cleared.checks.find((c) => c.name === "let.ai copy")?.state).toBe("passed");
  });
});

describe("the audit tables", () => {
  test("0017 creates the run record, and 0015 keeps the two fenced ones", () => {
    const names = migrations.map((m) => m.name);
    expect(names).toContain("0017_audit_engine");
    const engine = migrations.find((m) => m.name === "0017_audit_engine")?.sql ?? "";
    expect(engine).toContain('CREATE TABLE IF NOT EXISTS "hx"."audit_runs"');
    expect(engine).toContain('CREATE TABLE IF NOT EXISTS "hx"."audit_findings"');
    // NOT this task's tables: their fences ride the command apparatus, and
    // 0015 is where they are created.
    expect(engine).not.toContain('CREATE TABLE IF NOT EXISTS "hx"."audit_acks"');
    expect(engine).not.toContain('CREATE TABLE IF NOT EXISTS "hx"."audit_settings"');
    const plane = migrations.find((m) => m.name === "0015_console_plane")?.sql ?? "";
    expect(plane).toContain('CREATE TABLE IF NOT EXISTS "hx"."audit_acks"');
    expect(plane).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.audit_acks FROM hx_app_rw");
    // hx_readonly and hx_app_ro lose them at CREATE time, not at the next boot.
    expect(engine).toContain("REVOKE ALL ON hx.audit_runs FROM hx_readonly");
    expect(engine).toContain("REVOKE ALL ON hx.audit_findings FROM hx_app_ro");
  });

  test("the console reads them, and writes none of them", () => {
    expect(CONSOLE_TABLES).toContain("audit_runs");
    expect(CONSOLE_TABLES).toContain("audit_findings");
    for (const table of ["audit_runs", "audit_findings", "audit_acks", "audit_settings"]) {
      const grant = UI_TABLE_GRANTS.find((g) => g.table === table);
      expect(grant?.privileges).toEqual(["SELECT"]);
    }
  });
});

describe("the terminal verbs", () => {
  async function withRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-audit-cli-"));
    try {
      return await work(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("witness on writes an intent and SIGNALS the daemon — it mints no row", async () => {
    await withRoot(async (root) => {
      const paths = fortressPaths(root);
      const signals: Array<[number, string]> = [];
      const lines: string[] = [];
      const code = await runAuditVerb(["witness", "off"], {
        writeLine: (line) => lines.push(line),
        fortressRoot: root,
        daemonPid: async () => 4242,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          return true;
        },
      });
      expect(code).toBe(0);
      expect(signals).toEqual([[4242, WITNESS_SIGNAL]]);
      expect(await readWitnessIntent(paths.runtimeRoot)).toMatchObject({ enabled: false });
    });
  });

  test("refuses when no daemon is there to apply it", async () => {
    await withRoot(async (root) => {
      await expect(
        runAuditVerb(["witness", "on"], {
          writeLine: () => {},
          fortressRoot: root,
          daemonPid: async () => null,
        }),
      ).rejects.toThrow(/only thing that may write this setting/);
    });
  });

  test("witness show reads what the daemon published, and says what off means", async () => {
    await withRoot(async (root) => {
      const paths = fortressPaths(root);
      await publishAuditSettings(paths.runtimeRoot, false, new Date("2026-07-31T00:00:00Z"));
      const lines: string[] = [];
      await runAuditVerb(["witness", "show"], { writeLine: (l) => lines.push(l), fortressRoot: root });
      expect(lines[0]).toBe("Cloud witness: off");
      expect(lines[1]).toContain("No session id leaves this host");
    });
  });

  test("acks reconcile lists the unmatched ones and changes nothing without the flag", async () => {
    await withRoot(async (root) => {
      const paths = fortressPaths(root);
      await publishAcks(paths.runtimeRoot, [
        {
          org: ORG,
          sessionId: "explained",
          acknowledgedAt: "2026-07-30T10:00:00Z",
          acknowledgedBy: "op",
          reason: null,
        },
        {
          org: ORG,
          sessionId: "unexplained",
          acknowledgedAt: "2026-07-30T10:00:00Z",
          acknowledgedBy: null,
          reason: null,
        },
      ]);
      await mkdir(paths.auditSpool, { recursive: true });
      await writeFile(
        path.join(paths.auditSpool, "2026-07-30-ui-aaaa.jsonl"),
        `${JSON.stringify({
          action: "console.command.submit",
          params: { commandKind: "acknowledge_finding", sessionId: "explained" },
        })}\n`,
      );

      const lines: string[] = [];
      const signals: number[] = [];
      await runAuditVerb(["acks", "reconcile"], {
        writeLine: (l) => lines.push(l),
        fortressRoot: root,
        daemonPid: async () => 1,
        kill: (pid) => {
          signals.push(pid);
          return true;
        },
      });
      expect(lines[0]).toContain("1 acknowledgement(s) have no matching record");
      expect(lines.some((l) => l.includes("unexplained"))).toBe(true);
      expect(signals).toEqual([]);
      expect(await readWitnessIntent(paths.runtimeRoot)).toBeNull();

      await runAuditVerb(["acks", "reconcile", "--re-confirm"], {
        writeLine: (l) => lines.push(l),
        fortressRoot: root,
        daemonPid: async () => 1,
        kill: (pid) => {
          signals.push(pid);
          return true;
        },
      });
      expect(signals).toEqual([1]);
      const intent = await readWitnessIntent(paths.runtimeRoot);
      expect(intent?.reconfirm).toEqual([
        { org: ORG, sessionId: "unexplained", reason: "re-confirmed from the terminal" },
      ]);
    });
  });
});

describe("what the runner is allowed to sweep", () => {
  const dialect = new PgDialect();
  const emptyStore = {
    listAllCanonicalKeys: async () => [],
    statCanonical: async () => null,
  } as unknown as SessionStore;

  function recorder(): { db: () => HxDb; statements: string[]; values: unknown[][] } {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const db = {
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        statements.push(query.sql);
        values.push(query.params);
        return [];
      },
    } as unknown as HxDb;
    return { db: () => db, statements, values };
  }

  test("the session sweep names the enrolled org, and nothing else", async () => {
    const rec = recorder();
    await runAuditForFortress({
      db: rec.db,
      store: () => emptyStore,
      ownOrgId: async () => ORG,
      askWitness: null,
      postureFresh: async () => true,
    });
    const i = rec.statements.findIndex((s) => s.includes("FROM hx.sessions"));
    expect(i).toBeGreaterThanOrEqual(0);
    // The ids this returns are the ids an eligible session sends to let.ai over
    // THIS fortress's credential. A second organization's rows on the same host
    // are not this run's to name, or to report verdicts about.
    expect(rec.statements[i]).toContain("o.external_id =");
    expect(rec.values[i]).toContain(ORG);
  });

  test("an unenrolled fortress sweeps nothing rather than everything", async () => {
    const rec = recorder();
    const run = await runAuditForFortress({
      db: rec.db,
      store: () => emptyStore,
      ownOrgId: async () => null,
      askWitness: null,
      postureFresh: async () => true,
    });
    expect(rec.statements.some((s) => s.includes("FROM hx.sessions"))).toBe(false);
    expect(run.counts.sessionsChecked).toBe(0);
  });
});

describe("a budget refusal is a wait, not a failure", () => {
  test("a rate-limited batch is retried and the sweep completes", async () => {
    const waits: number[] = [];
    let refusals = 2;
    const asked: string[] = [];
    const ask = createWitnessClient({
      batchSize: 2,
      wait: async (ms) => {
        waits.push(ms);
      },
      request: async (query) => {
        if (refusals > 0) {
          refusals -= 1;
          throw new FortressQueryUnavailable("error", "fortress_query_rate_limited", 3_000);
        }
        const ids = query.kind === "residencyWitness" ? query.sessionIds : [];
        asked.push(...ids);
        return {
          kind: "residencyWitness",
          residencyWitness: ids.map((sessionId) => ({ sessionId, letaiCopy: true, hubRoutedHere: true, anyDestinationRecord: true })),
        };
      },
    });

    const answer = await ask(["a", "b", "c"]);

    // The run completes rather than collapsing, every id is asked exactly once,
    // and the wait honoured is the one the hub named.
    expect(answer).not.toBeNull();
    expect(asked.sort()).toEqual(["a", "b", "c"]);
    expect(waits).toEqual([3_000, 3_000]);
    expect([...answer!.copies].sort()).toEqual(["a", "b", "c"]);
  });

  test("a refusal that names no wait still collapses the run", async () => {
    const reasons: string[] = [];
    const ask = createWitnessClient({
      onUnavailable: (reason) => reasons.push(reason),
      request: async () => {
        throw new FortressQueryUnavailable("error", "something else");
      },
    });

    expect(await ask(["a"])).toBeNull();
    expect(reasons).toHaveLength(1);
  });

  test("a hub that refuses forever gives up instead of looping", async () => {
    let attempts = 0;
    const ask = createWitnessClient({
      wait: async () => {},
      request: async () => {
        attempts += 1;
        throw new FortressQueryUnavailable("error", "fortress_query_rate_limited", 1_000);
      },
    });

    expect(await ask(["a"])).toBeNull();
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(100);
  });

  test("a hostile hub cannot stall the run for longer than the ceiling, at any sweep size", async () => {
    // The allowance scales with the sweep on purpose — one wait per batch is what
    // success costs — so the thing that has to be bounded is TIME, not count. A
    // per-batch allowance of a large wait would otherwise hold the audit for
    // hours, and the whole console mutation plane sits behind this call: one poll
    // pass at a time, executors serial.
    const waitedFor = async (batchCount: number): Promise<number> => {
      let waited = 0;
      const ask = createWitnessClient({
        batchSize: 1,
        wait: async (ms) => {
          waited += ms;
        },
        request: async () => {
          // Far above anything an honest hub can ask for.
          throw new FortressQueryUnavailable("error", "fortress_query_rate_limited", 3_600_000);
        },
      });
      expect(await ask(Array.from({ length: batchCount }, (_, i) => `s${i}`))).toBeNull();
      return waited;
    };

    // 50x the batches must not buy anything close to 50x the stall.
    expect(await waitedFor(20)).toBeLessThanOrEqual(120_000);
    expect(await waitedFor(1_000)).toBeLessThanOrEqual(120_000);
  });

  test("a sweep an honest hub paces still completes — the budget must not be the binding limit", async () => {
    // The real regression this guards: an allowance sized in RETRIES rather than
    // in batches makes the witness unobtainable above some session count, and the
    // operator reads a rate limit as a broken hub. An honest hub never asks for
    // more than ~1s, so a sweep that pays one wait per batch has to finish.
    let refuseNext = true;
    const seen: string[] = [];
    const ask = createWitnessClient({
      batchSize: 1,
      wait: async () => {},
      request: async (query) => {
        // Every other question is refused with an honest hub's maximum wait.
        refuseNext = !refuseNext;
        if (refuseNext) throw new FortressQueryUnavailable("error", "fortress_query_rate_limited", 1_000);
        const ids = query.kind === "residencyWitness" ? query.sessionIds : [];
        seen.push(...ids);
        return {
          kind: "residencyWitness",
          residencyWitness: ids.map((sessionId) => ({
            sessionId,
            letaiCopy: true,
            hubRoutedHere: true,
            anyDestinationRecord: true,
          })),
        };
      },
    });

    const ids = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const answer = await ask(ids);
    expect(answer).not.toBeNull();
    expect(seen.sort()).toEqual([...ids].sort());
  });

  test("many small waits cannot add up to the same stall", async () => {
    let waited = 0;
    const ask = createWitnessClient({
      wait: async (ms) => {
        waited += ms;
      },
      request: async () => {
        throw new FortressQueryUnavailable("error", "fortress_query_rate_limited", 5_000);
      },
    });
    expect(await ask(["a"])).toBeNull();
    expect(waited).toBeLessThanOrEqual(120_000);
  });
});
