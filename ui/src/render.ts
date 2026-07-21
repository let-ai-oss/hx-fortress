// @ts-nocheck — the prototype's innerHTML template literals, kept verbatim and
// parameterized only where they closed over globals. These strings are the
// rendered DOM; do not reflow, reword, or "clean up".
import { I } from "./icons";
import {
  FORT, PEOPLE, TEAM_ORDER, teamProjects, SESSIONS, GROWTH,
  plural, fmtInt, fmtMB, fmtTok, agoStr,
  TOTAL_SESSIONS, TOTAL_KB, N_ROSTER, N_INSTALLED, N_SENDING, COVERAGE_PCT,
  TOTAL_OBJECTS,
} from "./data";

// ── Overview: attention ─────────────────────────────────
export const ATTENTION = [
  { dot: "warn", b: "A device has been dark 9 days with 14 unsent sessions", sub: "erik-mbp (Erik Lindqvist) last seen Jul 12 — sessions queue safely on the device and send on reconnect", pill: ["warn", "Adoption"], act: { label: "Open", person: "erik" } },
  { dot: "warn", b: "1 repo looks like Orange Corp code but is unclaimed", sub: "<span class='mono'>orange-corp/rind</span> is attached to no project — its sessions route to personal spaces, not this fortress", pill: ["warn", "Routing"], act: { label: "Review", goto: "residency", then: "gates" } },
  { dot: "offd", b: "3 people don't have the <code class='hx'>hx</code> client", sub: "Lena Kraus, Felix Andersen, Rosa Jimenez — nothing from their machines reaches this fortress", pill: ["off", "Adoption"], act: { label: "See who", adfilter: "noclient" } },
  { dot: "offd", b: "6 devices run outdated clients", sub: "oldest 76.1.9 · current 76.2.4 — updates ship fixes to sync reliability", pill: ["off", "Hygiene"], act: { label: "See which", adfilter: "outdated" } },
];
export const attentionHtml = () =>
  ATTENTION.map((a, i) => `
      <div class="row"><span class="dot ${a.dot}"></span>
        <div class="who"><b>${a.b}</b><div class="sub">${a.sub}</div></div>
        <div><span class="pill ${a.pill[0]} pc">${a.pill[1]}</span></div>
        <div style="text-align:right"><button class="btn ghost sm" data-att="${i}">${a.act.label}</button></div>
      </div>`).join("");

// ── Sessions: cells + grouping ──────────────────────────
export const sesCellA = s => `<div class="cell cellA">
    <div class="cl l1"><span class="ico">${I.folder}</span><span class="tx ttl">${s.title}</span></div>
    <div class="cl l2"><span class="ico">${I.branch}</span><span class="tx">${s.repo}</span><span class="tx">· ${s.family}</span></div>
  </div>`;
export const sesCellB = s => `<div class="cell cellB">
    <div class="cl l1"><span class="ico">${I.person}</span><span class="tx personlink" data-person="${s.person.id}">${s.person.name}</span></div>
    <div class="cl l2"><span class="ico">${I.project}</span><span class="tx">${s.project} · ${s.person.team}</span></div>
  </div>`;
export const sesCellC = s => `<div class="cell cellC">${fmtMB(s.kb)} · ${agoStr(s.minsAgo)}</div>`;

export const SES_GLBL = { team: "Team", person: "Person", project: "Project", repo: "Git repo", none: "Newest first" };
export function sesGroupsFor(list, sesGroup) {
  if (sesGroup === "none") return [{ title: "Newest first", items: list }];
  const keyFn = sesGroup === "team" ? s => s.person.team
    : sesGroup === "person" ? s => s.person.name
    : sesGroup === "project" ? s => s.project
    : s => s.repo;
  const m = new Map();
  for (const s of list) { const k = keyFn(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  let entries = [...m.entries()];
  if (sesGroup === "team") entries.sort((a, b) => TEAM_ORDER.indexOf(a[0]) - TEAM_ORDER.indexOf(b[0]));
  else entries.sort((a, b) => b[1].length - a[1].length);
  return entries.map(([title, items]) => ({ title, items }));
}
export function sessionListHtml(sesQuery, sesGroup) {
  const q = sesQuery.trim().toLowerCase();
  const list = SESSIONS.filter(s => !q ||
    [s.title, s.person.name, s.person.team, s.person.group, s.repo, s.project, s.family, s.sid].join(" ").toLowerCase().includes(q));
  if (!list.length) return `<div class="ftable"><div class="empty">Nothing in the loaded window matches “${sesQuery}”.</div></div>`;
  const note = `<div style="font-size:14px;color:var(--text-subtle);margin:-8px 0 18px">Loaded the ${fmtInt(SESSIONS.length)} newest of ${fmtInt(TOTAL_SESSIONS)} sessions — group and search work within this window; older rows stream in on scroll in the live console.</div>`;
  return note + sesGroupsFor(list, sesGroup).map(g => {
    const kb = g.items.reduce((n, s) => n + s.kb, 0);
    const personId = sesGroup === "person" && g.items[0] ? g.items[0].person.id : null;
    const titleHtml = personId ? `<b class="grplink personlink" data-person="${personId}" style="cursor:pointer">${g.title}</b>` : `<b>${g.title}</b>`;
    return `<div class="toolgrp">
        <div class="toolhdr">${titleHtml}<span class="cnt">· ${plural(g.items.length, "session")} loaded · ${fmtMB(kb)}</span></div>
        <div class="ftable">${g.items.slice(0, 40).map(s => `
          <div class="frow"><div class="line" data-ses="${s.i}">
            ${sesCellA(s)}${sesCellB(s)}${sesCellC(s)}<div class="chev" style="transform:rotate(-45deg)"></div>
          </div></div>`).join("")}
        ${g.items.length > 40 ? `<div class="empty" style="padding:14px">+ ${g.items.length - 40} more in this group — refine with search</div>` : ""}</div>
      </div>`;
  }).join("");
}

// ── Session detail fills ────────────────────────────────
export function objectPath(s) { return `${s.person.userId}/${s.family}/${s.sid}/log.jsonl`; }
export const sdLedeHtml = s => `A ${s.family} session by ${s.person.name} (${s.person.team} · ${s.person.group}), in <span class="mono">${s.repo}</span>. Its metadata row was mirrored to this fortress ${agoStr(s.minsAgo)}.`;
export const sdFactsHtml = s => `
      <div class="frw"><span class="k">Person</span><span><span class="v personlink" data-person="${s.person.id}" style="cursor:pointer;color:var(--accent)">${s.person.name}</span><div class="vs">${s.person.team} · ${s.person.group}</div></span></div>
      <div class="frw"><span class="k">Device</span><span><span class="v mono">${(s.person.devices[0] || { n: "—" }).n}</span><div class="vs">reported by the <code class="hx">hx</code> client</div></span></div>
      <div class="frw"><span class="k">Tool</span><span><span class="v">${s.family}</span><div class="vs">model <span class="mono">${s.model}</span></div></span></div>
      <div class="frw"><span class="k">Repo</span><span><span class="v mono">${s.repo}</span><div class="vs">branch <span class="mono">${s.branch}</span> · project ${s.project}</div></span></div>
      <div class="frw"><span class="k">Last activity</span><span><span class="v">${agoStr(s.minsAgo)}</span><div class="vs">first event ${agoStr(s.minsAgo + Math.round(s.events * 0.7))}</div></span></div>
      <div class="frw"><span class="k">Session id</span><span><span class="v mono">${s.sid}</span></span></div>`;
export const sdActivityHtml = s => `
      <div class="frw"><span class="k">Events</span><span><span class="v">${fmtInt(s.events)}</span><div class="vs">${s.prompts} prompts · ${s.replies} replies · ${s.tools} tool calls</div></span></div>
      <div class="frw"><span class="k">Tokens</span><span><span class="v">${fmtTok(s.tokensIn)} in · ${fmtTok(s.tokensOut)} out</span><div class="vs">from the client's own usage records</div></span></div>
      <div class="frw"><span class="k">Size</span><span><span class="v">${fmtMB(s.kb)}</span><div class="vs">${Math.max(1, Math.ceil(s.kb / 96))} chunks appended to one canonical object</div></span></div>
      <div class="frw"><span class="k">Counts, not content</span><span><span class="v">Metadata only</span><div class="vs">every number here derives from structure — the text itself is never read by this console</div></span></div>`;
export const sdWhereHtml = s => `
      <div class="frw"><span class="k">Metadata row</span><span><span class="v mono">hx.sessions · ${s.sid.slice(0, 8)}…</span><div class="vs"><span class="mono">hx-db</span> on this host — mirrored by <span class="mono">ingestCommit</span> over the tunnel</div></span></div>
      <div class="frw"><span class="k">Transcript object</span><span><span class="v mono">s3://${FORT.bucket}/${objectPath(s)}</span><div class="vs">${fmtInt(Math.round(s.kb * 1024))} bytes — matches the metadata row</div></span></div>
      <div class="frw"><span class="k">Artifacts</span><span><span class="v mono">session.json · tasks.json</span><div class="vs">allow-listed sidecars under the same prefix</div></span></div>
      <div class="frw"><span class="k">HX Fortress relay</span><span><span class="v">Routing pointers only</span><div class="vs okv">0 transcript bytes rest at the relay</div></span></div>`;

// ── Adoption ────────────────────────────────────────────
export const COVER_PILL = {
  all: ["ok", "Full coverage"], some: ["warn", "Partial"], few: ["warn", "Few sessions"],
  quiet: ["off", "Installed, quiet"], none: ["off", "No client"],
};
export const AD_FILTERS = {
  noclient: { label: "people without the client", test: p => p.cover === "none" },
  quiet: { label: "installed but quiet", test: p => p.cover === "quiet" },
  stale: { label: "gone quiet this week", test: p => ["all", "some", "few"].includes(p.cover) && p.lastUp > 7 },
  partial: { label: "partial coverage", test: p => p.cover === "some" || p.cover === "few" },
  outdated: { label: "on outdated clients", test: p => p.devices.some(d => d.v !== "76.2.4") },
};
export const AD_GLBL = { team: "Team", group: "Group", coverage: "Coverage", status: "Client status" };
function personPill(p) {
  const [cls, lbl] = COVER_PILL[p.cover];
  const pct = p.cover === "some" || p.cover === "few" ? ` — ${p.pct}%` : "";
  return `<span class="pill ${cls} pc">${lbl}${pct}</span>`;
}
function personCellA(p) {
  return `<div class="cell cellA">
      <div class="cl l1"><span class="ico">${I.person}</span><span class="tx ttl">${p.name}</span></div>
      <div class="cl l2"><span class="ico">${I.team}</span><span class="tx">${p.team} · ${p.group}</span></div>
    </div>`;
}
function personCellB(p) {
  const dv = p.devices.length
    ? `${plural(p.devices.length, "device")} · <span class="mono">hx</span> ${[...new Set(p.devices.map(d => d.v))].join(" / ")}`
    : "no devices enrolled";
  return `<div class="cell cellB">
      <div class="cl l1">${personPill(p)}</div>
      <div class="cl l2"><span class="ico" style="visibility:hidden">${I.device}</span><span class="tx">${dv}</span></div>
    </div>`;
}
function personCellC(p) {
  return `<div class="cell cellC">${p.sessions ? `${fmtInt(p.sessions)} · ${fmtMB(p.kb)}` : "—"}</div>`;
}
function adGroupsFor(list, adGroup) {
  if (adGroup === "coverage") {
    const order = ["all", "some", "few", "quiet", "none"];
    const lbl = { all: "Full coverage", some: "Partial coverage", few: "Few sessions", quiet: "Installed, quiet 30+ days", none: "No client installed" };
    return order.map(k => ({ title: lbl[k], items: list.filter(p => p.cover === k) })).filter(g => g.items.length);
  }
  if (adGroup === "status") {
    return [
      { title: "Client installed", items: list.filter(p => p.cover !== "none") },
      { title: "Not installed", items: list.filter(p => p.cover === "none") },
    ].filter(g => g.items.length);
  }
  const keyFn = adGroup === "team" ? p => p.team : p => `${p.team} · ${p.group}`;
  const m = new Map();
  for (const p of list) { const k = keyFn(p); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  let entries = [...m.entries()];
  entries.sort((a, b) => TEAM_ORDER.indexOf(a[0].split(" ·")[0]) - TEAM_ORDER.indexOf(b[0].split(" ·")[0]));
  return entries.map(([title, items]) => ({ title, items }));
}
export function peopleListHtml(adQuery, adGroup, adFilter) {
  const q = adQuery.trim().toLowerCase();
  let list = PEOPLE.filter(p => !q || [p.name, p.team, p.group, ...p.devices.map(d => d.n + " " + d.v)].join(" ").toLowerCase().includes(q));
  if (adFilter) list = list.filter(AD_FILTERS[adFilter].test);
  if (!list.length) return { html: `<div class="ftable"><div class="empty">No people match.</div></div>`, count: 0 };
  const html = adGroupsFor(list, adGroup).map(g => {
    const sending = g.items.filter(p => ["all", "some", "few"].includes(p.cover)).length;
    return `<div class="toolgrp">
        <div class="toolhdr"><b>${g.title}</b><span class="cnt">· ${sending} of ${plural(g.items.length, "person", "people")} sending</span></div>
        <div class="ftable">${g.items.map(p => `
          <div class="frow"><div class="line" data-personrow="${p.id}">
            ${personCellA(p)}${personCellB(p)}${personCellC(p)}<div class="chev" style="transform:rotate(-45deg)"></div>
          </div></div>`).join("")}</div>
      </div>`;
  }).join("");
  return { html, count: list.length };
}

// ── Person detail ───────────────────────────────────────
export function firstHere(p) {
  if (p.id === "viktor") return "Jun 30, 2026";
  if (p.sessions > 400) return "Mar 2026";
  if (p.sessions > 200) return "Apr 2026";
  if (p.sessions > 50) return "May 2026";
  return p.sessions ? "Jun 2026" : "—";
}
export const COVER_WORDS = {
  all: "Nearly all of the work-repo sessions on their devices reach this fortress.",
  some: "A meaningful share of their work-repo sessions is not arriving — worth a conversation, not an alarm.",
  few: "The client is installed but almost nothing arrives — usually a routing or habit issue.",
  quiet: "The client is installed but nothing has arrived in over 30 days.",
  none: "No client, no coverage — nothing from their machines can reach this fortress.",
};
export const pdCoverageHtml = p => `
      <div class="frw"><span class="k">Client</span><span><span class="v">${p.cover === "none" ? "Not installed" : "Installed"}</span><div class="vs">${p.devices.length ? `<span class="mono">hx</span> ${[...new Set(p.devices.map(d => d.v))].join(" / ")}` : "no devices enrolled for this person"}</div></span></div>
      <div class="frw"><span class="k">Sending coverage</span><span><span class="v">${p.pct}%</span><div class="vs"><span class="meter${p.pct < 90 ? " warnm" : ""}"><i style="width:${p.pct}%"></i></span> of device-reported work-repo sessions arrive here</div></span></div>
      <div class="frw"><span class="k">Last upload</span><span><span class="v">${p.lastUp < 0 ? "Never" : p.lastUp === 0 ? "Today" : p.lastUp + "d ago"}</span><div class="vs">${p.lastUp > 7 ? "outside the weekly rhythm — worth a look" : p.lastUp < 0 ? "no client, nothing can arrive" : "within the normal rhythm"}</div></span></div>
      <div class="frw"><span class="k">First session here</span><span><span class="v">${firstHere(p)}</span></span></div>`;
export const pdFootprintHtml = p => {
  const share = TOTAL_SESSIONS ? ((p.sessions / TOTAL_SESSIONS) * 100).toFixed(1) : "0";
  return `
      <div class="frw"><span class="k">Sessions</span><span><span class="v">${fmtInt(p.sessions)}</span><div class="vs">${share}% of everything on this fortress</div></span></div>
      <div class="frw"><span class="k">Bytes</span><span><span class="v">${p.kb ? fmtMB(p.kb) : "—"}</span><div class="vs">${p.kb ? "canonical transcripts in the bucket" : "nothing stored"}</div></span></div>
      <div class="frw"><span class="k">Projects</span><span><span class="v">${teamProjects(p.team).map(x => x.name).join(" · ") || "—"}</span><div class="vs">via ${p.team} repositories</div></span></div>
      <div class="frw"><span class="k">Storage prefix</span><span><span class="v mono">${p.userId}/</span><div class="vs">every object for this person lives under this prefix</div></span></div>`;
};
export const pdDevicesHtml = p => p.devices.length ? p.devices.map(d => {
  const state = d.seen === 0 ? ["", "Live", "heartbeat within the last few minutes"] : d.seen <= 7 ? ["warn", "Idle", `last seen ${d.seen}d ago`] : ["bad", "Dark", `last seen ${d.seen}d ago`];
  const unsent = d.unsent ? ` · <b style="color:var(--warn)">${d.unsent} sessions on disk not yet uploaded</b>` : "";
  return `<div class="row"><span class="dot ${state[0]}"></span>
        <div class="who"><b class="mono" style="font-weight:600">${d.n}</b><div class="sub">${d.os} · ${state[2]}${unsent}</div></div>
        <div><span class="pill ${d.v === "76.2.4" ? "ok" : "warn"} pc"><span class="mono">hx</span>&nbsp;${d.v}</span></div>
        <div class="m">${state[1].toLowerCase()}</div></div>`;
}).join("") : `<div class="empty">No devices enrolled.</div>`;
export const pdSessionsHtml = mine => mine.length ? mine.map(s => `
      <div class="prevrow" data-ses="${s.i}">${sesCellA(s)}${sesCellB(s)}${sesCellC(s)}</div>`).join("")
  : `<div class="empty">No sessions from this person rest on this fortress.</div>`;

// ── Funnel ──────────────────────────────────────────────
export function funnelHtml(FUNNEL, adFilter) {
  return FUNNEL.map((s, i) => `
      <div class="fstage${adFilter && s.f !== adFilter ? " dimf" : ""}" data-fstage="${i}">
        <div class="fk">${s.k}</div>
        <div class="fnum">${s.n()}</div>
        <div class="fdrop">${typeof s.drop === "function" ? s.drop() : s.drop}</div>
      </div>`).join("");
}

// ── Residency ───────────────────────────────────────────
export const CLOUD_ONLY = 1209;
export function gatesHtml(incident) {
  const rows = incident ? [
    ["", "G1 · Repo detected", "the client read a git origin and derived a slug for every work session", ["ok", "Passing"], "0 unreadable"],
    ["bad", "G2 · Repo attached to a project", "<span class='mono'>orange-corp/rind</span> and <span class='mono'>orange-corp/zest-monitor</span> are attached to no project — every session in them quietly routes to personal spaces", ["danger", "2 repos failing"], "~120 sessions/wk"],
    ["", "G3 · Uploader is an active member", "all 42 people hold active orange-corp memberships", ["ok", "Passing"], "42 active"],
    ["bad", "G4 · Vault-mode + live tunnel", "the fortress is enrolled against a different environment than the one devices upload to — the uploading side sees no vault-mode org and every session quietly stays at the relay", ["danger", "Env mismatch"], "10 days"],
    ["bad", "Fortress Postgres", "phase <span class='mono'>failed</span> — every metadata RPC has thrown <span class='mono'>postgres_not_ready</span> since Jul 11; the boot is one-shot and nobody restarted the service", ["danger", "failed"], "10 days"],
  ] : [
    ["", "G1 · Repo detected", "the client reads the git origin and derives a slug — sessions without one are personal by definition", ["ok", "Passing"], "0 unreadable"],
    ["warn", "G2 · Repo attached to a project", "<span class='mono'>orange-corp/rind</span> is attached to no project — its sessions route to personal spaces, not this fortress", ["warn", "1 repo unclaimed"], "~9 sessions/wk"],
    ["", "G3 · Uploader is an active member", "all 42 rostered people hold active orange-corp memberships", ["ok", "Passing"], "42 active"],
    ["", "G4 · Vault-mode + live tunnel", "orange-corp is vault-mode in the environment devices upload to, and this fortress holds the live tunnel", ["ok", "Passing"], "connected 12d"],
  ];
  return rows.map(r => `
      <div class="row"><span class="dot ${r[0]}"></span>
        <div class="who"><b>${r[1]}</b><div class="sub">${r[2]}</div></div>
        <div><span class="pill ${r[3][0]} pc">${r[3][1]}</span></div>
        <div class="m">${r[4]}</div>
      </div>`).join("");
}
export const gatesNoteHtml = incident => incident
  ? `<b>This is the incident.</b> Every green connection signal stayed green — “up · Excellent”, “Sync 100%”, “store initialized”. The only truthful numbers were the ones on this page: this fortress received 0 bytes while the relay held ${fmtInt(CLOUD_ONLY)} sessions. Fix the gates, restart Postgres, then re-run the audit.`
  : `<b>Why this matters:</b> at another fortress customer, sessions silently fell through these gates for ten days — the client showed “up — Excellent · Sync 100%” while the fortress bucket stayed empty. Green connection signals are not residency; this table is.`;
export const AUDIT_RUNS_SEED = [
  ["", "Today 02:00 · nightly", "row + object presence for every attributed session", ["ok", "Verified"], "4m 12s"],
  ["", "Jul 20 02:00 · nightly", "12,809 sessions at the time — all verified", ["ok", "Verified"], "4m 09s"],
  ["", "Jul 19 03:00 · weekly deep", "byte-level checksums on every canonical object", ["ok", "Verified"], "38m 04s"],
  ["", "Jul 19 02:00 · nightly", "12,771 sessions at the time — all verified", ["ok", "Verified"], "4m 15s"],
  ["", "Jul 16 14:22 · on-demand", "run by dana.mandarin ahead of the Q3 security review", ["ok", "Verified"], "4m 02s"],
];
export function auditHistoryHtml(incident, auditRuns) {
  const rows = incident
    ? [["bad", "Today 02:00 · nightly", `found ${fmtInt(CLOUD_ONLY)} attributed sessions with no fortress row and no bucket object — transcript content located at the relay`, ["danger", "Failed"], "6m 51s"], ...auditRuns.slice(1)]
    : auditRuns;
  return rows.map(r => `
      <div class="row"><span class="dot ${r[0]}"></span>
        <div class="who"><b>${r[1]}</b><div class="sub">${r[2]}</div></div>
        <div><span class="pill ${r[3][0]} pc">${r[3][1]}</span></div>
        <div class="m">${r[4]}</div>
      </div>`).join("");
}
export const spotListHtml = () => SESSIONS.slice(0, 5).map(s => `
      <div class="prevrow" data-ses="${s.i}" style="grid-template-columns:minmax(150px,1fr) 235px 120px">
        ${sesCellA(s)}${sesCellB(s)}
        <div class="cell cellC" style="align-self:center"><button class="btn ghost sm" data-verify="${s.i}">Verify</button></div>
      </div>`).join("");
export const auditCopyText = () => {
  const total = fmtInt(TOTAL_SESSIONS);
  return `HX FORTRESS RESIDENCY AUDIT — orange-corp
fortress   ${FORT.id} · ${FORT.host}
audited    2026-07-21 02:00 CEST · nightly · 4m 12s
scope      ${total} sessions · ${N_ROSTER} people · 9 repos
postgres   ${total} metadata rows present (hx.sessions)
bucket     ${total} canonical objects verified — path + bytes match (s3://${FORT.bucket}, ${FORT.region})
relay      0 transcript bytes at the HX Fortress relay — routing pointers only
verdict    ALL SESSIONS RESIDE ON ENTERPRISE SYSTEMS`;
};

// ── Verify modal ────────────────────────────────────────
export function verifyStepsFor(s) {
  const bytes = fmtInt(Math.round(s.kb * 1024));
  return [
    { name: "Fortress Postgres", sub: `<span class="mono">hx.sessions</span> row for <span class="mono">${s.sid.slice(0, 8)}…</span>`, res: `Row present — ${fmtInt(s.events)} events · ${bytes} bytes recorded · 4 ms`, ok: true, ms: 500 },
    { name: "Enterprise bucket", sub: `<span class="mono">s3://${FORT.bucket}/${objectPath(s)}</span>`, res: `Object found — ${bytes} bytes, matches the metadata row · 61 ms`, ok: true, ms: 700 },
    { name: "Staging prefix", sub: `<span class="mono">…/${s.sid}/.staging/</span>`, res: "No orphaned staging chunks", ok: true, ms: 450 },
    { name: "HX Fortress relay", sub: "content check against the relay index", res: "No transcript bytes — routing pointers and this metadata mirror only", ok: true, none: true, ms: 800 },
  ];
}
export const verifyProofText = s => `HX FORTRESS RESIDENCY PROOF
fortress   ${FORT.id} (orange-corp)
session    ${s.family}/${s.sid} — “${s.title}”
person     ${s.person.name} (${s.person.userId})
checked    2026-07-21 16:44 CEST · live
[1] postgres  hx.sessions row present · events=${s.events} bytes=${Math.round(s.kb * 1024)}
[2] bucket    s3://${FORT.bucket}/${objectPath(s)} · ${Math.round(s.kb * 1024)} bytes · matches
[3] staging   no orphaned chunks
[4] relay     routing pointers only · transcript bytes: 0
verdict    RESIDES ON ENTERPRISE SYSTEMS`;

// ── Compliance ──────────────────────────────────────────
export const EGRESS = [
  ["", "HX Fortress relay tunnel", "outbound WebSocket — session metadata mirrors, routing, RPC results. Never transcript objects, never keys.", ["ok", "By design"], "wss · out only"],
  ["", "Embeddings endpoint", "secret-scrubbed turn text is sent for vectorization; the resulting vectors live in the fortress Postgres", ["off", "Configurable"], "api.openai.com"],
  ["", "Binary downloads", "Postgres binaries (checksum-pinned) and pgvector/self-update assets via the download proxy — at boot and update time only", ["ok", "Checksummed"], "boot · update"],
  ["", "Bucket writes", "the organization's own bucket in eu-north-1 — transcripts at rest never leave the region or the org's keys", ["ok", "In-region"], "s3 · eu-north-1"],
];
export const egressHtml = () => EGRESS.map(r => `
      <div class="row"><span class="dot ${r[0]}"></span>
        <div class="who"><b>${r[1]}</b><div class="sub">${r[2]}</div></div>
        <div><span class="pill ${r[3][0]} pc">${r[3][1]}</span></div>
        <div class="m">${r[4]}</div>
      </div>`).join("");
export const TRAIL_SEED = [
  ["Today 02:00", "system", "Nightly residency audit", "verified " + fmtInt(TOTAL_SESSIONS) + " of " + fmtInt(TOTAL_SESSIONS) + " · 0 cloud content", "ok", "Verified"],
  ["Jul 20 16:12", "dana.mandarin", "Exported the compliance report", "one-page posture summary, copied from this console", "off", "Export"],
  ["Jul 19 03:00", "system", "Weekly deep audit", "byte-level checksums on every canonical object", "ok", "Verified"],
  ["Jul 16 14:22", "dana.mandarin", "On-demand residency audit", "ahead of the Q3 security review", "ok", "Verified"],
  ["Jul 9 09:01", "dana.mandarin", "Updated hx-fortress 0.11.4 → 0.12.1", "sha-256 verified · service restarted cleanly", "off", "Update"],
  ["May 30 11:08", "dana.mandarin", "Rotated the vault key", "hx-fortress credentials set vault · service restarted", "off", "Credential"],
  ["Mar 12 10:40", "niklas.falk", "Enrolled this fortress", "hx-fortress enroll · storage self-test passed on first try", "ok", "Enrolled"],
];
export const trailHtml = TRAIL => TRAIL.map(r => `
      <div class="row"><span class="dot ${r[4] === "ok" ? "" : "offd"}"></span>
        <div class="who"><b>${r[2]}</b><div class="sub">${r[3]} · by ${r[1]}</div></div>
        <div><span class="pill ${r[4]} pc">${r[5]}</span></div>
        <div class="m">${r[0]}</div>
      </div>`).join("");
export function buildReport() {
  const total = fmtInt(TOTAL_SESSIONS);
  return `HX FORTRESS COMPLIANCE SUMMARY — orange-corp
generated  2026-07-21 16:44 CEST · by dana.mandarin · hx-fortress v${FORT.version}
residency  ${total} of ${total} attributed sessions verified on enterprise systems
           0 transcript bytes at the HX Fortress relay · nightly audit 02:00
storage    s3://${FORT.bucket} (${FORT.region}) · SSE-KMS alias/orange-hx · versioning on
           ${fmtInt(TOTAL_OBJECTS)} objects · ${fmtMB(TOTAL_KB + 4200)}
metadata   embedded Postgres 18.4.0, loopback-only on this host · 12 migrations · pgvector present
egress     HX Fortress relay tunnel (metadata + routing only) · embeddings endpoint (configurable)
           binary downloads checksum-pinned · bucket writes in-region
retention  transcripts indefinite (org bucket policy) · fortress logs 90d · audit trail 180d
adoption   ${N_ROSTER} rostered · ${N_INSTALLED} installed · ${N_SENDING} sending · coverage ${COVERAGE_PCT}%
open items none`;
}

// ── Postgres pipeline ───────────────────────────────────
export const PIPE_STEPS = [
  ["acquire", "download + verify the server binaries · checksum-pinned", "cache hit · 0.8s"],
  ["initdb", "create the cluster on first boot", "skipped — cluster exists"],
  ["startServer", "pg_ctl -w start · loopback only", "1.9s"],
  ["ensureAuth", "scram passwords + loopback-only pg_hba", "0.2s"],
  ["ensureDbSchema", "create hx-db and schema hx", "0.3s"],
  ["ensureVector", "inject pgvector 0.8.1 — mandatory: a failure here fails the whole boot", "0.9s"],
  ["migrate", "apply the 12 schema migrations", "6.8s"],
  ["ensureAppRoles", "provision hx_app_ro / hx_app_rw", "0.3s"],
];
export const PG_FAIL_STEP = 0;
export const PG_FAIL_REASON = "binaries download failed: https://repo1.maven.org unreachable (egress policy)";
export function pipeHtml(pgPreview) {
  return PIPE_STEPS.map((s, i) => {
    const failed = pgPreview && i === PG_FAIL_STEP;
    const notReached = pgPreview && i > PG_FAIL_STEP;
    const cls = failed ? "pstep pfail" : notReached ? "pstep pend pdim" : "pstep";
    const node = failed ? I.xS : notReached ? "" : I.checkS;
    const meta = failed ? "failed" : notReached ? "not reached" : s[2];
    const desc = failed ? `<span style="color:var(--danger);font-weight:600">${PG_FAIL_REASON}</span>` : s[1];
    return `<div class="${cls}">
        <div class="pnode">${node}</div>
        <div><div class="pname2">${s[0]}</div><div class="pdesc">${desc}</div></div>
        <div class="pmeta">${meta}</div>
      </div>`;
  }).join("");
}
export const pgRemedyHtml = pgPreview => pgPreview
  ? `<b>Get out of this state:</b> allow egress to <span class="mono">repo1.maven.org</span> (or point <span class="mono">FORTRESS_PG_BINARIES_URL</span> at an internal mirror), then restart — <code class="hx">hx-fortress stop &amp;&amp; hx-fortress start</code>. The boot is one-shot: until that restart, every metadata RPC keeps failing with <span class="mono">postgres_not_ready</span> while the tunnel stays green.`
  : `<b>If a phase fails:</b> the phase and its stored reason appear here and in <code class="hx">hx-fortress status</code>. Fix the cause, then restart the service — <code class="hx">hx-fortress stop &amp;&amp; hx-fortress start</code>. Restarting is the only way out of <span class="mono">failed</span>; the boot will not retry by itself.`;

// ── Blob ────────────────────────────────────────────────
export const BLOB_HISTORY_SEED = [
  ["Today 06:00 · scheduled", "2 KB probe written, read back and deleted", ["ok", "Passed"], "184 ms"],
  ["Jul 20 06:00 · scheduled", "2 KB probe written, read back and deleted", ["ok", "Passed"], "191 ms"],
  ["Jul 19 06:00 · scheduled", "2 KB probe written, read back and deleted", ["ok", "Passed"], "178 ms"],
  ["Jul 9 09:02 · at boot", "self-test on service start — the honest version of “store initialized”", ["ok", "Passed"], "196 ms"],
];
export const blobHistoryHtml = rows => rows.map(r => `
      <div class="row"><span class="dot"></span>
        <div class="who"><b>${r[0]}</b><div class="sub">${r[1]}</div></div>
        <div><span class="pill ${r[2][0]} pc">${r[2][1]}</span></div>
        <div class="m">${r[3]}</div>
      </div>`).join("");

// ── Keys & Credentials ──────────────────────────────────
export const KEYS_SEED = [
  { id: "vault", label: "Vault key", masked: "vlt_••••••••••9c4d", sub: "authenticates this fortress to the HX Fortress relay · rotated May 30 · 52 days old", ph: "paste the new vlt_… token" },
  { id: "s3", label: "Blob storage key", masked: "AKIA••••••••3F7Q", sub: "reads and writes s3://orange-corp-hx-fortress · inline in credentials.json", ph: "paste the new access key" },
  { id: "openai", label: "OpenAI API key", masked: "sk-••••••••••hV2m", sub: "creates embeddings · stored only on this host", ph: "paste the new sk-… key" },
];
export function keysHtml(KEYS, rotating) {
  return KEYS.map(k => `
      <div class="frw"><span class="k">${k.label}</span><span><span class="v mono">${k.masked}</span><div class="vs${k.rotated ? " warnv" : ""}" id="keysub-${k.id}">${k.rotated ? "rotated just now — restart the service to apply" : k.sub}</div></span>${
        rotating === k.id
          ? `<span style="display:flex;gap:8px;align-items:center;justify-content:flex-end">
              <input class="rotatein" id="rotInput" type="password" placeholder="${k.ph}" autocomplete="off">
              <button class="btn sm" data-rotsave="${k.id}">Save</button>
              <button class="btn ghost sm" data-rotcancel>Cancel</button>
            </span>`
          : `<button class="btn ghost sm" data-rotate="${k.id}">Rotate…</button>`
      }</div>`).join("");
}

// ── Checkup ─────────────────────────────────────────────
export const checkupRows = (svcRunning, pid) => svcRunning ? [
  ["", "Service", `running — systemd, pid ${pid}`, ["ok", "Passed"], "2 ms"],
  ["", "Status snapshot", "runtime/status.json written 2s ago by the live pid — not stale", ["ok", "Passed"], "1 ms"],
  ["", "Postgres", "phase ready · 12 migrations · pgvector present", ["ok", "Passed"], "6 ms"],
  ["", "Blob storage", "live self-test — probe written and read back", ["ok", "Passed"], "178 ms"],
  ["", "Embeddings endpoint", "reachable — a test embedding round-tripped cleanly", ["ok", "Passed"], "204 ms"],
  ["", "Relay tunnel", "connected — last heartbeat 1s ago, 0 RPC errors today", ["ok", "Passed"], "38 ms"],
] : [
  ["bad", "Service", "stopped — nothing else can be probed while the fortress is down", ["danger", "Failed"], "—"],
];
export const checkupRowHtml = c => `<div class="row"><span class="dot ${c[0]}"></span>
        <div class="who"><b>${c[1]}</b><div class="sub">${c[2]}</div></div>
        <div><span class="pill ${c[3][0]} pc">${c[3][1]}</span></div>
        <div class="m">${c[4]}</div></div>`;

// ── Logs ────────────────────────────────────────────────
export const dayLbl = d => d === 0 ? "" : d === 12 ? "Jul 9 " : `Jul ${21 - d} `;
export function fmtRecord(r) {
  const fields = Object.entries(r.f || {}).map(([k, v]) =>
    `<span class="fld" data-k="${k}" data-v="${String(v)}">${k}=${typeof v === "string" ? `"${v}"` : v}</span>`).join(" ");
  return `<span class="ts">${dayLbl(r.d)}${r.t}</span> <span class="lmod">[${r.mod}]</span> ${r.lvl} ${r.msg}${fields ? " " + fields : ""}`;
}
export const recText = r => `${dayLbl(r.d)}${r.t} [${r.mod}] ${r.lvl} ${r.msg} ${Object.entries(r.f || {}).map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`).join(" ")}`;
export const LVL_SHORT = { all: "All", warn: "Warn+", error: "Errors" };
export const RANGE_SHORT = { "1h": "1 h", "24h": "24 h", "7d": "7 d", boot: "Boot" };
export const RANGE_LONG = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", boot: "since last boot (Jul 9)" };
export const TAIL_POOL = [
  () => ({ mod: "session_vault", lvl: "info", msg: "vault RPC ok", f: { method: "ingestCommit", userId: PEOPLE[Math.floor(Math.random() * 8)].userId, family: "claude-cli", bytes: 40000 + Math.floor(Math.random() * 300000) } }),
  () => ({ mod: "session_vault", lvl: "info", msg: "vault RPC ok", f: { method: "listSessions", userId: PEOPLE[8 + Math.floor(Math.random() * 8)].userId, rows: 80 + Math.floor(Math.random() * 300), ms: 6 + Math.floor(Math.random() * 12) } }),
  () => ({ mod: "embed-worker", lvl: "info", msg: "embed pass complete", f: { embedded: 24 + Math.floor(Math.random() * 80), deadLetter: 0, tokens: 30000 + Math.floor(Math.random() * 90000) } }),
  () => ({ mod: "gateway", lvl: "info", msg: "request served", f: { route: "/sessions", grant: "read", ms: 8 + Math.floor(Math.random() * 20) } }),
  () => ({ mod: "session_vault", lvl: "info", msg: "vault RPC ok", f: { method: "appendChunkToCanonical", userId: PEOPLE[Math.floor(Math.random() * 16)].userId, family: "claude-cli", bytes: 60000 + Math.floor(Math.random() * 400000) } }),
];

// ── Overview growth chart ───────────────────────────────
export const growthTip = i => {
  const d = new Date(2026, 5, 22 + i);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${GROWTH[i]} MB · ${Math.round(GROWTH[i] * 6.9)} sessions`;
};
