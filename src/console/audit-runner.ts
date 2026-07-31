// Wiring one residency audit to a live fortress: its sessions, its bucket, its
// witness and its acknowledgements.
//
// Kept apart from the engine so the engine stays a pure function of what it was
// told — the verdict matrix is the part that has to be provable, and it is
// testable without a bucket, a database or a tunnel.

import { sql } from "drizzle-orm";

import {
  ackKey,
  canonicalKeyOf,
  runResidencyAudit,
  type AuditRunDeps,
  type AuditRunResult,
  type AuditSessionRow,
  type WitnessAnswer,
} from "./audit-engine";
import { readAcknowledgements, readCloudWitness } from "./audit-store";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface AuditRunnerDeps {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  /** Ask let.ai about a batch of ids. Null when there is no tunnel. */
  askWitness: ((ids: readonly string[]) => Promise<WitnessAnswer | null>) | null;
  postureFresh: () => Promise<boolean>;
  /** Published for `hx-fortress audit acks reconcile`, which cannot read the
   *  database and must not be given a way to. */
  publish?: (acks: Awaited<ReturnType<typeof readAcknowledgements>>) => Promise<void>;
}

export async function runAuditForFortress(deps: AuditRunnerDeps): Promise<AuditRunResult> {
  const db = deps.db();
  if (!db) throw new Error("the fortress database is not available");
  const store = deps.store();
  if (!store) throw new Error("the object store is not initialized on this fortress");

  const witnessOn = await readCloudWitness(db).catch(() => false);
  const acks = await readAcknowledgements(db);
  await deps.publish?.(acks);
  const acknowledged = new Set(acks.map((a) => ackKey(a.org, a.sessionId)));

  const runDeps: AuditRunDeps = {
    sessions: async () => {
      const result = await db.execute(
        sql`SELECT s.id AS "sessionId", s.family AS "family", s.user_id AS "userId",
                   s.ingest_channel AS "ingestChannel", o.external_id AS "org"
              FROM hx.sessions s
              JOIN hx.orgs o ON o.id = s.org_id
             WHERE s.deleted_at IS NULL
             ORDER BY s.created_at ASC`,
      );
      return rows<Record<string, unknown>>(result).map(
        (row): AuditSessionRow => ({
          org: String(row.org ?? ""),
          family: String(row.family ?? ""),
          sessionId: String(row.sessionId ?? ""),
          userId: String(row.userId ?? ""),
          ingestChannel: row.ingestChannel === null ? null : String(row.ingestChannel),
        }),
      );
    },
    listCanonical: async () => {
      const keys = await store.listAllCanonicalKeys();
      return new Set(
        keys.map((key) =>
          canonicalKeyOf({
            org: "",
            family: key.family,
            sessionId: key.sessionId,
            userId: key.userId,
            ingestChannel: null,
          }),
        ),
      );
    },
    headCanonical: async (row) => {
      const bytes = await store.statCanonical({
        family: row.family,
        sessionId: row.sessionId,
        userId: row.userId,
      });
      return bytes !== null;
    },
    // OFF means the ids never leave the box — a different answer from "let.ai
    // reported no copies", and every eligible session says so by name.
    askWitness: witnessOn ? deps.askWitness : null,
    acknowledged: async () => acknowledged,
    postureFresh: deps.postureFresh,
  };
  return await runResidencyAudit(runDeps);
}
