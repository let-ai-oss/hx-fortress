// The console's authentication runtime: the choke point every request passes
// through, and the state that outlives a single request.
//
// It exists as one object because the pieces are only correct together. A rate
// bucket without a remote key that survives a proxy is decorative; a lockout
// without an epoch cannot be cleared from the CLI; an argon gate without the
// lockout table cannot tell a clean principal from a flood. Handlers registered
// by later tasks get a verdict, never the levers.
//
// Nothing here is cached across requests except by mtime: `ui config set` and
// `ui user disable` run in a different process, and the whole point of the live
// re-read is that they land without a restart.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sweepCmdCreds } from "../console/cmd-creds";
import { ArgonBusyError, ArgonGate } from "./argon-gate";
import { LiveUiConfig, effectiveUiEnabled, type UiConfig } from "./config";
import { buildHostAllowlist, checkHost, checkOrigin, type HostCheck } from "./origin";
import { RateLimiter, LockoutTable, type LockoutSnapshot } from "./rate-limit";
import { remoteKeyFor, normalizeAddress } from "./remote-key";
import { gate, requiresOrigin, RouteRegistry, type RouteSpec } from "./routes";
import { SESSION_HEADER, SessionTable, type SessionPolicy, type UiSession } from "./sessions";
import {
  LiveUsers,
  UsersStore,
  signInEligible,
  verifyPassword,
  type UiUser,
  type UsersFile,
} from "./users";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface UiRuntimeOptions {
  uiRoot: string;
  uiConfigFile: string;
  cmdCredsDir: string;
  env?: Record<string, string | undefined>;
  onWarn?: (message: string) => void;
  /** Injected in tests. */
  now?: () => number;
}

export type AuthVerdict =
  | { ok: true; route: RouteSpec | null; session: UiSession | null; user: UiUser | null; remoteKey: string }
  | { ok: false; status: 401 | 403 | 404 | 429 | 503; reason: string; retryAfterMs?: number };

export type SignInVerdict =
  | { ok: true; token: string; session: UiSession }
  | { ok: false; status: 401 | 429 | 503; reason: string; retryAfterMs?: number };

export class UiRuntime {
  readonly sessions = new SessionTable();
  readonly limiter = new RateLimiter();
  readonly lockouts = new LockoutTable();
  readonly argon = new ArgonGate();
  readonly routes = new RouteRegistry();
  readonly config: LiveUiConfig;
  readonly users: UsersStore;
  private readonly live: LiveUsers;
  private readonly options: UiRuntimeOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: UiRuntimeOptions) {
    this.options = options;
    this.config = new LiveUiConfig(options.uiConfigFile, options.onWarn);
    this.users = new UsersStore(path.join(options.uiRoot, "users.json"));
    this.live = new LiveUsers(this.users);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  readConfig(): Promise<UiConfig> {
    return this.config.read();
  }

  readUsers(): Promise<UsersFile> {
    return this.live.read();
  }

  static policyOf(config: UiConfig): SessionPolicy {
    return { ttlHours: config.sessionTtlHours, idleMinutes: config.sessionIdleMinutes };
  }

  /** The key every bucket and lockout counter is stored under. */
  remoteKey(req: Request, peer: string, config: UiConfig): string {
    return remoteKeyFor({
      peer,
      forwardedFor: req.headers.get("x-forwarded-for"),
      trustedProxies: config.trustedProxies,
    });
  }

  hostCheck(req: Request, config: UiConfig, boundPort: number): HostCheck {
    return checkHost(
      req.headers.get("host"),
      buildHostAllowlist({ bind: config.bind, port: boundPort, publicUrl: config.publicUrl }),
    );
  }

  /**
   * The gate. Order matters and is the security argument:
   *
   *   the rate bucket first (so a flood is cheap), the loopback rule next (the
   *   probe answers nobody else), then the session, then the role, then Origin.
   *
   * A 401 is returned for an unknown path as readily as for a known one, so the
   * response never confirms what the console has.
   */
  async authorize(req: Request, peer: string, boundPort: number): Promise<AuthVerdict> {
    const config = await this.readConfig();
    const url = new URL(req.url);
    const route = this.routes.lookup(req.method, url.pathname);
    const remoteKey = this.remoteKey(req, peer, config);

    if (route?.bucket) {
      const verdict = this.limiter.take(route.bucket, remoteKey, this.now());
      if (!verdict.ok) {
        return { ok: false, status: 429, reason: "too many requests", retryAfterMs: verdict.retryAfterMs };
      }
    }
    if (route?.loopbackOnly && !LOOPBACK_PEERS.has(normalizeAddress(peer))) {
      return { ok: false, status: 404, reason: "not found" };
    }

    let session: UiSession | null = null;
    let user: UiUser | null = null;
    if (route?.cls !== "public") {
      const check = this.sessions.validate(
        req.headers.get(SESSION_HEADER),
        await this.readUsers(),
        UiRuntime.policyOf(config),
        this.now(),
      );
      if (!check.ok) return { ok: false, status: 401, reason: "sign in to continue" };
      session = check.session;
      user = check.user;
    }

    const decision = gate({ method: req.method, path: url.pathname, route, role: session?.role ?? null });
    if (!decision.allow) return { ok: false, status: decision.status, reason: decision.reason };

    if (requiresOrigin(route, req.method)) {
      const host = this.hostCheck(req, config, boundPort);
      const origin = checkOrigin(req.headers.get("origin"), host);
      if (!origin.ok) return { ok: false, status: 403, reason: origin.reason };
    }

    return { ok: true, route, session, user, remoteKey };
  }

  /**
   * Sign in, uniformly.
   *
   * Every failure looks the same and costs the same: an unknown login, a disabled
   * one and a wrong password all run a real argon2id verify (against a dummy hash
   * where there is no real one) and return the same message. Anything else is an
   * account-enumeration oracle, in the response body or in the clock.
   */
  async signIn(args: {
    login: string;
    password: string;
    remoteKey: string;
    remoteAddr: string;
    workbenchSub?: string | null;
  }): Promise<SignInVerdict> {
    const now = this.now();
    const ceiling = this.limiter.takeGlobalSignIn(now);
    if (!ceiling.ok) {
      return { ok: false, status: 429, reason: "too many sign-in attempts right now", retryAfterMs: ceiling.retryAfterMs };
    }
    const bucket = this.limiter.take("signIn", `${args.login} ${args.remoteKey}`, now);
    if (!bucket.ok) {
      return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: bucket.retryAfterMs };
    }

    const file = await this.readUsers();
    const user = signInEligible(file, args.login);
    const lockoutEpoch = user?.lockoutEpoch ?? 0;
    const locked = this.lockouts.state(args.login, args.remoteKey, lockoutEpoch, now);
    if (locked.locked) {
      return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: locked.retryAfterMs };
    }

    const clean = this.lockouts.isClean(args.remoteKey, now);
    let matched: boolean;
    try {
      matched = await this.argon.run(args.remoteKey, clean, () =>
        // A null hash verifies against the dummy one and answers false, so an
        // unknown login costs exactly what a real one does — and it pays for a
        // gate slot, or it would be the one path a flood could take for free.
        verifyPassword(user?.pwdHash ?? null, args.password),
      );
    } catch (err) {
      if (err instanceof ArgonBusyError) {
        return { ok: false, status: 503, reason: err.message, retryAfterMs: 1_000 };
      }
      throw err;
    }

    if (!user || !matched) {
      this.lockouts.recordFailure(args.login, args.remoteKey, lockoutEpoch, now);
      return { ok: false, status: 401, reason: "sign-in failed" };
    }
    this.lockouts.recordSuccess(args.login, args.remoteKey);
    const issued = this.sessions.issue({
      user,
      file,
      remoteAddr: args.remoteAddr,
      workbenchSub: args.workbenchSub ?? null,
      now,
    });
    return { ok: true, token: issued.token, session: issued.session };
  }

  /** Setup completion also passes the argon gate: it hashes, and a hash is the
   *  expensive operation the gate exists to bound. */
  async completeSetup(token: string, password: string, remoteKey: string): Promise<UiUser> {
    return this.argon.run(remoteKey, this.lockouts.isClean(remoteKey, this.now()), () =>
      this.users.completeSetup(token, password, new Date(this.now())),
    );
  }

  /** True when the console may serve at all: the env var OR ui.json. */
  async enabled(): Promise<boolean> {
    return effectiveUiEnabled(await this.readConfig(), this.options.env ?? process.env);
  }

  // -- housekeeping ----------------------------------------------------------

  private get lockoutSnapshotFile(): string {
    return path.join(this.options.uiRoot, "lockouts.json");
  }

  async restoreLockouts(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.lockoutSnapshotFile, "utf8"));
      const snapshot = raw as LockoutSnapshot;
      if (Array.isArray(snapshot.entries)) this.lockouts.hydrate(snapshot, this.now());
    } catch {
      // No snapshot, or an unreadable one. Starting with empty counters is the
      // pre-existing behaviour, never a refusal to serve.
    }
  }

  /** Counters live in memory; this is the periodic copy so a restart does not
   *  hand an attacker a clean slate. Holds no secret. */
  async persistLockouts(): Promise<void> {
    await writeFile(this.lockoutSnapshotFile, `${JSON.stringify(this.lockouts.snapshot())}\n`, {
      mode: 0o600,
    }).catch(() => {});
  }

  /** Drops expired sessions and rate windows, and removes single-use command
   *  credentials whose command will never run — the console mints those, so the
   *  orphans are its own. */
  async sweep(): Promise<{ sessions: number; windows: number; lockouts: number; creds: number }> {
    const now = this.now();
    const config = await this.readConfig().catch(() => null);
    const sessions = config ? this.sessions.sweep(UiRuntime.policyOf(config), now) : 0;
    const swept = await sweepCmdCreds(this.options.cmdCredsDir, new Date(now)).catch(() => ({ deleted: [] }));
    const result = {
      sessions,
      windows: this.limiter.sweep(now),
      lockouts: this.lockouts.sweep(now),
      creds: swept.deleted.length,
    };
    await this.persistLockouts();
    return result;
  }

  startSweepTimer(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    // Housekeeping must never be the reason a foreground console refuses to exit.
    this.timer.unref?.();
  }

  stopSweepTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
