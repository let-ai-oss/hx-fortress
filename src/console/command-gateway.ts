// The CommandGateway backed by the fortress Postgres.
//
// Reads go straight at the table (the daemon holds SELECT); every WRITE goes
// through a SECURITY DEFINER routine, because the daemon's role holds neither
// INSERT nor UPDATE here. That is not a convention this file could choose to
// break: a direct UPDATE from this connection is refused by the server.

import { sql } from "drizzle-orm";

import type { CommandGateway, CommandRow } from "./commands";
import type { HxDb } from "../host/postgres/db";

interface RawCommand {
  id: string;
  kind: string;
  params: unknown;
  status: string;
  requested_at: string | Date;
  deadline_at: string | Date | null;
  credential_ref: string | null;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function firstBoolean(result: unknown): boolean {
  const row = rows<Record<string, unknown>>(result)[0];
  if (!row) return false;
  return Object.values(row)[0] === true;
}

export function createCommandGateway(db: HxDb): CommandGateway {
  return {
    async listOpen(): Promise<CommandRow[]> {
      const result = await db.execute(
        sql`SELECT id, kind, params, status, requested_at, deadline_at, credential_ref
              FROM hx.console_commands
             WHERE status IN ('requested', 'running')
             ORDER BY requested_at ASC`,
      );
      return rows<RawCommand>(result).map((row) => ({
        id: String(row.id),
        kind: row.kind,
        params: row.params,
        status: row.status,
        requestedAt: asDate(row.requested_at),
        deadlineAt: row.deadline_at === null ? null : asDate(row.deadline_at),
        credentialRef: row.credential_ref,
      }));
    },

    async claim(id: string, claimedBy: string, redrive: boolean): Promise<boolean> {
      return firstBoolean(
        await db.execute(
          sql`SELECT hx.claim_command(${id}::uuid, ${claimedBy}, ${redrive}) AS claimed`,
        ),
      );
    },

    async complete(
      id: string,
      status: "done" | "failed",
      outcome: string | null,
      error: string | null,
    ): Promise<boolean> {
      return firstBoolean(
        await db.execute(
          sql`SELECT hx.complete_command(${id}::uuid, ${status}, ${outcome}, ${error}) AS completed`,
        ),
      );
    },

    async reject(id: string, reason: string): Promise<boolean> {
      return firstBoolean(
        await db.execute(sql`SELECT hx.reject_command(${id}::uuid, ${reason}) AS rejected`),
      );
    },
  };
}
