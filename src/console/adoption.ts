// Adoption, and where every number in it comes from.
//
// The page answers "who has this, and who is using it" — a question with two
// halves that must never be blended. The hub knows who the organization employs
// and what they have installed; only this host knows what actually arrived here.
// So every stage carries the SOURCE it was computed from and whether that source
// is cloud-attested or fortress-observed, and the table below is the whole
// mapping. A stage with two sources would be a figure nobody could reconcile
// against either of them.
//
// Two derivations are pinned here because getting them wrong is easy and silent:
//
//   THE DENOMINATOR IS ACTIVE MEMBERS ONLY. People who have left are counted
//   separately and never divided into: a coverage figure that keeps counting
//   departed employees falls forever, and one that deletes them loses the fact
//   that their sessions are still here.
//
//   QUIET IS DERIVED FROM lastUploadAt, NEVER lastSeenAt. A client heartbeats
//   whether or not it is uploading anything, so last-seen stays fresh on an
//   install that has silently stopped sending — which is exactly the install an
//   operator is looking for.

import type { RosterPersonRow } from "../query/console/roster";

export type StageSource = "roster" | "roster device inventory" | "local session rows";
export type StageAttestation = "cloud-attested" | "fortress-observed";
export type StageId = "rostered" | "installed" | "sync" | "sending" | "active";

export interface AdoptionStage {
  id: StageId;
  label: string;
  source: StageSource;
  attestation: StageAttestation;
  /** Exactly what is counted, in the words the page renders. */
  detail: string;
}

/** The stage-source table. ONE source per stage, and the posture cache is not
 *  among them: the gates panel is posture-sourced and is deliberately not a
 *  funnel input — it describes let.ai's routing, not this organization's people. */
export const ADOPTION_STAGES: readonly AdoptionStage[] = [
  {
    id: "rostered",
    label: "On the roster",
    source: "roster",
    attestation: "cloud-attested",
    detail: "active members let.ai reports for this organization",
  },
  {
    id: "installed",
    label: "Has worked here",
    source: "roster device inventory",
    attestation: "cloud-attested",
    // NOT an install count. The roster's `installed` counts machines whose
    // device_id produced a session attributed to THIS organization — that
    // scoping is what keeps another tenant's estate off this console — so a
    // person who installed the client and has only worked elsewhere counts zero.
    detail: "members with at least one machine that has produced a session for this organization",
  },
  {
    id: "sync",
    label: "Backfill reported complete",
    source: "roster device inventory",
    attestation: "cloud-attested",
    detail: "members whose most recent backfill report has nothing outstanding",
  },
  {
    id: "sending",
    label: "Sending to this fortress",
    source: "local session rows",
    attestation: "fortress-observed",
    detail: "members with at least one session on this host",
  },
  {
    id: "active",
    label: `Active in the last ${30} days`,
    source: "local session rows",
    attestation: "fortress-observed",
    detail: "members with session activity here inside the window",
  },
];

/** The window "active" means. Pinned here so the label and the SQL cannot drift
 *  apart. */
export const ADOPTION_ACTIVE_DAYS = 30;

/** How long an install may go without uploading before it is worth an
 *  operator's attention. */
export const QUIET_AFTER_DAYS = 14;

export interface AdoptionCounts {
  rostered: number;
  installed: number;
  syncComplete: number;
  sending: number;
  active: number;
  /** Departed members still retained. Counted, never in the denominator. */
  formerMembers: number;
  /** People sending here whom the roster does not know at all. */
  unrostered: number;
}

export interface AdoptionStageView extends AdoptionStage {
  count: number;
  /** Share of the active-member denominator, or null when there is no roster to
   *  divide by — a percentage invented from the people who already appear would
   *  always read 100%. */
  share: number | null;
}

export function adoptionStages(counts: AdoptionCounts): AdoptionStageView[] {
  const denominator = counts.rostered;
  const value: Record<StageId, number> = {
    rostered: counts.rostered,
    installed: counts.installed,
    sync: counts.syncComplete,
    sending: counts.sending,
    active: counts.active,
  };
  return ADOPTION_STAGES.map((stage) => ({
    ...stage,
    count: value[stage.id],
    share: denominator > 0 ? value[stage.id] / denominator : null,
  }));
}

export type AttentionKind = "nothing-here-yet" | "never-uploaded" | "quiet" | "backfill-outstanding";

export interface AttentionRow {
  externalId: string;
  displayName: string;
  kind: AttentionKind;
  detail: string;
}

export const ATTENTION_COPY: Record<AttentionKind, string> = {
  "nothing-here-yet": "on the roster, with no machine of theirs having produced a session here",
  "never-uploaded": "has an install that has never uploaded anything",
  quiet: `has an install that has not uploaded for over ${QUIET_AFTER_DAYS} days`,
  "backfill-outstanding": "is still backfilling — sessions from before the install are on their way",
};

/**
 * Who an operator should look at, worst first.
 *
 * INACTIVE MEMBERS ARE EXCLUDED. Somebody who has left the organization is not
 * an adoption problem, and leaving them here would fill the list with people
 * nobody can act on.
 */
export function attentionRows(
  rows: readonly RosterPersonRow[],
  now: number = Date.now(),
): AttentionRow[] {
  const out: AttentionRow[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const kind = attentionKind(row, now);
    if (!kind) continue;
    out.push({
      externalId: row.externalId,
      displayName: row.displayName,
      kind,
      detail: ATTENTION_COPY[kind],
    });
  }
  const order: AttentionKind[] = ["nothing-here-yet", "never-uploaded", "quiet", "backfill-outstanding"];
  return out.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.externalId.localeCompare(b.externalId),
  );
}

function attentionKind(row: RosterPersonRow, now: number): AttentionKind | null {
  // The observed fact, not an inferred install state: `installed === 0` means no
  // machine of theirs has produced a session for this organization. It does NOT
  // mean they have no client — saying so would send an operator chasing an
  // install that already exists.
  if (row.installed === 0) return "nothing-here-yet";
  // lastUploadAt, never lastSeenAt: a heartbeat is not an upload.
  if (row.lastUploadAt === null) return "never-uploaded";
  const age = now - Date.parse(row.lastUploadAt);
  if (Number.isFinite(age) && age > QUIET_AFTER_DAYS * 86_400_000) return "quiet";
  if (row.syncTotal !== null && row.syncDone !== null && row.syncDone < row.syncTotal) {
    return "backfill-outstanding";
  }
  return null;
}

export interface TeamSummary {
  name: string;
  members: number;
  sending: number;
}

/** Teams, straight from the roster's own field. Only ACTIVE members are grouped:
 *  a team's headcount is who is in it now. */
export function rosterTeams(rows: readonly RosterPersonRow[]): TeamSummary[] {
  const teams = new Map<string, TeamSummary>();
  for (const row of rows) {
    if (!row.active) continue;
    for (const name of row.teams) {
      const team = teams.get(name) ?? { name, members: 0, sending: 0 };
      team.members += 1;
      if (row.sessions > 0) team.sending += 1;
      teams.set(name, team);
    }
  }
  return [...teams.values()].sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
}

