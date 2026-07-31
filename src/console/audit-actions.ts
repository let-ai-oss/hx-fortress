// The action vocabulary, and what may be recorded alongside each act.
//
// Its own module because three consumers need it and only one of them runs on a
// server: the writers name their acts from here, and the console's disabled-
// window markers key on the two enablement transitions. A browser bundle that
// reached these constants through the spool WRITER would pull the filesystem in
// with them.

import { redactCredentials } from "../ui/redact";

// ── The action vocabulary ────────────────────────────────────────────────────
// Every writer names its acts from here, because the console filters, the
// disabled-window markers and the retrofit tests all key on these strings.

export const AUDIT_ACTIONS = {
  signIn: "console.signin",
  signInFailed: "console.signin.failed",
  signOut: "console.signout",
  setupOpened: "console.setup.opened",
  setupFailed: "console.setup.failed",
  setupCompleted: "console.setup.completed",
  ssoExchange: "console.sso.exchange",
  ssoExchangeFailed: "console.sso.exchange.failed",
  /** ONE marker when a window produced more distinct failure records than the
   *  per-window ceiling allows. */
  authOverflow: "console.auth.overflow",
  /** Prefix; the export's own name completes it. */
  exportPrefix: "console.export.",
  exportOverflow: "console.export.overflow",
  /** The CLI reclaimed its own oldest files to stay inside the cap. */
  spoolReclaimed: "console.spool.reclaimed",
  /** A drained record disagrees with the one already in the table. */
  integrityError: "console.audit.integrity_error",
  /** A terminal command row no daemon record agrees with. */
  commandDisputed: "console.command.disputed",
  cliEnable: "cli.ui.enable",
  cliDisable: "cli.ui.disable",
  cliPrefix: "cli.ui.",
} as const;

/**
 * The per-action parameter allowlist.
 *
 * Longest matching PREFIX wins, and an action with no entry records no
 * parameters at all. That direction is deliberate: a new act that forgets to
 * declare its parameters loses them from the trail, where the other direction
 * would put whatever it happened to pass — a password, a DSN, a setup token —
 * into a table with no DELETE.
 */
const PARAM_ALLOWLIST: Record<string, readonly string[]> = {
  "console.signin": ["login", "role", "remote", "attempts", "from", "to", "workbenchSub"],
  "console.signout": ["login", "role"],
  "console.setup": ["login", "role", "remote", "attempts", "from", "to"],
  "console.sso": ["org", "workbenchSub", "remote", "attempts", "from", "to"],
  "console.auth.overflow": ["ceiling", "windows", "from", "to"],
  "console.export.": ["format", "generatedAt", "from", "to", "action", "actor", "origin", "module", "level", "lines", "acknowledgedAt", "session", "sessionId", "family", "verdict"],
  "console.export.overflow": ["ceiling", "day", "session"],
  "console.spool.reclaimed": ["files", "records", "from", "to", "bytes"],
  "console.audit.integrity_error": ["spoolFileId", "seq", "field"],
  "console.command.disputed": ["commandKind", "arm", "expectedDigest", "records"],
  "console.command.outcome": ["commandKind", "terminalStatus", "resultDigest", "accepted", "transition", "reason"],
  "cli.ui.": ["login", "role", "key", "value", "phrase", "sessionEpoch", "state"],
  "system.": ["engine", "kind", "count", "reason", "from", "to"],
};

/** Key names that never reach the spool whatever an action declares. The
 *  allowlist already excludes them; this is the belt that survives an edit to
 *  the allowlist made in a hurry. */
const SECRET_KEYS = /pass|secret|token|credential|dsn|databaseurl|hash|key$|apikey/i;

/** Longest value a parameter may carry. A record is evidence, not a payload. */
const MAX_PARAM_CHARS = 200;

export function sanitizeParams(
  action: string,
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!params) return null;
  let allowed: readonly string[] = [];
  let matched = -1;
  for (const [prefix, keys] of Object.entries(PARAM_ALLOWLIST)) {
    if (action.startsWith(prefix) && prefix.length > matched) {
      matched = prefix.length;
      allowed = keys;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.includes(key) || SECRET_KEYS.test(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = redactCredentials(value).slice(0, MAX_PARAM_CHARS);
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}
