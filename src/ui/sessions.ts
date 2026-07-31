// Console sessions: in the serving process's memory, and nowhere else.
//
// That choice decides several things at once. A restart revokes everything, which
// is the honest behaviour for a process whose whole state is memory. Nothing on
// disk can be stolen and replayed. And revocation from ANOTHER process — the CLI
// disabling a user, deleting one, or resetting their password — cannot be a
// method call, so it rides EPOCHS instead: every session records the epochs it
// was issued under, and per-request revalidation re-reads users.json and drops
// any session whose epochs have moved.
//
// TRANSPORT IS PINNED to the x-fortress-ui-token request header, never a cookie.
// A cookie is attached by the browser to every request the attacker can cause,
// which is what makes CSRF a category; a header the app sets explicitly is not.
//
// The browser medium is PINNED to sessionStorage, per tab. localStorage would
// widen an XSS from "read this tab" to "read every tab, forever". The visible
// consequence is that a second tab signs in again, and the sign-in copy says so.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { UiRole, UiUser, UsersFile } from "./users";

/** The only medium the console accepts a session on. */
export const SESSION_HEADER = "x-fortress-ui-token";

export interface UiSession {
  id: string;
  userLogin: string;
  role: UiRole;
  createdAt: number;
  lastSeenAt: number;
  remoteAddr: string;
  /** The workbench identity that opened the tab, when the arrival carried a
   *  verified SSO entry. Recorded for audit annotation; it conveys no capability. */
  workbenchSub: string | null;
  /** Epochs captured at issue. A later bump invalidates this session. */
  sessionEpoch: number;
  credentialEpoch: number;
  pwdVersion: number;
}

export interface SessionPolicy {
  ttlHours: number;
  idleMinutes: number;
}

export type SessionCheck =
  | { ok: true; session: UiSession; user: UiUser }
  | { ok: false; reason: SessionRefusal };

export type SessionRefusal =
  | "no-token"
  | "unknown-session"
  | "expired"
  | "idle"
  | "user-gone"
  | "user-disabled"
  | "credentials-changed"
  | "revoked";

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class SessionTable {
  /** Keyed by token digest, so a table dump is not a set of live tokens. */
  private readonly byDigest = new Map<string, UiSession>();

  issue(args: {
    user: UiUser;
    file: UsersFile;
    remoteAddr: string;
    workbenchSub?: string | null;
    now?: number;
  }): { token: string; session: UiSession } {
    const now = args.now ?? Date.now();
    const token = randomBytes(32).toString("base64url");
    const session: UiSession = {
      id: randomBytes(16).toString("hex"),
      userLogin: args.user.login,
      role: args.user.role,
      createdAt: now,
      lastSeenAt: now,
      remoteAddr: args.remoteAddr,
      workbenchSub: args.workbenchSub ?? null,
      sessionEpoch: args.file.sessionEpoch,
      credentialEpoch: args.user.credentialEpoch,
      pwdVersion: args.user.pwdVersion,
    };
    this.byDigest.set(digestOf(token), session);
    return { token, session };
  }

  /**
   * Per-REQUEST revalidation. `file` is the CURRENT users.json (the caller's
   * mtime-gated read) — caching the user record at sign-in would mean a disabled
   * account keeps working until its session happens to expire.
   */
  validate(
    token: string | null,
    file: UsersFile,
    policy: SessionPolicy,
    now = Date.now(),
  ): SessionCheck {
    if (!token) return { ok: false, reason: "no-token" };
    const digest = digestOf(token);
    let session: UiSession | undefined;
    let key: string | undefined;
    for (const [candidate, value] of this.byDigest) {
      if (digestsEqual(candidate, digest)) {
        session = value;
        key = candidate;
        break;
      }
    }
    if (!session || !key) return { ok: false, reason: "unknown-session" };

    if (now - session.createdAt >= policy.ttlHours * 3_600_000) {
      this.byDigest.delete(key);
      return { ok: false, reason: "expired" };
    }
    if (now - session.lastSeenAt >= policy.idleMinutes * 60_000) {
      this.byDigest.delete(key);
      return { ok: false, reason: "idle" };
    }
    if (session.sessionEpoch < file.sessionEpoch) {
      this.byDigest.delete(key);
      return { ok: false, reason: "revoked" };
    }

    const user = file.users.find((u) => u.login === session.userLogin);
    if (!user || user.deletedAt) {
      this.byDigest.delete(key);
      return { ok: false, reason: "user-gone" };
    }
    if (user.disabledAt) {
      this.byDigest.delete(key);
      return { ok: false, reason: "user-disabled" };
    }
    if (user.credentialEpoch > session.credentialEpoch || user.pwdVersion > session.pwdVersion) {
      this.byDigest.delete(key);
      return { ok: false, reason: "credentials-changed" };
    }

    // The role is re-read too: an account whose role changed must not keep the
    // capability its session was issued with.
    session.role = user.role;
    session.lastSeenAt = now;
    return { ok: true, session, user };
  }

  list(): UiSession[] {
    return [...this.byDigest.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revoke(id: string): boolean {
    for (const [digest, session] of this.byDigest) {
      if (session.id === id) {
        this.byDigest.delete(digest);
        return true;
      }
    }
    return false;
  }

  revokeUser(login: string): number {
    let revoked = 0;
    for (const [digest, session] of this.byDigest) {
      if (session.userLogin === login) {
        this.byDigest.delete(digest);
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeAll(): number {
    const count = this.byDigest.size;
    this.byDigest.clear();
    return count;
  }

  /** Drop sessions past either budget. The server runs this on its sweep timer so
   *  an abandoned tab does not hold a row until the process exits. */
  sweep(policy: SessionPolicy, now = Date.now()): number {
    let dropped = 0;
    for (const [digest, session] of this.byDigest) {
      const expired = now - session.createdAt >= policy.ttlHours * 3_600_000;
      const idle = now - session.lastSeenAt >= policy.idleMinutes * 60_000;
      if (expired || idle) {
        this.byDigest.delete(digest);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.byDigest.size;
  }
}

/** What the sign-in page says about both budgets and about the per-tab medium.
 *  Single-sourced so the copy and the enforcement cannot drift. */
export function sessionCopy(policy: SessionPolicy): string {
  return (
    `Signed-in sessions last ${policy.ttlHours} hours, or ${policy.idleMinutes} minutes idle, ` +
    `and are held per browser tab — a second tab signs in again.`
  );
}
