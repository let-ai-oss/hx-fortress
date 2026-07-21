// Pretty URLs — the path is the single source of truth for what the console
// shows. No query strings, no hashes: every stateful surface is a real,
// bookmarkable, semantically-named location.
//
//   /                                     Overview
//   /sessions                             metadata explorer
//   /sessions/by/person                   …grouped
//   /sessions/search/routing+gates        …searched
//   /sessions/claude-cli/59e3ccf5-8f8b    one session (its storage key)
//   /people/erik                          one person
//   /adoption                             roster vs reality
//   /adoption/by/coverage                 …grouped
//   /adoption/not-installed               …one cohort
//   /residency                            residency proof
//   /residency/gates                      …scrolled to the routing gates
//   /residency/incident                   …the incident preview
//   /compliance/egress                    posture, at the egress inventory
//   /postgres/failed-boot                 the failed-boot preview
//   /storage · /embeddings · /ops · /ops/keys
//   /logs/session_vault/errors/7d         source · level · range, any order
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
}

export const DEFAULT_ROUTE: Route = {
  view: "overview",
  sesGroup: "team", sesQuery: "",
  adGroup: "team", adQuery: "", adFilter: null,
  incident: false, pgPreview: false,
  logSrc: "all", logLevel: "all", logRange: "24h",
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
  const raw = pathname.split("/").filter(Boolean);
  const r: Route = { ...DEFAULT_ROUTE };
  if (!raw.length) return r;

  const head = raw[0];
  const rest = raw.slice(1);

  // A person is a first-class entity, not a sub-view of adoption.
  if (head === "people") {
    if (!rest[0]) return r;
    return { ...r, view: "person-detail", personId: decodeQ(rest[0]) };
  }

  const view = SEGMENT_VIEW[head];
  if (!view) return r;                    // unknown path → Overview
  r.view = view;

  if (view === "sessions") {
    let i = 0;
    while (i < rest.length) {
      const seg = rest[i];
      if (seg === "by" && rest[i + 1]) { r.sesGroup = SES_GROUP_KEY[rest[i + 1]] ?? r.sesGroup; i += 2; }
      else if (seg === "search" && rest[i + 1]) { r.sesQuery = decodeQ(rest[i + 1]); i += 2; }
      else if (rest[i + 1]) {              // family + id → a single session
        r.view = "session-detail"; r.family = seg; r.sid = decodeQ(rest[i + 1]); i += 2;
      } else i += 1;
    }
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

  for (const seg of rest) {
    if (view === "residency" && seg === "incident") r.incident = true;
    else if ((ANCHORS[view] ?? []).includes(seg)) r.anchor = seg;
  }
  return r;
}

// ── format ──────────────────────────────────────────────
export function formatPath(r: Route): string {
  const parts: string[] = [];

  if (r.view === "person-detail") return r.personId ? `/people/${encodeQ(r.personId)}` : "/adoption";

  if (r.view === "session-detail") {
    if (r.family && r.sid) return `/sessions/${r.family}/${encodeQ(r.sid)}`;
    return "/sessions";
  }

  const head = VIEW_SEGMENT[r.view];
  if (!head) return "/";
  parts.push(head);

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
  }

  return "/" + parts.join("/");
}
