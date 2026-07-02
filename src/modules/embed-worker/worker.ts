// A3 · the incremental, content-addressed embed worker. Runs INSIDE the fortress
// (a host module booted in main.ts beside the gateway), OFF the commit path
// (best-effort — a failed embed never fails an upload). It owns its OWN capped
// Bun.SQL handle (the shipped createHxDb handle is uncapped) + an in-process
// OpenAI concurrency limiter, so "off the request path" stays "off the box's
// connection pool" too.
//
// One pass:
//   0. GUARD — skip entirely if pgvector isn't installed (hx.embeddings absent),
//      so a fortress with an OpenAI key but no vector extension just no-ops
//      instead of error-looping on a missing relation.
//   1. CLAIM the anti-join — indexable turns (kind IN user_text/assistant_text,
//      text present, not soft-deleted) with NO vector yet, minus any turn the
//      scheduler has dead-lettered. So a growing session embeds only its new
//      turns; a whole-session recompute never happens.
//   2. SCRUB each turn, hash the scrubbed text (content_hash).
//   3. REUSE — any content_hash already embedded UNDER THE SAME (model, dim) is
//      copied, skipping OpenAI. The (model, dim) match means a later model/width
//      change never reuses a stale-model vector.
//   4. EMBED the rest via OpenAI OFF-LOCK (no DB txn is held across the round
//      trip — holding one would exhaust the pool; the spec only sanctions a
//      held lease under a single in-process worker, so we don't hold one). A
//      poison input maps to null (see openai.ts) and is dead-lettered, never
//      failing the pass.
//   5. INSERT … SELECT … WHERE EXISTS(live turn) … ON CONFLICT DO NOTHING — the
//      UNIQUE index (0010) is the crash-/double-claim fence; the WHERE EXISTS
//      closes the claim→embed-off-lock→insert race against a concurrent replace
//      (which hard-deletes the turn + its orphan vectors in one txn) so the
//      worker can't resurrect an embedding for an already-deleted turn.
//
// The scheduler is a debounce with a MAX-WAIT CAP: a burst of commits coalesces
// into one pass, but any turn that has waited >= maxWaitMs is embedded regardless
// of later chunks, holding the ticket's ~30-min upper bound on a continuously
// uploading session. When a pass fills its claim budget (more backlog remains),
// it re-arms IMMEDIATELY so a boot-time backfill drains to completion instead of
// stranding everything past the first batch.

import { scrubSecrets } from "./scrub";
import { EmbedAccountError, type Embedder } from "./openai";

type SqlClient = InstanceType<typeof Bun.SQL>;

export interface EmbedPassResult {
  /** Indexable turns with no vector that this pass claimed. */
  claimed: number;
  /** Distinct texts actually sent to OpenAI (the real embedding spend). */
  openaiTexts: number;
  /** OpenAI HTTP batch requests issued. */
  requests: number;
  /** Claimed turns served from a content_hash vector reuse (no OpenAI call). */
  reused: number;
  /** hx.embeddings rows newly inserted (post ON CONFLICT / WHERE EXISTS). */
  written: number;
  /** Claimed turns that produced NO vector this pass (OpenAI dead-lettered the
   *  input). The scheduler counts consecutive failures per turn and stops
   *  re-claiming one after a threshold, so a single poison input can't stall the
   *  pass forever. */
  failedIds: string[];
}

export interface RunEmbedPassDeps {
  sql: SqlClient;
  embedder: Embedder;
  scrub?: (text: string) => string;
  /** Anti-join LIMIT per pass. */
  maxPerPass?: number;
  /** Max texts per OpenAI request. */
  batchSize?: number;
  /** Max concurrent OpenAI requests. */
  concurrency?: number;
  /** Turn ids the scheduler has dead-lettered — excluded from the claim so a
   *  permanently-unembeddable turn doesn't get re-claimed every pass. */
  excludeIds?: string[];
}

const DEFAULT_MAX_PER_PASS = 500;
const DEFAULT_BATCH_SIZE = 96;
const DEFAULT_CONCURRENCY = 2;
// A uuid that never exists — used as a single-element sentinel so the claim's
// `NOT IN (...)` exclusion list is never empty (keeps the query shape constant).
const NO_EXCLUDE_SENTINEL = "00000000-0000-0000-0000-000000000000";


function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded-concurrency runner — caps simultaneous OpenAI round trips in-process. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function emptyResult(): EmbedPassResult {
  return { claimed: 0, openaiTexts: 0, requests: 0, reused: 0, written: 0, failedIds: [] };
}

/** Run exactly one embed pass. Returns the spend/throughput counters (used by
 *  the boot scheduler's logging and by the test to assert OpenAI call counts). */
export async function runEmbedPass(deps: RunEmbedPassDeps): Promise<EmbedPassResult> {
  const { sql, embedder } = deps;
  const scrub = deps.scrub ?? scrubSecrets;
  const maxPerPass = deps.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const excludeIds = deps.excludeIds && deps.excludeIds.length > 0 ? deps.excludeIds : [NO_EXCLUDE_SENTINEL];

  // 0. GUARD — pgvector may be absent (the embeddings table ships via a gated
  // migration). Without it the claim's LEFT JOIN hx.embeddings would throw
  // "relation does not exist" every pass; no-op cleanly instead.
  const reg = (await sql`SELECT to_regclass('hx.embeddings') AS r`) as Array<{ r: string | null }>;
  if (!reg[0]?.r) return emptyResult();

  // 1. CLAIM — the schema-enforced anti-join (gate on kind, never text alone:
  // an empty tool row must not be claimed). Dead-lettered turns are excluded.
  // No lock is held past this read.
  const candidates = (await sql`
    SELECT t.id::text AS id, t.text AS text
    FROM hx.turns t
    LEFT JOIN hx.embeddings e ON e.owner_kind = 'turn' AND e.owner_id = t.id
    WHERE t.kind IN ('user_text', 'assistant_text')
      AND t.text IS NOT NULL
      AND t.deleted_at IS NULL
      AND e.owner_id IS NULL
      AND t.id::text NOT IN ${sql(excludeIds)}
    ORDER BY t.created_at, t.id
    LIMIT ${maxPerPass}
  `) as Array<{ id: string; text: string }>;

  if (candidates.length === 0) return emptyResult();

  // 2. SCRUB + hash (content_hash is over the SCRUBBED text).
  const prepared = candidates.map((c) => {
    const scrubbed = scrub(c.text);
    return { id: c.id, scrubbed, hash: sha256Hex(scrubbed) };
  });

  const uniqueHashes = [...new Set(prepared.map((p) => p.hash))];
  const textByHash = new Map<string, string>();
  for (const p of prepared) if (!textByHash.has(p.hash)) textByHash.set(p.hash, p.scrubbed);

  // 3. REUSE — vectors already stored under an identical content_hash AND the
  // SAME (model, dim). The (model, dim) predicate means a future model/width
  // change re-embeds rather than copying a stale-model vector. Conversational
  // text is mostly session-unique, so this rarely fires across sessions, but it
  // makes a re-embed within a pass free. Bun.SQL expands `IN ${sql(array)}` to a
  // parameterized list ($1,$2,…) — a bare `= ANY(${array})` would CSV-join the
  // array into a malformed literal.
  const reuseRows = (await sql`
    SELECT DISTINCT ON (content_hash) content_hash AS hash, embedding::text AS emb
    FROM hx.embeddings
    WHERE content_hash IN ${sql(uniqueHashes)}
      AND embedding IS NOT NULL
      AND model = ${embedder.model}
      AND dim = ${embedder.dimensions}
  `) as Array<{ hash: string; emb: string }>;
  const reuseByHash = new Map<string, string>(reuseRows.map((r) => [r.hash, r.emb]));

  // 4. EMBED the rest via OpenAI, off-lock, batched + concurrency-limited. A
  // null at an index is a poison input openai.ts could not embed even after
  // shrinking — it is dropped here and dead-lettered below, NOT inserted.
  const needHashes = uniqueHashes.filter((h) => !reuseByHash.has(h));
  const limiter = createLimiter(concurrency);
  const newByHash = new Map<string, number[]>();
  let openaiTexts = 0;
  let requests = 0;
  await Promise.all(
    chunk(needHashes, batchSize).map((batch) =>
      limiter(async () => {
        const texts = batch.map((h) => textByHash.get(h) ?? "");
        const vectors = await embedder.embed(texts);
        requests += 1;
        openaiTexts += texts.length;
        batch.forEach((h, i) => {
          const v = vectors[i];
          if (v && v.length > 0) newByHash.set(h, v);
        });
      }),
    ),
  );

  // 5. INSERT … WHERE EXISTS(live turn) … ON CONFLICT DO NOTHING. The unique
  // index is the write fence; the WHERE EXISTS closes the orphan-on-replace race.
  let written = 0;
  let reused = 0;
  const failedIds: string[] = [];
  for (const p of prepared) {
    const reuseLit = reuseByHash.get(p.hash);
    const fresh = newByHash.get(p.hash);
    const literal = reuseLit ?? (fresh ? vectorLiteral(fresh) : null);
    if (literal === null) {
      failedIds.push(p.id); // OpenAI dead-lettered this input — scheduler counts it.
      continue;
    }
    if (reuseLit) reused += 1;
    const inserted = (await sql`
      INSERT INTO hx.embeddings (owner_kind, owner_id, model, dim, embedding, content_hash)
      SELECT 'turn', ${p.id}::uuid, ${embedder.model}, ${embedder.dimensions}, ${literal}::vector, ${p.hash}
      WHERE EXISTS (SELECT 1 FROM hx.turns t WHERE t.id = ${p.id}::uuid AND t.deleted_at IS NULL)
      ON CONFLICT (owner_kind, owner_id) DO NOTHING
      RETURNING id
    `) as unknown[];
    written += inserted.length;
  }

  return { claimed: candidates.length, openaiTexts, requests, reused, written, failedIds };
}

// ── the booted worker (debounce + max-wait scheduler) ────────────────────────

export interface EmbedWorkerLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

export interface EmbedWorkerOptions {
  /** A DSN string, or a resolver (the cluster boots after main wires modules, so
   *  the dsn can be null at construction — resolved lazily on the first pass). */
  dsn: string | (() => string | null);
  embedder: Embedder;
  scrub?: (text: string) => string;
  /** Cap on the worker's OWN Bun.SQL pool (NOT the uncapped createHxDb handle). */
  dbMax?: number;
  concurrency?: number;
  batchSize?: number;
  maxPerPass?: number;
  /** Coalesce a burst of commits into one pass. */
  debounceMs?: number;
  /** Hard upper bound a waiting turn tolerates before a pass fires regardless. */
  maxWaitMs?: number;
  /** Poll interval while the DSN is not yet resolvable at boot. */
  dsnRetryMs?: number;
  dsnRetryLimit?: number;
  /** Consecutive per-turn embed failures before the turn is dead-lettered
   *  (excluded from future claims for this process lifetime). */
  deadLetterThreshold?: number;
  logger?: EmbedWorkerLogger;
}

export interface EmbedWorker {
  /** Begin the scheduler + kick a startup drain of any pre-existing backlog. */
  start(): void;
  /** Best-effort nudge that new indexable turns may have landed (debounced). */
  signal(): void;
  /** Run exactly one pass now (boot drain / tests). Resolves to its counters. */
  runOnce(): Promise<EmbedPassResult>;
  /** Stop the scheduler, await any in-flight pass, and close the DB handle. */
  stop(): Promise<void>;
}

const DEFAULT_DB_MAX = 4;
const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
const DEFAULT_DSN_RETRY_MS = 5_000;
const DEFAULT_DSN_RETRY_LIMIT = 60;
const DEFAULT_DEAD_LETTER_THRESHOLD = 5;

export function createEmbedWorker(options: EmbedWorkerOptions): EmbedWorker {
  const resolveDsn = typeof options.dsn === "function" ? options.dsn : () => options.dsn as string;
  const dbMax = options.dbMax ?? DEFAULT_DB_MAX;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const dsnRetryMs = options.dsnRetryMs ?? DEFAULT_DSN_RETRY_MS;
  const dsnRetryLimit = options.dsnRetryLimit ?? DEFAULT_DSN_RETRY_LIMIT;
  const effectiveMaxPerPass = options.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const deadLetterThreshold = options.deadLetterThreshold ?? DEFAULT_DEAD_LETTER_THRESHOLD;
  const logger = options.logger;

  // Dead-letter bookkeeping (in-process; resets on restart — a restart is the
  // operator's chance to retry after fixing the cause). `failCount` tracks
  // consecutive-pass failures per turn; once a turn crosses the threshold it
  // moves to `deadLetter` and is excluded from the claim.
  const failCount = new Map<string, number>();
  const deadLetter = new Set<string>();

  function applyDeadLetterBookkeeping(failedIds: string[]): void {
    const failed = new Set(failedIds);
    // Reset the count for any tracked turn that did NOT fail this pass (a
    // transient blip), so dead-lettering needs CONSECUTIVE failures.
    for (const id of [...failCount.keys()]) {
      if (!failed.has(id) && !deadLetter.has(id)) failCount.delete(id);
    }
    for (const id of failedIds) {
      if (deadLetter.has(id)) continue;
      const n = (failCount.get(id) ?? 0) + 1;
      if (n >= deadLetterThreshold) {
        deadLetter.add(id);
        failCount.delete(id);
        logger?.error("embed dead-letter: input unembeddable after retries", {
          turnId: id,
          attempts: n,
        });
      } else {
        failCount.set(id, n);
      }
    }
  }

  const passDeps = (sql: SqlClient): RunEmbedPassDeps => ({
    sql,
    embedder: options.embedder,
    scrub: options.scrub,
    maxPerPass: options.maxPerPass,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    excludeIds: [...deadLetter],
  });

  let sqlHandle: SqlClient | null = null;
  function ensureSql(): SqlClient | null {
    if (sqlHandle) return sqlHandle;
    const dsn = resolveDsn();
    if (!dsn) return null;
    sqlHandle = new Bun.SQL(dsn, { max: dbMax });
    return sqlHandle;
  }

  // Run one pass and fold its failures into the dead-letter bookkeeping. Shared
  // by the scheduler and runOnce so repeated manual passes converge identically.
  async function executePass(sql: SqlClient): Promise<EmbedPassResult> {
    const result = await runEmbedPass(passDeps(sql));
    applyDeadLetterBookkeeping(result.failedIds);
    return result;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  let oldestSignalAt: number | null = null;
  let dsnRetries = 0;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  function arm(immediate = false): void {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    if (oldestSignalAt === null) oldestSignalAt = Date.now();
    if (timer) clearTimeout(timer);
    const waited = Date.now() - oldestSignalAt;
    const delay = immediate ? 0 : Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
    timer = setTimeout(() => void tick(), delay);
  }

  // Returns whether the claim was full (more backlog remains to drain). The
  // re-arm decision is made by the CALLER, after `running` is back to false —
  // arming while `running` is still true only sets `rerun` and never schedules.
  async function runPass(sql: SqlClient): Promise<boolean> {
    let claimedFull = false;
    try {
      const result = await executePass(sql);
      claimedFull = result.claimed >= effectiveMaxPerPass;
      if (result.written > 0 || result.failedIds.length > 0) logger?.info?.("embed pass", { ...result });
    } catch (err) {
      // An EmbedAccountError (quota/auth) aborts the pass: nothing in it can
      // succeed, so we stop and retry on the next signal (e.g. after the
      // operator funds the account). Any other error is logged the same way.
      logger?.error("embed pass failed", {
        error: err instanceof Error ? err.message : String(err),
        account: err instanceof EmbedAccountError,
      });
    }
    return claimedFull;
  }

  async function tick(): Promise<void> {
    timer = null;
    if (stopped) return;
    const sql = ensureSql();
    if (!sql) {
      if (dsnRetries < dsnRetryLimit) {
        dsnRetries += 1;
        timer = setTimeout(() => void tick(), dsnRetryMs);
      }
      return;
    }
    dsnRetries = 0;
    running = true;
    oldestSignalAt = null;
    let claimedFull = false;
    const p = runPass(sql)
      .then((full) => {
        claimedFull = full;
      })
      .finally(() => {
        running = false;
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    await p;
    // `running` is now false, so arm() actually schedules. Re-arm IMMEDIATELY
    // when the claim was full (more backlog to drain) — this turns the boot kick
    // into a full drain instead of one batch — or when a signal arrived mid-pass.
    if (!stopped && (rerun || claimedFull)) {
      rerun = false;
      arm(claimedFull);
    }
  }

  return {
    start() {
      stopped = false;
      oldestSignalAt = Date.now();
      arm();
    },
    signal() {
      arm();
    },
    async runOnce() {
      const sql = ensureSql();
      if (!sql) return emptyResult();
      return executePass(sql);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Await the actual in-flight pass rather than truncating it on a fixed
      // timer, so we never close the DB handle out from under a live query.
      if (inFlight) await inFlight.catch(() => {});
      if (sqlHandle) {
        await sqlHandle.end().catch(() => {});
        sqlHandle = null;
      }
    },
  };
}
