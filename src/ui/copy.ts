// Console copy that has to be identical everywhere it appears.
//
// The disclosure below is the D5 people-visibility statement. It prints before
// EVERY setup URL and every console URL the CLI emits — one constant, so the
// wizard, `ui user create`, `ui user reset` and `hx-fortress ui` cannot drift
// into four differently-honest versions of the same warning. A test asserts they
// are byte-identical.
//
// What it has to say is uncomfortable and says it anyway: a console login is not
// an organization membership, and the views behind it are people-keyed.

export const PEOPLE_VISIBILITY_DISCLOSURE: readonly string[] = [
  "Before you hand out access to this console, read what it grants:",
  "  Anyone who signs in to this console can see people data for this organization -",
  "  who is enrolled, what each person's activity looks like, session titles (which",
  "  may quote a first message) and where sessions were stored. Never transcript bodies.",
  "  Console logins are created here, on this host, by whoever has a shell on it.",
  "  They are not organization memberships, and the people holding them need not be",
  "  members of your organization.",
];

/** Printed under a setup URL. States the two properties the recipient needs to
 *  act on: it is one-time, and it dies on its own. */
export const SETUP_LINK_NOTE: readonly string[] = [
  "The link works once and expires in 24 hours. It carries no password — the person",
  "who opens it sets their own. Re-issue it with `hx-fortress ui user reset <login>`.",
];

/** The sign-in page's recovery guidance. Deliberately names the CLI verb: the
 *  person who is locked out cannot fix it, and the person who can needs to be
 *  told exactly what to run. */
export const SIGN_IN_RECOVERY_COPY =
  "Forgot your password, or locked out? Ask an administrator to run " +
  "`hx-fortress ui user reset <login>` on the fortress host — it sends you a fresh setup link.";

/** One answer for every failed sign-in. Naming the cause — unknown login, wrong
 *  password, disabled account — would answer "does this account exist?" for
 *  anyone who asks. */
export const SIGN_IN_FAILURE_COPY = "That login and password did not match.";

/** What a readonly account is told when it reaches a mutating route, and what
 *  its disabled controls say in the browser. One string, because a button whose
 *  tooltip disagrees with the server's refusal teaches the reader to distrust
 *  both. */
export const READONLY_REFUSAL_COPY =
  "this account is read-only; ask an administrator for an operator login";

/** Shown while a lockout delay is in force. Says nothing about whether the login
 *  exists, so it cannot be used to enumerate accounts either. */
export const LOCKOUT_COPY =
  "Too many attempts from this network. Wait a moment and try again, or ask an " +
  "administrator to run `hx-fortress ui user reset <login>`.";

/** `ui disable` against a console with no unit and no supervisor to tell. */
export function foregroundDisableRefusal(pid: number): string {
  return (
    `this console is running in the foreground — stop it with Ctrl-C, or \`kill ${pid}\`. ` +
    `\`ui disable\` flips the stored setting and stops a SERVICE; there is no service here to stop.`
  );
}

/** `ui disable` where enablement comes from the environment, which no file write
 *  can override. */
export const ENV_ENABLED_DISABLE_REFUSAL =
  "enabled by FORTRESS_UI_ENABLE — unset it on the service and redeploy. " +
  "Writing `enabled: false` here would change nothing: the environment wins, and the " +
  "supervisor would keep the console up.";

/** What `ui disable` prints once it has actually done it. */
export const DISABLE_PROPAGATION_NOTE =
  "The workbench button disappears on the next tunnel reconnect (or daemon restart).";

/** `ui sso on` before the console is enabled. Two arms: a host installs a unit, a
 *  container has no unit to install. */
export function ssoRequiresEnablement(container: boolean): string {
  return container
    ? "the console is not enabled — set FORTRESS_UI_ENABLE=1 on the service and redeploy, then run this again"
    : "the console is not enabled — run `hx-fortress ui --install-service` first, then run this again";
}
