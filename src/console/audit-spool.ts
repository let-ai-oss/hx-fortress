// The 0600 append-only audit spool — and the reason command outcomes can be
// believed at all.
//
// The daemon's Postgres authority IS the cloud-reachable write role, so an
// adversary holding it can call complete_command/reject_command directly:
// fabricate a rotation that never ran, deny every submission, or report a
// success for work that failed. No SQL-layer fix exists — any nonce the routine
// could check is one the same role could rotate.
//
// So the daemon writes what it ACTUALLY did to a file that role cannot reach,
// and the console drains it as hx_ui (the only role with admin_audit INSERT).
// A terminal outcome with no matching spool record renders as REPORTED
// (unconfirmed); one with a record renders as corroborated.
//
// The intent record is fsynced BEFORE the mutation runs and the outcome is
// appended after — an append-only pair, never an in-place amend, so a crash
// between them is itself evidence.

import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface AuditRecord {
  /** Identifies the spool FILE; with `seq` it is the drain's idempotency key. */
  fileId: string;
  seq: number;
  ts: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  /** Allowlisted, never secrets — the same rule the command params follow. */
  params: Record<string, unknown> | null;
  kind: "intent" | "outcome";
  /** For an outcome: the seq of the intent it answers. */
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
  /** `system` for records the daemon itself produced (it holds no admin_audit
   *  INSERT, so these reach Postgres only through this spool). */
  origin: "console" | "system";
}

export interface AuditSpoolOptions {
  dir: string;
  fileId?: string;
  clock?: () => Date;
}

export class AuditSpool {
  private readonly dir: string;
  private readonly fileId: string;
  private readonly clock: () => Date;
  private seq = 0;
  private ready: Promise<void> | null = null;

  constructor(options: AuditSpoolOptions) {
    this.dir = options.dir;
    this.fileId = options.fileId ?? randomUUID();
    this.clock = options.clock ?? ((): Date => new Date());
  }

  get filePath(): string {
    return path.join(this.dir, `${this.fileId}.jsonl`);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.ready;
  }

  /** Append + fsync. The caller must await this BEFORE performing the mutation
   *  the record describes; a mutation whose intent never reached disk is one the
   *  console can never corroborate. */
  async append(
    record: Omit<AuditRecord, "fileId" | "seq" | "ts">,
  ): Promise<AuditRecord> {
    await this.ensureDir();
    const full: AuditRecord = {
      ...record,
      fileId: this.fileId,
      seq: (this.seq += 1),
      ts: this.clock().toISOString(),
    };
    await appendFile(this.filePath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const handle = await open(this.filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return full;
  }

  async intent(
    action: string,
    fields: Partial<Omit<AuditRecord, "fileId" | "seq" | "ts" | "kind" | "action">> = {},
  ): Promise<AuditRecord> {
    return this.append({
      actor: fields.actor ?? null,
      sessionRef: fields.sessionRef ?? null,
      tier: fields.tier ?? null,
      action,
      params: fields.params ?? null,
      kind: "intent",
      refSeq: null,
      outcome: null,
      error: null,
      origin: fields.origin ?? "system",
    });
  }

  async outcome(
    intentRecord: AuditRecord,
    outcome: string,
    error: string | null = null,
  ): Promise<AuditRecord> {
    return this.append({
      actor: intentRecord.actor,
      sessionRef: intentRecord.sessionRef,
      tier: intentRecord.tier,
      action: intentRecord.action,
      params: null,
      kind: "outcome",
      refSeq: intentRecord.seq,
      outcome,
      error,
      origin: intentRecord.origin,
    });
  }
}

/** Read every spooled record, oldest file first. The drain runs as hx_ui and is
 *  `ON CONFLICT DO NOTHING` on (spool_file_id, seq), so re-reading a file that
 *  was already drained is a no-op rather than a duplicate. */
export async function readSpool(dir: string): Promise<AuditRecord[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((e) => e.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const entry of entries) {
    let contents: string;
    try {
      contents = await readFile(path.join(dir, entry), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        // A torn final line (crash mid-append) — the pair semantics already
        // treat a missing outcome as evidence, so skipping it loses nothing.
      }
    }
  }
  return records;
}

/** Command ids whose terminal outcome the daemon actually produced. The console
 *  renders anything else as reported-but-unconfirmed. */
export function corroboratedCommandIds(records: readonly AuditRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.kind !== "outcome") continue;
    const id = record.sessionRef;
    if (id) ids.add(id);
  }
  return ids;
}
