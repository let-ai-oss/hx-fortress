import React from "react";
import { useApp } from "../state";
import { MenuPill, SearchBox } from "../components";
import { sessionListHtml, SES_GLBL, sdLedeHtml, sdFactsHtml, sdActivityHtml, sdWhereHtml, objectPath } from "../render";
import { SESSIONS, fmtInt, fmtMB, TOTAL_SESSIONS, TOTAL_KB, N_WITH_SESSIONS, N_REPOS } from "../data";

export function Sessions() {
  const app = useApp();
  const sesGroup = app.route.sesGroup;
  const sesQuery = app.route.sesQuery;
  const setSesGroup = (g: string) => app.navigate({ sesGroup: g });
  // Typing replaces rather than stacks history — one Back leaves the search.
  const setSesQuery = (q: string) => app.navigate({ sesQuery: q }, { replace: true });

  const onList = (e: React.MouseEvent) => {
    const pl = (e.target as HTMLElement).closest(".personlink") as HTMLElement | null;
    if (pl) { e.stopPropagation(); app.openPerson(pl.dataset.person!); return; }
    const line = (e.target as HTMLElement).closest("[data-ses]") as HTMLElement | null;
    if (line) app.openSession(SESSIONS[Number(line.dataset.ses)]);
  };

  return (
    <section className={app.view === "sessions" ? "view active" : "view"} id="view-sessions">
      <div className="kicker">Operate</div>
      <h1>Sessions — Metadata Explorer</h1>
      <p className="lede">Every session this fortress holds: who, which repo, how big, and exactly where it rests. Titles, counts and locations are metadata — transcript content never appears in this console.</p>

      <div className="stats">
        <div className="stat"><span className="lbl">Total sessions</span><div className="big" id="sesTotal">{fmtInt(TOTAL_SESSIONS)}</div><div className="sub" id="sesTotalSub">{fmtMB(TOTAL_KB)} in the bucket</div></div>
        <div className="stat"><span className="lbl">People</span><div className="big" id="sesPeople">{N_WITH_SESSIONS}</div><div className="sub">with at least one session here</div></div>
        <div className="stat"><span className="lbl">Repos</span><div className="big" id="sesRepos">{N_REPOS}</div><div className="sub">across 7 projects</div></div>
        <div className="stat"><span className="lbl">Newest</span><div className="big">12s</div><div className="sub">ago · “Fix S3 routing gates”</div></div>
      </div>

      <div className="toolbar">
        <MenuPill pillId="sesGroupPill" menuId="sesGroupMenu" valueId="sesGroupVal"
          label="Group by" value={(SES_GLBL as any)[sesGroup]} selKey={sesGroup} dataAttr="data-g"
          items={[
            { key: "team", label: "Team" },
            { key: "person", label: "Person" },
            { key: "project", label: "Project" },
            { key: "repo", label: "Git repo" },
            { key: "none", label: "Newest first" },
          ]}
          onPick={setSesGroup} />
        <SearchBox id="sesSearch" placeholder="Search titles, people, teams, repos, projects, session ids…"
          value={sesQuery} onInput={setSesQuery} />
      </div>

      <div id="sessionList" onClick={onList} dangerouslySetInnerHTML={{ __html: sessionListHtml(sesQuery, sesGroup) }} />
    </section>
  );
}

export function SessionDetail() {
  const app = useApp();
  const s = app.currentSession;
  const onFacts = (e: React.MouseEvent) => {
    const pl = (e.target as HTMLElement).closest(".personlink") as HTMLElement | null;
    if (pl) app.openPerson(pl.dataset.person!);
  };
  return (
    <section className={app.view === "session-detail" ? "view active" : "view"} id="view-session-detail">
      <div className="kicker"><a href="#" onClick={e => { e.preventDefault(); app.goto("sessions"); }}>← Sessions</a></div>
      <h1 id="sdTitle">{s ? `“${s.title}”` : "Session"}</h1>
      <p className="lede" id="sdLede" dangerouslySetInnerHTML={{ __html: s ? sdLedeHtml(s) : "" }} />

      <div className="grid2">
        <div className="panel">
          <h2>Session</h2>
          <div className="facts" id="sdFacts" onClick={onFacts} dangerouslySetInnerHTML={{ __html: s ? sdFactsHtml(s) : "" }} />
        </div>
        <div className="panel">
          <h2>Activity</h2>
          <div className="facts" id="sdActivity" dangerouslySetInnerHTML={{ __html: s ? sdActivityHtml(s) : "" }} />
        </div>
      </div>

      <div className="panel">
        <h2>Where It Rests</h2>
        <div className="h2sub">The two systems that hold this session, and the one that holds only pointers.</div>
        <div className="facts wide" id="sdWhere" dangerouslySetInnerHTML={{ __html: s ? sdWhereHtml(s) : "" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" id="sdVerifyBtn" onClick={() => s && app.verifySession(s)}>Verify residency</button>
        </div>
      </div>

      <div className="panel">
        <h2>Content Boundary</h2>
        <p style={{ fontSize: 15, color: "var(--text-muted)", maxWidth: 700, margin: "2px 0 0" }}>
          This console will never display this session's transcript — no text, no excerpts, no previews. The transcript rests as{" "}
          <span className="mono" id="sdBoundaryPath">{s ? objectPath(s) : "log.jsonl"}</span> in the organization's bucket, readable only through tools the organization authorizes.
          What you see here is the metadata row the fortress mirrors into its own Postgres.
        </p>
      </div>
    </section>
  );
}
