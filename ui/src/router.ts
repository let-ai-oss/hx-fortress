// Pretty URLs — the path is the single source of truth for what the console
// shows. No query strings, no hashes: every stateful surface is a real,
// bookmarkable, semantically-named location. Dialogs included: a dialog is a
// thing you can be looking at, so it gets an address like everything else.
//
//   /                                     Overview
//   /sessions                             metadata explorer
//   /sessions/by/person                   …grouped
//   /sessions/search/routing+gates        …searched
//   /sessions/claude-cli/59e3ccf5-8f8b    one session (its storage key)
//   /sessions/claude-cli/59e3ccf5-8f8b/verify        …its residency proof
//   /residency/verify/claude-cli/59e3ccf5-8f8b       the same proof, from the audit
//   /people/erik                          one person
//   /adoption/by/coverage/not-installed   grouped + one cohort
//   /residency/gates · /residency/incident
//   /compliance/egress · /postgres/failed-boot · /ops/keys
//   /logs/session_vault/errors/7d         source · level · range, any order
//   …/shortcuts                           the keyboard map, over any page
//
// Vocabularies are disjoint per segment position, so nothing is ambiguous and
// defaults are simply omitted — the shortest URL that says what you mean.

export type ViewName =
  | "overview" | "sessions" | "session-detail" | "adoption" | "person-detail"
  | "residency" | "compliance" | "postgres" | "blob" | "embeddings" | "ops" | "logs";

export interface Route {
  view: ViewName;
  /** sessions explorer */
  sesGroup: string;            // team | person | project | repo | none
  sesQuery: string;
  family?: string;             // session detail: storage family…
  sid?: string;                // …and session id
  /** adoption */
  adGroup: string;             // team | group | coverage | status
  adQuery: string;
  adFilter: string | null;     // noclient | quiet | stale | partial | outdated
  personId?: string;
  /** teachable states */
  incident: boolean;
  pgPreview: boolean;
  /** panel the page should scroll to and flash */
  anchor?: string;             // gates | keys | egress | retention | audit
  /** logs */
  logSrc: string;              // all | host | session_vault | embed-worker | postgres | gateway
  logLevel: string;            // all | warn | error
  logRange: string;            // 1h | 24h | 7d | boot
  /** dialogs — overlays on the page beneath, so they nest under its path */
  verify: boolean;
  verifyFamily?: string;
  verifySid?: string;
  shortcuts: boolean;
}

export const DEFAULT_ROUTE: Route = {
  view: "overview",
  sesGroup: "team", sesQuery: "",
  adGroup: "team", adQuery: "", adFilter: null,
  incident: false, pgPreview: false,
  logSrc: "all", logLevel: "all", logRange: "24h",
  verify: false, shortcuts: false,
};

// ── vocabularies ────────────────────────────────────────
const VIEW_SEGMENT: Record<string, string> = {
  sessions: "sessions", adoption: "adoption", residency: "residency",
  compliance: "compliance", postgres: "postgres", blob: "storage",
  embeddings: "embeddings", ops: "ops", logs: "logs",
};
const SEGMENT_VIEW: Record<string, ViewName> = {
  sessions: "sessions", adoption: "adoption", residency: "residency",
  compliance: "compliance", postgres: "postgres", storage: "blob",
  embeddings: "embeddings", ops: "ops", logs: "logs",
};

const SES_GROUP_URL: Record<string, string> = { team: "team", person: "person", project: "project", repo: "repo", none: "newest" };
const SES_GROUP_KEY: Record<string, string> = { team: "team", person: "person", project: "project", repo: "repo", newest: "none" };

const AD_GROUPS = ["team", "group", "coverage", "status"];
const AD_FILTER_URL: Record<string, string> = { noclient: "not-installed", quiet: "quiet", stale: "gone-quiet", partial: "partial", outdated: "outdated" };
const AD_FILTER_KEY: Record<string, string> = { "not-installed": "noclient", quiet: "quiet", "gone-quiet": "stale", partial: "partial", outdated: "outdated" };

const ANCHORS: Record<string, string[]> = {
  residency: ["gates"], compliance: ["egress", "retention", "audit"], ops: ["keys"],
};

const LOG_SOURCES = ["host", "session_vault", "embed-worker", "postgres", "gateway"];
const LOG_LEVEL_URL: Record<string, string> = { warn: "warnings", error: "errors" };
const LOG_LEVEL_KEY: Record<string, string> = { warnings: "warn", errors: "error" };
const LOG_RANGES = ["1h", "24h", "7d", "boot"];

// Search terms ride in the path: spaces become "+", everything else is
// percent-encoded, so "a+b" and "a b" stay distinguishable both ways.
const encodeQ = (q: string) => encodeURIComponent(q).replace(/%20/g, "+");
const decodeQ = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));

// ── parse ───────────────────────────────────────────────
export function parsePath(pathname: string): Route {
  let raw = pathname.split("/").filter(Boolean).map(s => s);
  const r: Route = { ...DEFAULT_ROUTE };

  // The keyboard map overlays any page, so it is always the last segment.
  if (raw[raw.length - 1] === "shortcuts") { r.shortcuts = true; raw = raw.slice(0, -1); }
  if (!raw.length) return r;

  const head = raw[0];
  const rest = raw.slice(1);

  // A person is a first-class entity, not a sub-view of adoption.
  if (head === "people") {
    if (!rest[0]) return r;
    return { ...r, view: "person-detail", personId: decodeQ(rest[0]) };
  }

  const view = SEGMENT_VIEW[head];
  if (!view) return { ...r, shortcuts: r.shortcuts };   // unknown path → Overview
  r.view = view;

  if (view === "sessions") {
    let i = 0;
    while (i < rest.length) {
      const seg = rest[i];
      if (seg === "by" && rest[i + 1]) { r.sesGroup = SES_GROUP_KEY[rest[i + 1]] ?? r.sesGroup; i += 2; }
      else if (seg === "search" && rest[i + 1]) { r.sesQuery = decodeQ(rest[i + 1]); i += 2; }
      else if (seg === "verify") { r.verify = true; i += 1; }
      else if (rest[i + 1]) {              // family + id → a single session
        r.view = "session-detail"; r.family = seg; r.sid = decodeQ(rest[i + 1]); i += 2;
      } else i += 1;
    }
    // On a session's own page the proof is about that session — no need to
    // repeat the key in the path.
    if (r.verify && r.view === "session-detail") { r.verifyFamily = r.family; r.verifySid = r.sid; }
    else if (r.verify) r.verify = false;
    return r;
  }

  if (view === "adoption") {
    let i = 0;
    while (i < rest.length) {
      const seg = rest[i];
      if (seg === "by" && rest[i + 1]) { r.adGroup = AD_GROUPS.includes(rest[i + 1]) ? rest[i + 1] : r.adGroup; i += 2; }
      else if (seg === "search" && rest[i + 1]) { r.adQuery = decodeQ(rest[i + 1]); i += 2; }
      else { if (AD_FILTER_KEY[seg]) r.adFilter = AD_FILTER_KEY[seg]; i += 1; }
    }
    return r;
  }

  if (view === "logs") {
    for (const seg of rest) {
      if (LOG_SOURCES.includes(seg)) r.logSrc = seg;
      else if (LOG_LEVEL_KEY[seg]) r.logLevel = LOG_LEVEL_KEY[seg];
      else if (LOG_RANGES.includes(seg)) r.logRange = seg;
    }
    return r;
  }

  if (view === "postgres") {
    if (rest[0] === "failed-boot") r.pgPreview = true;
    return r;
  }

  let i = 0;
  while (i < rest.length) {
    const seg = rest[i];
    if (view === "residency" && seg === "incident") { r.incident = true; i += 1; }
    // Verifying from the audit names the session, because the page beneath
    // isn't about one.
    else if (seg === "verify" && rest[i + 1] && rest[i + 2]) {
      r.verify = true; r.verifyFamily = rest[i + 1]; r.verifySid = decodeQ(rest[i + 2]); i += 3;
    }
    else { if ((ANCHORS[view] ?? []).includes(seg)) r.anchor = seg; i += 1; }
  }
  return r;
}

// ── format ──────────────────────────────────────────────
export function formatPath(r: Route): string {
  const tail = r.shortcuts ? ["shortcuts"] : [];
  const done = (parts: string[]) => "/" + [...parts, ...tail].join("/");

  if (r.view === "person-detail") return r.personId ? done(["people", encodeQ(r.personId)]) : done(["adoption"]);

  if (r.view === "session-detail") {
    if (!r.family || !r.sid) return done(["sessions"]);
    const parts = ["sessions", r.family, encodeQ(r.sid)];
    if (r.verify) parts.push("verify");
    return done(parts);
  }

  const head = VIEW_SEGMENT[r.view];
  if (!head) return done([]);
  const parts = [head];

  if (r.view === "sessions") {
    if (r.sesGroup !== "team") parts.push("by", SES_GROUP_URL[r.sesGroup] ?? r.sesGroup);
    if (r.sesQuery.trim()) parts.push("search", encodeQ(r.sesQuery.trim()));
  } else if (r.view === "adoption") {
    if (r.adGroup !== "team") parts.push("by", r.adGroup);
    if (r.adFilter) parts.push(AD_FILTER_URL[r.adFilter]);
    if (r.adQuery.trim()) parts.push("search", encodeQ(r.adQuery.trim()));
  } else if (r.view === "logs") {
    if (r.logSrc !== "all") parts.push(r.logSrc);
    if (r.logLevel !== "all") parts.push(LOG_LEVEL_URL[r.logLevel]);
    if (r.logRange !== "24h") parts.push(r.logRange);
  } else if (r.view === "postgres") {
    if (r.pgPreview) parts.push("failed-boot");
  } else {
    if (r.view === "residency" && r.incident) parts.push("incident");
    if (r.anchor && (ANCHORS[r.view] ?? []).includes(r.anchor)) parts.push(r.anchor);
    if (r.verify && r.verifyFamily && r.verifySid) parts.push("verify", r.verifyFamily, encodeQ(r.verifySid));
  }

  return done(parts);
}
