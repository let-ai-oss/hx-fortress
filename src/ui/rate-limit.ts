// Rate buckets and lockout, and the two rules that shape both.
//
// RULE ONE — a lockout is never org-wide. Every counter is keyed on
// (login, remote-key), so an attacker who guesses at one account from one network
// cannot lock that account out for everybody else, and cannot lock out a
// colleague at all. The global term that does exist is a process-wide sign-in
// CEILING, which sheds load rather than denying a principal.
//
// RULE TWO — a remote is never hard-locked. Repeated failures buy an
// exponentially growing delay with a ceiling, not a permanent refusal: a
// permanent one is a denial-of-service an attacker can aim at the operator by
// failing on their behalf. `hx-fortress ui user reset` is the stated remedy for
// the case where the delay is not enough, and it clears state held in another
// process's memory by bumping the user's lockoutEpoch.
//
// Counters live in memory. They are hot — a flood touches them thousands of times
// a second — and users.json is the file `ui user disable` has to write; putting
// the two in one place would queue revocation behind an attack.

export interface BucketPolicy {
  limit: number;
  windowMs: number;
}

/** Every bucket the console meters, with the key each is stored under.
 *
 *  `asset` sits above a full cold load of the SPA (the shell plus every hashed
 *  chunk and font) so a first visit never trips it. `/healthz` is exempt entirely:
 *  a platform health check runs on its own schedule and must not be able to
 *  starve itself. The instance probe gets its own bucket because it answers
 *  before any session exists and is reachable from loopback alone. */
export const BUCKETS = {
  /** Keyed (login, remote-key). */
  signIn: { limit: 5, windowMs: 60_000 },
  /** Keyed remote-key. Separate from sign-in so a burst of one cannot exhaust
   *  the other's budget. */
  ssoEntry: { limit: 10, windowMs: 60_000 },
  /** Shared by setup-status GET and setup completion POST, keyed remote-key. */
  setup: { limit: 20, windowMs: 60_000 },
  /** Keyed remote-key. */
  asset: { limit: 300, windowMs: 60_000 },
  /** Keyed remote-key (loopback peers only ever reach it). */
  instanceProbe: { limit: 30, windowMs: 60_000 },
  /** Every write the console makes: service control and every command it asks
   *  the daemon for. Keyed remote-key. Low by design — these are operator
   *  gestures, and a rotation or an update is not something anyone does in a
   *  loop. */
  control: { limit: 30, windowMs: 60_000 },
  /** The shared budget for the read class's enumerated store operations. A read
   *  route that reaches the object store is still a read, but it is the one that
   *  can be made to cost money and latency from outside. */
  storeOp: { limit: 60, windowMs: 60_000 },
  /** The read routes that leave a record of themselves. Keyed remote-key. Each
   *  call appends to `hx.admin_audit`, which no role holds DELETE on and nothing
   *  sweeps — so an unmetered one lets a READONLY session grow the embedded
   *  Postgres without bound and without an operator remedy short of dropping the
   *  database. Generous, because these are legitimate operator exports. */
  auditedRead: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, BucketPolicy>;

export type BucketName = keyof typeof BUCKETS;

/** Process-wide sign-in ceiling: load shedding above every per-principal budget,
 *  so a distributed flood cannot convert "one attempt per source" into unbounded
 *  work for the box. */
export const GLOBAL_SIGN_IN_CEILING: BucketPolicy = { limit: 120, windowMs: 60_000 };

export type BucketVerdict = { ok: true } | { ok: false; retryAfterMs: number };

interface CountingWindow {
  start: number;
  count: number;
}

/** Fixed windows, not a token bucket: the console needs a Retry-After it can
 *  state honestly, and a window boundary is one. */
export class RateLimiter {
  private readonly windows = new Map<string, CountingWindow>();

  take(bucket: BucketName, key: string, now = Date.now()): BucketVerdict {
    return this.takeWith(`${bucket}:${key}`, BUCKETS[bucket], now);
  }

  takeGlobalSignIn(now = Date.now()): BucketVerdict {
    return this.takeWith("global:signIn", GLOBAL_SIGN_IN_CEILING, now);
  }

  private takeWith(key: string, policy: BucketPolicy, now: number): BucketVerdict {
    const window = this.windows.get(key);
    if (!window || now - window.start >= policy.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (window.count < policy.limit) {
      window.count += 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: policy.windowMs - (now - window.start) };
  }

  /** Drop windows that have expired. Called on the server's sweep timer; without
   *  it a wide flood leaves one entry per source forever. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    const longest = Math.max(
      ...Object.values(BUCKETS).map((b) => b.windowMs),
      GLOBAL_SIGN_IN_CEILING.windowMs,
    );
    for (const [key, window] of this.windows) {
      if (now - window.start >= longest) {
        this.windows.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.windows.size;
  }
}

// -- Lockout -----------------------------------------------------------------

/** Failures before the delay starts growing. Below it, a mistyped password costs
 *  nothing but the argon2 verify. */
export const LOCKOUT_FREE_ATTEMPTS = 5;
export const LOCKOUT_BASE_MS = 1_000;
/** The ceiling. Deliberately survivable: this is a delay, never a wall. */
export const LOCKOUT_MAX_MS = 15 * 60_000;
/** How long a failure stays "recent" — for the delay, and for the argon gate's
 *  reserved slot. */
export const FAILURE_MEMORY_MS = 30 * 60_000;

interface FailureRecord {
  failures: number;
  lastAt: number;
  lockedUntil: number;
  /** The user's lockoutEpoch when this record was written. A record below the
   *  stored epoch is dropped — that is how `ui user reset` clears a lockout held
   *  in a different process's memory. */
  epoch: number;
}

export type LockoutState =
  | { locked: false; failures: number }
  | { locked: true; failures: number; retryAfterMs: number };

export interface LockoutSnapshot {
  entries: Array<[string, FailureRecord]>;
}

export class LockoutTable {
  private readonly records = new Map<string, FailureRecord>();
  private readonly recentByRemote = new Map<string, number>();

  private static key(login: string, remoteKey: string): string {
    return `${login} ${remoteKey}`;
  }

  /** Reads the CURRENT epoch from the user record on every call: a record written
   *  before the last `ui user reset` is dropped rather than consulted. */
  state(login: string, remoteKey: string, lockoutEpoch: number, now = Date.now()): LockoutState {
    const key = LockoutTable.key(login, remoteKey);
    const record = this.records.get(key);
    if (!record) return { locked: false, failures: 0 };
    if (record.epoch < lockoutEpoch || now - record.lastAt > FAILURE_MEMORY_MS) {
      this.records.delete(key);
      return { locked: false, failures: 0 };
    }
    return record.lockedUntil > now
      ? { locked: true, failures: record.failures, retryAfterMs: record.lockedUntil - now }
      : { locked: false, failures: record.failures };
  }

  recordFailure(
    login: string,
    remoteKey: string,
    lockoutEpoch: number,
    now = Date.now(),
  ): LockoutState {
    const key = LockoutTable.key(login, remoteKey);
    const current = this.state(login, remoteKey, lockoutEpoch, now);
    const failures = current.failures + 1;
    const over = failures - LOCKOUT_FREE_ATTEMPTS;
    const delay = over <= 0 ? 0 : Math.min(LOCKOUT_BASE_MS * 2 ** (over - 1), LOCKOUT_MAX_MS);
    this.records.set(key, { failures, lastAt: now, lockedUntil: now + delay, epoch: lockoutEpoch });
    this.recentByRemote.set(remoteKey, now);
    return delay > 0 ? { locked: true, failures, retryAfterMs: delay } : { locked: false, failures };
  }

  recordSuccess(login: string, remoteKey: string): void {
    this.records.delete(LockoutTable.key(login, remoteKey));
  }

  /** A remote with no failure in living memory. The argon gate keeps a slot for
   *  exactly these, so a genuine sign-in gets through a flood. */
  isClean(remoteKey: string, now = Date.now()): boolean {
    const last = this.recentByRemote.get(remoteKey);
    return last === undefined || now - last > FAILURE_MEMORY_MS;
  }

  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [key, record] of this.records) {
      if (now - record.lastAt > FAILURE_MEMORY_MS) {
        this.records.delete(key);
        dropped += 1;
      }
    }
    for (const [key, at] of this.recentByRemote) {
      if (now - at > FAILURE_MEMORY_MS) this.recentByRemote.delete(key);
    }
    return dropped;
  }

  /** Periodically persisted by the server so a restart does not hand an attacker
   *  a clean slate. Carries no secret — logins, addresses and counts only. */
  snapshot(): LockoutSnapshot {
    return { entries: [...this.records.entries()] };
  }

  hydrate(snapshot: LockoutSnapshot, now = Date.now()): void {
    for (const [key, record] of snapshot.entries) {
      if (now - record.lastAt > FAILURE_MEMORY_MS) continue;
      this.records.set(key, record);
      const remoteKey = key.split(" ")[1];
      if (remoteKey) this.recentByRemote.set(remoteKey, record.lastAt);
    }
  }

  get size(): number {
    return this.records.size;
  }
}
