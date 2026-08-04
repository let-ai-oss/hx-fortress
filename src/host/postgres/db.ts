import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

// A Drizzle handle over Bun.SQL for the bundled hx-db. The gateway ingestion
// path uses this for typed queries/transactions; the migration runner keeps its
// own raw Bun.SQL exec (simple-query mode) and is bounded separately.
export type HxDb = BunSQLDatabase<typeof schema>;

/** The transaction handle drizzle hands to `db.transaction(tx => …)`. Helpers
 *  that run inside a commit accept this so they enlist in the same tx. */
export type HxTx = Parameters<Parameters<HxDb["transaction"]>[0]>[0];

/** Parse a millisecond env knob: unset or set-but-EMPTY means the default (an
 *  empty value in a template must never silently zero a safety bound); anything
 *  non-finite or negative also falls back. Values are truncated to integers. */
function msEnv(
  env: Record<string, string | undefined>,
  name: string,
  def: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : def;
}

/** Bun.SQL wants seconds for its lifecycle knobs; round up so a sub-second
 *  override still yields a bound (min 1 s) instead of 0 = disabled. */
const msToSec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LIFETIME_MS = 3_600_000;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_S = 60;

/** Effective server-side statement_timeout (ms). `0` means OMIT the startup
 *  parameter entirely — the pooled-DSN escape hatch: PgBouncer-class poolers
 *  reject unknown startup parameters, so `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0`
 *  must strip it from EVERY consumer (shared pools, the guarded-db probe
 *  canary, and the embed worker's own longer override). */
export function statementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return msEnv(env, "FORTRESS_DB_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS);
}

export interface HxPoolOptions {
  /** Seconds — Bun.SQL's unit for the three lifecycle knobs. */
  connectionTimeout: number;
  idleTimeout: number;
  /** Hard rotation: Bun kills a connection (mid-query included — the txn rolls
   *  back atomically) once it reaches this age, which is what heals a poisoned
   *  pool against a healthy server even if nothing else fires. */
  maxLifetime: number;
  max: number;
  /** Startup parameters. statement_timeout (ms) bounds every statement
   *  server-side — the only per-query bound Bun.SQL offers (it has no client
   *  per-query timeout). Absent entirely when the =0 escape hatch is set. */
  connection?: { statement_timeout: number };
}

/** The shared pool options every fortress Bun.SQL client derives from
 *  (component 1 of the PG-layer resilience design). Constructor-only — the DSN
 *  itself is never mutated.
 *
 *  Env knobs (ms; set-but-empty ⇒ default): FORTRESS_DB_CONNECT_TIMEOUT_MS
 *  (default 10 000; 0 ⇒ default — a connect bound may never be disabled),
 *  FORTRESS_DB_STATEMENT_TIMEOUT_MS (default 120 000; 0 ⇒ omit the startup
 *  param — pooler escape hatch), FORTRESS_DB_MAX_LIFETIME_MS (default
 *  3 600 000 — one hour: rotation is the last-resort healer behind the probe's
 *  ~3 min rebuild path, and a guarantor RESTORE of a giant session replays the
 *  whole transcript in one transaction, which must fit inside one connection
 *  lifetime (a 106 MB session hit the old 10 min wall on day one);
 *  0 ⇒ default — never disableable). */
export function hxPoolOptions(
  env: Record<string, string | undefined> = process.env,
  overrides: { max?: number; statementTimeoutMs?: number } = {},
): HxPoolOptions {
  const connectRaw = msEnv(env, "FORTRESS_DB_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
  const connectMs = connectRaw > 0 ? connectRaw : DEFAULT_CONNECT_TIMEOUT_MS;
  const lifetimeRaw = msEnv(env, "FORTRESS_DB_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS);
  const lifetimeMs = lifetimeRaw > 0 ? lifetimeRaw : DEFAULT_MAX_LIFETIME_MS;
  const baseStatementMs = statementTimeoutMs(env);
  // =0 omits the param for EVERY consumer — an override (the embed worker's
  // 300 s) applies only while the hatch is not engaged.
  const effectiveStatementMs =
    baseStatementMs === 0 ? 0 : Math.trunc(overrides.statementTimeoutMs ?? baseStatementMs);
  const options: HxPoolOptions = {
    connectionTimeout: msToSec(connectMs),
    idleTimeout: DEFAULT_IDLE_TIMEOUT_S,
    maxLifetime: msToSec(lifetimeMs),
    max: overrides.max ?? DEFAULT_POOL_MAX,
  };
  if (effectiveStatementMs > 0 && Number.isInteger(effectiveStatementMs)) {
    options.connection = { statement_timeout: effectiveStatementMs };
  }
  return options;
}

/** One DSN-free log line describing an effective pool (boot diagnostics): the
 *  host only (never userinfo/path), plus the knobs that matter in an incident. */
export function describePool(dsn: string, options: HxPoolOptions): Record<string, unknown> {
  let host = "unparseable";
  try {
    host = new URL(dsn).hostname;
  } catch {
    // keep the placeholder — the DSN itself must never reach a log line
  }
  return {
    host,
    connectionTimeoutS: options.connectionTimeout,
    idleTimeoutS: options.idleTimeout,
    maxLifetimeS: options.maxLifetime,
    max: options.max,
    statementTimeoutMs: options.connection?.statement_timeout ?? "omitted",
  };
}

export function createHxDb(dsn: string, options: HxPoolOptions = hxPoolOptions()): HxDb {
  return drizzle(new Bun.SQL(dsn, options), { schema });
}

export interface PurgeDb {
  db: HxDb;
  /** Detached, bounded, rejection-observed close — call in `finally`. */
  close: () => void;
}

/** Dedicated short-lived client for one purge invocation: NO statement_timeout
 *  startup param and NO maxLifetime, deliberately. An oversized purge statement
 *  must be allowed to finish server-side even after the cloud abandons the RPC
 *  at 30 s (zombie-convergence: the next parked retry finds `complete: true`);
 *  the shared pools' statement timeout / hard rotation would convert that into a
 *  never-converging park loop that re-burns the same delete work every 2 min. */
export function createPurgeDb(dsn: string): PurgeDb {
  const client = new Bun.SQL(dsn, { max: 1, connectionTimeout: 10 });
  return {
    db: drizzle(client, { schema }),
    close: () => {
      void client.close({ timeout: 5 }).catch(() => {});
    },
  };
}
