// The residency audit: what this fortress claims to hold, checked against what
// it actually holds, and against what let.ai says it delivered.
//
// Shape of a run, and why:
//
//   LIST FIRST, HEAD ONLY THE SUSPECTS. One bucket listing answers "is it there"
//   for every session at the cost of a few requests; a HEAD per session would
//   cost one request per session and produce the same answer for the ones the
//   listing already found. The HEADs are spent on the disagreements.
//
//   THE WITNESS IS ASKED ABOUT ELIGIBLE SESSIONS ONLY. A session's id is a piece
//   of this organization's data, and it leaves the box only for sessions that
//   REACHED this fortress THROUGH let.ai, which already saw the id. Everything
//   else is reported as unchecked, by name, and counted.
//
//   EVERY OUTBOUND CALL IS BUDGETED. The limiter is the reason an audit of a
//   large fortress cannot become an outage of it.

import {
  rollUp,
  sessionCheckPasses,
  unknownProvenanceCause,
  verdictFor,
  VERDICT_CAUSE,
  witnessEligible,
  type ResidencyVerdict,
  type RollUpCounts,
  type WitnessState,
} from "./audit-verdicts";

/** The engine's budget, as daemon config states it. Tunable because a fortress
 *  with a slow bucket and one with a fast one are the same code and different
 *  ceilings. */
export interface AuditEngineLimits {
  inFlight: number;
  opsPerSec: number;
  perRunBudget: number;
}

export const DEFAULT_AUDIT_LIMITS: AuditEngineLimits = {
  inFlight: 4,
  opsPerSec: 20,
  perRunBudget: 5_000,
};

/** How long a run and its findings are kept. Acknowledgements are NOT swept: a
 *  run is re-derivable by running the audit again, and an acknowledgement is a
 *  fact about an operator's decision that nothing else records. */
export const AUDIT_RETENTION_DAYS = 180;

export interface AuditSessionRow {
  org: string;
  family: string;
  sessionId: string;
  userId: string;
  ingestChannel: string | null;
}

export interface AuditFinding {
  org: string;
  family: string;
  sessionId: string;
  verdict: ResidencyVerdict;
  ingestChannel: string | null;
  detail: string;
  acknowledged: boolean;
}

export interface WitnessAnswer {
  /** Session ids let.ai reports a copy of. */
  copies: ReadonlySet<string>;
  /** Session ids let.ai holds ANY destination record for. */
  known: ReadonlySet<string>;
}

export interface AuditRunDeps {
  /** Every session this fortress claims. */
  sessions: () => Promise<AuditSessionRow[]>;
  /** Canonical keys present in the bucket, from ONE listing. */
  listCanonical: () => Promise<ReadonlySet<string>>;
  /** A single-object existence probe, spent only on disagreements. */
  headCanonical: (row: AuditSessionRow) => Promise<boolean>;
  /** Ask let.ai about the eligible ids. Null when the witness is switched off
   *  or unreachable, which is a different answer from "no copies". */
  askWitness: ((ids: readonly string[]) => Promise<WitnessAnswer | null>) | null;
  /** Sessions already acknowledged, keyed org + session id. */
  acknowledged: () => Promise<ReadonlySet<string>>;
  /** Whether let.ai's routing posture is fresh enough for this run to be clean. */
  postureFresh: () => Promise<boolean>;
  limits?: AuditEngineLimits;
  /** Injected in tests; real runs pace themselves. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AuditRunResult {
  counts: RollUpCounts;
  findings: AuditFinding[];
  verdict: ReturnType<typeof rollUp>["verdict"];
  qualification: string;
  /** Whether let.ai was asked, and if not, why. Recorded so the run's own
   *  history can say which of the two silences this was. */
  witness: WitnessState;
  /** Store operations actually spent. Asserted against the budget. */
  opsSpent: number;
  /** True when the run stopped at its per-run budget rather than at the end. */
  truncated: boolean;
}

/** The canonical object key for a session, as the store lays it out. */
export function canonicalKeyOf(row: AuditSessionRow): string {
  return [row.userId, row.family, row.sessionId, "canonical.ndjson"].join("/");
}

export function ackKey(org: string, sessionId: string): string {
  return [org, sessionId].join(" ");
}

export async function runResidencyAudit(deps: AuditRunDeps): Promise<AuditRunResult> {
  const limits = deps.limits ?? DEFAULT_AUDIT_LIMITS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pace = new Pacer(limits, sleep);

  const rows = await deps.sessions();
  const present = await deps.listCanonical();
  await pace.spend();

  // EVERY eligible id, because the loop below reports a verdict for every row.
  //
  // A previous attempt sliced this to `perRunBudget` on the premise that the
  // loop "spends at least one unit per row" and so could not reach further. It
  // does not: the only `pace.spend()` in the loop is inside the `!fortressPresent`
  // branch, so on a healthy fortress nothing is spent, no row is skipped and
  // `truncated` stays false. The rows past the slice were then given
  // `letaiCopy: false` and `anyDestinationRecord: false` — hard negatives from a
  // question nobody asked — which turns `also_at_letai` into `confirmed` and,
  // worse, `not_delivered_here` into `no_record`: the one verdict that fails a
  // roll-up, silently downgraded to a benign one.
  //
  // So the ask covers what the run reports on. If it cannot be completed the
  // adapter returns null and the whole witness reads `unavailable`, which is the
  // honest outcome and the one this engine is built to render.
  const eligible = rows.filter((r) => witnessEligible(r.ingestChannel));
  const witness = deps.askWitness ? await deps.askWitness(eligible.map((r) => r.sessionId)) : null;
  // Off (nobody asked) and unavailable (asked, unanswered) are different facts
  // about this organization, and the run reports which one it was.
  const witnessState: WitnessState = witness ? "attested" : deps.askWitness ? "unavailable" : "off";
  const acknowledged = await deps.acknowledged();

  const findings: AuditFinding[] = [];
  const counts: RollUpCounts = {
    sessionsChecked: 0,
    confirmed: 0,
    alsoAtLetai: 0,
    alsoAtLetaiAcknowledged: 0,
    notDeliveredHere: 0,
    noRecord: 0,
    unknownProvenance: 0,
    notApplicable: 0,
  };
  let truncated = false;

  for (const row of rows) {
    if (pace.spent >= limits.perRunBudget) {
      truncated = true;
      break;
    }
    counts.sessionsChecked += 1;
    let fortressPresent = present.has(canonicalKeyOf(row));
    if (!fortressPresent) {
      // The listing disagreed with the row. THIS is what a HEAD is for: a
      // paginated listing can miss a key that is really there, and reporting a
      // delivery failure on that basis would be an incident invented by a page
      // boundary.
      await pace.spend();
      fortressPresent = await deps.headCanonical(row);
    }
    const ack = acknowledged.has(ackKey(row.org, row.sessionId));
    const verdict = verdictFor({
      fortressPresent,
      letaiCopy: witness?.copies.has(row.sessionId) ?? false,
      anyDestinationRecord: witness?.known.has(row.sessionId) ?? false,
      ingestChannel: row.ingestChannel,
      acknowledged: ack,
    });
    countVerdict(counts, verdict, ack);
    findings.push({
      org: row.org,
      family: row.family,
      sessionId: row.sessionId,
      verdict,
      ingestChannel: row.ingestChannel,
      detail:
        verdict === "unknown_provenance"
          ? unknownProvenanceCause(row.ingestChannel)
          : VERDICT_CAUSE[verdict],
      acknowledged: ack,
    });
  }

  // A run that could not ask let.ai has established nothing about let.ai, so its
  // posture cannot be fresh however recent the cache is.
  const fresh = witness !== null && (await deps.postureFresh());
  const summary = rollUp(counts, { fresh, witness: witnessState });
  return {
    counts,
    findings,
    verdict: summary.verdict,
    qualification: summary.qualification,
    witness: witnessState,
    opsSpent: pace.spent,
    truncated,
  };
}

/** Findings that fail the per-session check, which is what an incident list
 *  renders. */
export function failingFindings(findings: readonly AuditFinding[]): AuditFinding[] {
  return findings.filter((f) => !sessionCheckPasses(f.verdict, f.acknowledged));
}

function countVerdict(counts: RollUpCounts, verdict: ResidencyVerdict, acknowledged: boolean): void {
  switch (verdict) {
    case "confirmed":
      counts.confirmed += 1;
      return;
    case "also_at_letai":
      counts.alsoAtLetai += 1;
      if (acknowledged) counts.alsoAtLetaiAcknowledged += 1;
      return;
    case "not_delivered_here":
      counts.notDeliveredHere += 1;
      return;
    case "no_record":
      counts.noRecord += 1;
      return;
    case "unknown_provenance":
      counts.unknownProvenance += 1;
      return;
    case "not_applicable":
      counts.notApplicable += 1;
      return;
  }
}

/** A rate ceiling with a per-run budget. Deliberately simple: the audit is
 *  serial by design, so the only things to hold are the rate and the total. */
class Pacer {
  spent = 0;
  private windowStart = 0;
  private inWindow = 0;

  constructor(
    private readonly limits: AuditEngineLimits,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async spend(): Promise<void> {
    this.spent += 1;
    const now = Date.now();
    if (now - this.windowStart >= 1_000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    this.inWindow += 1;
    if (this.inWindow > this.limits.opsPerSec) {
      await this.sleep(Math.max(0, 1_000 - (now - this.windowStart)));
      this.windowStart = Date.now();
      this.inWindow = 0;
    }
  }
}
