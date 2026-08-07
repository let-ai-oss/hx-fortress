// Component G scheduler — the guarantor's boot-drain + hourly sweep loop.
//
// Wraps reconcileOrphans() in a single-flight background scheduler:
//   • one BOOT-DRAIN pass shortly after start (drains the row-less backlog and,
//     on that first pass only, backfills existing fallback/empty titles), then
//   • an HOURLY sweep — the safety net so a canonical can never durably stay
//     row-less if a future best-effort ingest mirror silently fails.
//
// ON BY DEFAULT. The kill-switch is INVERTED (`FORTRESS_GUARANTOR_DISABLED`)
// because parseBooleanEnv is false-when-unset — so an unset/blank env means the
// guarantor runs. Set FORTRESS_GUARANTOR_DISABLED=1 to turn it off.
//
// db/store are resolved lazily (the same late-bound handles main.ts hands the
// gateway), so the scheduler is safe to construct before Postgres/the vault are
// ready; a tick that finds either not-ready simply reschedules soon.

import { sanitizeDbError } from "../host/postgres/sanitize";
import { parseBooleanEnv } from "../env";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";
import { reconcileOrphans, type ReconcileOptions, type ReconcileResult } from "./reconciler";

export interface GuarantorLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface GuarantorConfig {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  logger?: GuarantorLogger;
  /** Delay before the first (boot-drain) pass, ms. Default 30s. */
  bootDelayMs?: number;
  /** Interval between sweeps, ms. Default 1h. */
  intervalMs?: number;
  /** Retry delay when db/store aren't ready yet, ms. Default 15s. */
  notReadyRetryMs?: number;
  /** Coalesce a burst of known-failure signals into one soon-ish pass. Default 30s. */
  signalDebounceMs?: number;
  /** Ignore a failure signal within this window of the last COMPLETED pass, so a
   *  sustained failure stream can't drive a full bucket scan every debounce.
   *  The hourly sweep still bounds healing latency. Default 5m. */
  signalCooldownMs?: number;
  /** Run the one-time title corrective backfill over existing fallback/empty
   *  rows on the boot-drain. Opt-in (default false) — it re-reads every such
   *  canonical, and G's restore cascade already gives orphans their real title. */
  correctExistingTitles?: boolean;
  /** Pacing / caps handed to each reconcile pass. */
  reconcile?: Pick<
    ReconcileOptions,
    | "batchDelayMs"
    | "maxOrphans"
    | "repairStaleIndexes"
    | "staleRepairCeiling"
    | "deepVerifyPerPass"
  >;
}

export interface Guarantor {
  start(): void;
  stop(): Promise<void>;
  /** Nudge a pass soon after a known ingest-mirror failure. ORDINARY variant:
   *  remote-influenceable (cloud RPCs can drive signalReconcile), so it is
   *  governed by max(debounce, cooldown-remaining) — a sustained failure
   *  stream can never drive back-to-back full bucket scans. Never dropped:
   *  a cooldown arrival is DEFERRED past the cooldown, not lost. */
  signal(): void;
  /** URGENT variant — fed ONLY by guarded-db's first probe success after a
   *  pool rebuild (internal, never remote): the orphan backlog that outage
   *  just created should heal in ~debounce, not at the next hourly sweep.
   *  Idle ⇒ schedule(debounce) IGNORING the cooldown; in-flight ⇒ latch (the
   *  pass's finally schedules debounce instead of the hourly interval). */
  signalUrgent(): void;
  /** Run one pass synchronously (tests / manual trigger); null if not ready. */
  runOnce(): Promise<ReconcileResult | null>;
}

const DEFAULT_BOOT_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Sweep interval override (ms): set-but-empty OR 0 ⇒ the default — the env is
 *  a tuning knob, never a disable switch (FORTRESS_GUARANTOR_DISABLED exists
 *  for that). */
export function guarantorIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_GUARANTOR_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_INTERVAL_MS;
}
const DEFAULT_NOT_READY_RETRY_MS = 15_000;
const DEFAULT_SIGNAL_DEBOUNCE_MS = 30_000;
const DEFAULT_SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;

/** True unless the operator set FORTRESS_GUARANTOR_DISABLED to a truthy value. */
export function guarantorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !parseBooleanEnv(env.FORTRESS_GUARANTOR_DISABLED);
}

export function createGuarantor(cfg: GuarantorConfig): Guarantor {
  const bootDelay = cfg.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS;
  const interval = cfg.intervalMs ?? guarantorIntervalMs();
  const notReadyRetry = cfg.notReadyRetryMs ?? DEFAULT_NOT_READY_RETRY_MS;
  const signalDebounce = cfg.signalDebounceMs ?? DEFAULT_SIGNAL_DEBOUNCE_MS;
  const signalCooldown = cfg.signalCooldownMs ?? DEFAULT_SIGNAL_COOLDOWN_MS;
  const correctTitles = cfg.correctExistingTitles ?? false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = Infinity;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  // Set when a failure signal has already armed a soon pass — so a burst of
  // signals collapses to one pass instead of continually resetting the timer.
  let signalPending = false;
  // Urgent latch: a guarded-db recovery signal that arrived while a pass was
  // in flight — consumed by that pass's finally (debounce instead of interval)
  // and cleared when the next pass starts.
  let urgentLatch = false;
  // When the last pass completed, so a signal cooldown can bound full-bucket
  // scans under a sustained failure stream (0 = no pass has finished yet).
  let lastPassEndAt = 0;
  // The title-correction backfill is a one-time job (new rows get their title at
  // ingest time), so run it on the boot-drain pass only — not every hourly sweep.
  let firstPass = true;

  // Min-wins arming: never replace an armed SOONER pass with a later one (the
  // old unconditional clearTimeout let an hourly reschedule silently push out
  // an already-armed urgent debounce).
  const schedule = (ms: number): void => {
    if (stopped) return;
    const dueAt = Date.now() + ms;
    if (timer && timerDueAt <= dueAt) return;
    if (timer) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = null;
      timerDueAt = Infinity;
      void tick();
    }, ms);
  };

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    signalPending = false; // this pass consumes any armed signal.
    urgentLatch = false; // …and any armed urgent one.
    const db = cfg.db();
    const store = cfg.store();
    if (!db || !store) {
      schedule(notReadyRetry); // Postgres / the vault isn't up yet — retry soon.
      return;
    }
    inFlight = (async () => {
      try {
        const res = await reconcileOrphans(db, store, {
          batchDelayMs: cfg.reconcile?.batchDelayMs,
          maxOrphans: cfg.reconcile?.maxOrphans,
          repairStaleIndexes: cfg.reconcile?.repairStaleIndexes,
          deepVerifyPerPass: cfg.reconcile?.deepVerifyPerPass,
          staleRepairCeiling: cfg.reconcile?.staleRepairCeiling,
          correctExistingTitles: firstPass && correctTitles,
          logger: cfg.logger,
        });
        firstPass = false;
        cfg.logger?.info?.("guarantor: reconcile pass complete", { ...res });
      } catch (err) {
        // reconcileOrphans is non-throwing per session; this catches only a
        // whole-pass failure (e.g. the store enumeration threw). Retry next tick.
        cfg.logger?.warn?.("guarantor: reconcile pass failed", { err: sanitizeDbError(err) });
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
      lastPassEndAt = Date.now();
      // An urgent signal that arrived mid-pass pulls the next pass to the
      // debounce window (the outage's backlog is already known); otherwise
      // the ordinary sweep cadence resumes.
      schedule(urgentLatch ? signalDebounce : interval);
    }
  }

  return {
    start() {
      stopped = false;
      schedule(bootDelay);
    },
    signal() {
      // Pull the next pass in. Ignore while a pass is in flight (it'll observe
      // the new orphan) or one is already armed (no reset-storm under a burst
      // of failures). A cooldown arrival is DEFERRED past the cooldown rather
      // than dropped — max(debounce, cooldown-remaining) governs all ordinary
      // consumption, so a signal is never lost while full-bucket scans stay
      // bounded under a sustained failure stream.
      if (stopped || inFlight || signalPending) return;
      const cooldownRemaining =
        lastPassEndAt > 0 ? Math.max(0, signalCooldown - (Date.now() - lastPassEndAt)) : 0;
      signalPending = true;
      schedule(Math.max(signalDebounce, cooldownRemaining));
    },
    signalUrgent() {
      // Internal-only (guarded-db recovery): the cooldown exists to bound
      // REMOTE-drivable scan pressure, so a local recovery signal ignores it.
      if (stopped) return;
      if (inFlight) {
        urgentLatch = true;
        return;
      }
      schedule(signalDebounce);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timerDueAt = Infinity;
      // Let an in-flight pass finish rather than tearing the DB handle out from
      // under a live ingest transaction.
      if (inFlight) await inFlight.catch(() => {});
    },
    async runOnce() {
      const db = cfg.db();
      const store = cfg.store();
      if (!db || !store) return null;
      const res = await reconcileOrphans(db, store, {
        batchDelayMs: cfg.reconcile?.batchDelayMs,
        maxOrphans: cfg.reconcile?.maxOrphans,
        repairStaleIndexes: cfg.reconcile?.repairStaleIndexes,
        staleRepairCeiling: cfg.reconcile?.staleRepairCeiling,
        correctExistingTitles: firstPass && correctTitles,
        logger: cfg.logger,
      });
      firstPass = false;
      return res;
    },
  };
}
