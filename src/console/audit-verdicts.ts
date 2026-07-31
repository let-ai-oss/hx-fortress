// The residency verdict matrix, and the words each verdict is allowed to use.
//
// The distinction that governs everything here: THE INCIDENT is
// `not_delivered_here` — a session that should be on this fortress and is not.
// `also_at_letai` is a separate, weaker finding: the object IS here, and a
// historical copy also exists at let.ai. Collapsing the two would either raise
// a permanent alarm about bytes that predate the fortress, or bury a genuine
// delivery failure under a label an operator has learned to acknowledge.
//
// Severity is LAYERED, not contradictory. Per SESSION, `also_at_letai` fails the
// residency check until it is acknowledged. In the FLEET roll-up an acknowledged
// one qualifies the verdict and never fails it. `not_delivered_here` is never
// downgraded by an acknowledgement — an acknowledgement says "we know why a copy
// exists there", and no answer to that question makes a missing object present.

export type ResidencyVerdict =
  | "confirmed"
  | "also_at_letai"
  | "not_delivered_here"
  | "no_record"
  | "unknown_provenance"
  | "not_applicable";

/** What was actually observed for one session. */
export interface VerdictInput {
  /** The transcript object is in this fortress's bucket. */
  fortressPresent: boolean;
  /** let.ai reports a copy of this session's bytes. */
  letaiCopy: boolean;
  /** let.ai holds ANY per-destination record for this session. Absent records
   *  predate destination tracking and are benign legacy, not an incident. */
  anyDestinationRecord: boolean;
  /** How the session first reached this fortress. */
  ingestChannel: string | null;
  /** An acknowledgement already exists for this session. */
  acknowledged: boolean;
}

/** Eligibility, fail-private: only a cloud-relayed session may have its id sent
 *  to the witness at all. */
export function witnessEligible(ingestChannel: string | null): boolean {
  return ingestChannel === "tunnel";
}

export function verdictFor(input: VerdictInput): ResidencyVerdict {
  if (!witnessEligible(input.ingestChannel)) {
    // A session uploaded straight to this fortress was never named to let.ai, so
    // there is nothing to ask about — and one whose channel is unknown must not
    // be assumed to be either.
    return input.ingestChannel === "gateway" ? "not_applicable" : "unknown_provenance";
  }
  if (input.fortressPresent) return input.letaiCopy ? "also_at_letai" : "confirmed";
  if (input.anyDestinationRecord) return "not_delivered_here";
  return "no_record";
}

/** Whether the PER-SESSION residency check passes. An unacknowledged
 *  also_at_letai fails it; an acknowledged one does not. */
export function sessionCheckPasses(verdict: ResidencyVerdict, acknowledged: boolean): boolean {
  if (verdict === "not_delivered_here") return false;
  if (verdict === "also_at_letai") return acknowledged;
  return true;
}

/** Whether an operator can clear this finding by acknowledging it. Only the
 *  weaker one: acknowledging a missing object would be acknowledging a fact
 *  rather than explaining one. */
export function acknowledgeable(verdict: ResidencyVerdict): boolean {
  return verdict === "also_at_letai";
}

export const VERDICT_HEADLINE: Record<ResidencyVerdict, string> = {
  confirmed: "held here, and let.ai reports no copy",
  also_at_letai: "held here, and a historical let.ai copy exists",
  not_delivered_here: "should be on this fortress, and is not",
  no_record: "no destination record at let.ai — predates per-destination tracking",
  unknown_provenance: "upload channel unknown — not verified with let.ai",
  not_applicable: "not checked with let.ai — uploaded directly; id never sent",
};

/** Why a verdict happened, and what to do about it. Pinned: the same sentence
 *  renders in the finding, in the per-session proof and on the tile. */
export const VERDICT_CAUSE: Record<ResidencyVerdict, string> = {
  confirmed: "the transcript is in this organization's bucket and let.ai reports no copy of it",
  also_at_letai: "bytes at let.ai predate this fortress, or the session is also attributed to a let.ai-hosted org",
  not_delivered_here: "let.ai recorded this fortress as a destination and the object never arrived",
  no_record: "this session was uploaded before let.ai recorded per-destination delivery",
  unknown_provenance:
    "this session's row predates channel tracking, or it was recovered after an index outage",
  not_applicable: "this session was uploaded straight to this fortress; its id was never sent to let.ai",
};

export const VERDICT_REMEDIATION: Record<ResidencyVerdict, string> = {
  confirmed: "nothing to do",
  also_at_letai:
    "acknowledge it once you have confirmed which of the two causes applies; the acknowledgement is kept per session and inherited by later runs",
  not_delivered_here:
    "re-upload the session from the client that holds it, or ask let.ai to re-deliver it; this one is not acknowledgeable",
  no_record: "nothing to do — it is benign legacy, and it qualifies the verdict rather than failing it",
  unknown_provenance:
    "nothing to do per session; the share of these qualifies every verdict this run produces",
  not_applicable: "nothing to do — this fortress is the only place these bytes were ever sent",
};

/** The sub-cause an unknown-provenance session carries, rendered from the value
 *  rather than from a second lookup — a `reconciled` session reports unknown
 *  provenance, never not_applicable. */
export function unknownProvenanceCause(ingestChannel: string | null): string {
  return ingestChannel === "reconciled"
    ? "recovered after an index outage, so its original channel is not recorded"
    : "predates channel tracking";
}

export interface RollUpCounts {
  sessionsChecked: number;
  confirmed: number;
  alsoAtLetai: number;
  alsoAtLetaiAcknowledged: number;
  notDeliveredHere: number;
  noRecord: number;
  unknownProvenance: number;
  notApplicable: number;
}

export type FleetVerdict = "clean" | "qualified" | "failed";

/**
 * The fleet roll-up, TRI-STATE and never clean without a fresh posture.
 *
 * A run that could not ask let.ai has not proven anything about let.ai, and a
 * console that said "clean" on that basis would be reporting the absence of a
 * question as the absence of a copy.
 */
export function rollUp(
  counts: RollUpCounts,
  posture: { fresh: boolean },
): { verdict: FleetVerdict; qualification: string } {
  if (counts.notDeliveredHere > 0) {
    return {
      verdict: "failed",
      qualification: `${counts.notDeliveredHere} session${counts.notDeliveredHere === 1 ? "" : "s"} should be on this fortress and ${counts.notDeliveredHere === 1 ? "is" : "are"} not`,
    };
  }
  const outstanding = counts.alsoAtLetai - counts.alsoAtLetaiAcknowledged;
  if (outstanding > 0) {
    return {
      verdict: "failed",
      qualification: `${outstanding} session${outstanding === 1 ? "" : "s"} also hold a let.ai copy and ${outstanding === 1 ? "has" : "have"} not been acknowledged`,
    };
  }
  const notes: string[] = [];
  if (counts.alsoAtLetaiAcknowledged > 0) {
    notes.push(
      `${counts.alsoAtLetaiAcknowledged} historical let.ai cop${counts.alsoAtLetaiAcknowledged === 1 ? "y" : "ies"}, acknowledged`,
    );
  }
  if (counts.unknownProvenance > 0) {
    notes.push(`${counts.unknownProvenance} of unknown upload channel`);
  }
  if (counts.notApplicable > 0) {
    notes.push(`${counts.notApplicable} uploaded directly and never named to let.ai`);
  }
  if (counts.noRecord > 0) {
    notes.push(`${counts.noRecord} predating per-destination tracking`);
  }
  if (!posture.fresh) {
    notes.push("let.ai's own view of this organization could not be refreshed for this run");
  }
  if (notes.length === 0) {
    return { verdict: "clean", qualification: "every checked session is held here and nowhere else" };
  }
  return { verdict: "qualified", qualification: `qualified (${notes.join("; ")})` };
}
