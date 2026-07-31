// Where an audit run and its findings are recorded, and what the retention
// sweep is allowed to remove.
//
// Runs and findings are DISPOSABLE: running the audit again produces them
// again. Acknowledgements are not, which is why they live in a table this file
// only ever reads — they are written through the fenced SECURITY DEFINER
// routine, by the daemon, on an operator's explicit command.

import { sql } from "drizzle-orm";

import { AUDIT_RETENTION_DAYS, type AuditFinding } from "./audit-engine";
import type { RollUpCounts } from "./audit-verdicts";
import type { HxDb } from "../host/postgres/db";

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface RecordedRun {
  id: string;
}

export async function startAuditRun(
  db: HxDb,
  args: { trigger: string; requestedBy: string | null },
): Promise<RecordedRun> {
  const result = await db.execute(
    sql`INSERT INTO hx.audit_runs (trigger, requested_by)
        VALUES (${args.trigger}, ${args.requestedBy})
        RETURNING id`,
  );
  const id = rows<{ id: unknown }>(result)[0]?.id;
  if (typeof id !== "string") throw new Error("the fortress database accepted no audit run");
  return { id };
}

export async function finishAuditRun(
  db: HxDb,
  runId: string,
  args: { counts: RollUpCounts; qualification: string; error: string | null },
): Promise<void> {
  await db.execute(
    sql`UPDATE hx.audit_runs
           SET finished_at = now(),
               sessions_checked = ${args.counts.sessionsChecked},
               confirmed = ${args.counts.confirmed},
               also_at_letai = ${args.counts.alsoAtLetai},
               not_delivered_here = ${args.counts.notDeliveredHere},
               no_record = ${args.counts.noRecord},
               unknown_provenance = ${args.counts.unknownProvenance},
               not_applicable = ${args.counts.notApplicable},
               qualification = ${args.qualification},
               error = ${args.error}
         WHERE id = ${runId}::uuid`,
  );
}

/** Only the findings worth keeping: a confirmed session is the absence of a
 *  finding, and recording one per session would grow a table the size of the
 *  fortress every night for no reader. */
export async function recordFindings(
  db: HxDb,
  runId: string,
  findings: readonly AuditFinding[],
): Promise<number> {
  const keep = findings.filter((f) => f.verdict !== "confirmed" && f.verdict !== "not_applicable");
  for (const finding of keep) {
    await db.execute(
      sql`INSERT INTO hx.audit_findings (run_id, org, family, session_id, verdict, ingest_channel, detail)
          VALUES (${runId}::uuid, ${finding.org}, ${finding.family}, ${finding.sessionId},
                  ${finding.verdict}, ${finding.ingestChannel}, ${finding.detail})`,
    );
  }
  return keep.length;
}

/** Acknowledgements, as the engine reads them. SELECT only from here: the write
 *  path is the fenced routine the acknowledge_finding command calls. */
export async function readAcknowledgements(
  db: HxDb,
): Promise<Array<{ org: string; sessionId: string; acknowledgedAt: string; acknowledgedBy: string | null; reason: string | null }>> {
  const result = await db.execute(
    sql`SELECT org, session_id, acknowledged_at, acknowledged_by, reason FROM hx.audit_acks`,
  );
  return rows<Record<string, unknown>>(result).map((row) => ({
    org: String(row.org),
    sessionId: String(row.session_id),
    acknowledgedAt:
      row.acknowledged_at instanceof Date
        ? row.acknowledged_at.toISOString()
        : String(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by === null ? null : String(row.acknowledged_by),
    reason: row.reason === null ? null : String(row.reason),
  }));
}

export async function readCloudWitness(db: HxDb): Promise<boolean> {
  const result = await db.execute(sql`SELECT cloud_witness FROM hx.audit_settings LIMIT 1`);
  const row = rows<{ cloud_witness: unknown }>(result)[0];
  return row?.cloud_witness === true;
}

/** Runs age out; the acknowledgements they reference do not. The cascade takes
 *  the findings with the run, which is why acks are keyed on the SESSION rather
 *  than on a finding id. */
export async function sweepAuditRuns(
  db: HxDb,
  days: number = AUDIT_RETENTION_DAYS,
): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM hx.audit_runs
         WHERE started_at < now() - (${String(days)} || ' days')::interval
        RETURNING id`,
  );
  return rows(result).length;
}
