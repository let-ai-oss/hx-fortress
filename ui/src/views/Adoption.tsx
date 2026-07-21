import React from "react";
import { useApp } from "../state";
import { MenuPill, SearchBox } from "../components";
import { funnelHtml, peopleListHtml, AD_FILTERS, AD_GLBL, pdCoverageHtml, pdFootprintHtml, pdDevicesHtml, pdSessionsHtml, COVER_WORDS } from "../render";
import { SESSIONS, plural, N_ROSTER, N_INSTALLED, N_SENDING, N_ACTIVE_WEEK, N_FULL, COVERAGE_PCT } from "../data";

const FUNNEL = [
  { k: "Rostered", n: () => N_ROSTER, drop: "", f: null as string | null },
  { k: "Installed", n: () => N_INSTALLED, drop: () => `−${N_ROSTER - N_INSTALLED} no client`, f: "noclient" },
  { k: "Sending", n: () => N_SENDING, drop: () => `−${N_INSTALLED - N_SENDING} quiet`, f: "quiet" },
  { k: "Active this week", n: () => N_ACTIVE_WEEK, drop: () => `−${N_SENDING - N_ACTIVE_WEEK} gone quiet`, f: "stale" },
  { k: "Full coverage", n: () => N_FULL, drop: () => `−${N_SENDING - N_FULL} partial`, f: "partial" },
];

export function Adoption() {
  const app = useApp();
  const adGroup = app.route.adGroup;
  const adQuery = app.route.adQuery;
  const setAdGroup = (g: string) => app.navigate({ adGroup: g });
  const setAdQuery = (q: string) => app.navigate({ adQuery: q }, { replace: true });
  const { adFilter, setAdFilter } = app;

  const { html: listHtml, count } = peopleListHtml(adQuery, adGroup, adFilter);

  const onFunnel = (e: React.MouseEvent) => {
    const st = (e.target as HTMLElement).closest("[data-fstage]") as HTMLElement | null;
    if (!st) return;
    const f = FUNNEL[Number(st.dataset.fstage)].f;
    setAdFilter(adFilter === f ? null : f);
  };
  const onList = (e: React.MouseEvent) => {
    const line = (e.target as HTMLElement).closest("[data-personrow]") as HTMLElement | null;
    if (line) app.openPerson(line.dataset.personrow!);
  };

  return (
    <section className={app.view === "adoption" ? "view active" : "view"} id="view-adoption">
      <div className="kicker">Operate</div>
      <h1>Adoption — Roster vs Reality</h1>
      <p className="lede">Who has the <code className="hx">hx</code> client, who is actually sending sessions, and where coverage is thin. Roster from the orange-corp directory; reality from what lands on this fortress.</p>

      <div className="stats">
        <div className="stat"><span className="lbl">Rostered people</span><div className="big" id="adRoster">{N_ROSTER}</div><div className="sub">orange-corp directory</div></div>
        <div className="stat"><span className="lbl">Client installed</span><div className="big" id="adInstalled">{N_INSTALLED}</div><div className="sub" id="adInstalledSub">{N_ROSTER - N_INSTALLED} not installed</div></div>
        <div className="stat"><span className="lbl">Sending</span><div className="big" id="adSending">{N_SENDING}</div><div className="sub" id="adSendingSub">{N_INSTALLED - N_SENDING} installed but quiet</div></div>
        <div className="stat"><span className="lbl">Coverage</span><div className="big statlink" id="adCoverageBig">{COVERAGE_PCT}%<div className="pop">How coverage is computed →</div></div><div className="sub">sending ÷ rostered · last 30 days</div></div>
      </div>

      <div className="panel">
        <h2>The Funnel</h2>
        <div className="h2sub">Roster → installed → sending → active this week → full coverage. Click a stage to filter the people below.</div>
        <div className="funnel" id="adFunnel" onClick={onFunnel} dangerouslySetInnerHTML={{ __html: funnelHtml(FUNNEL, adFilter) }} />
      </div>

      <div className="toolbar">
        <MenuPill pillId="adGroupPill" menuId="adGroupMenu" valueId="adGroupVal"
          label="Group by" value={(AD_GLBL as any)[adGroup]} selKey={adGroup} dataAttr="data-g"
          items={[
            { key: "team", label: "Team" },
            { key: "group", label: "Group" },
            { key: "coverage", label: "Coverage" },
            { key: "status", label: "Client status" },
          ]}
          onPick={setAdGroup} />
        <SearchBox id="adSearch" placeholder="Search people, teams, groups, devices…"
          value={adQuery} onInput={setAdQuery} />
      </div>

      <div className={adFilter ? "minibanner on" : "minibanner"} id="adFilterBanner">
        <span id="adFilterText">{adFilter ? `Showing ${plural(count, "person", "people")} — ${(AD_FILTERS as any)[adFilter].label}.` : ""}</span>
        <span style={{ flex: 1 }}></span>
        <button className="btn link sm" id="adFilterClear" onClick={() => setAdFilter(null)}>Clear</button>
      </div>

      <div id="peopleList" onClick={onList} dangerouslySetInnerHTML={{ __html: listHtml }} />
    </section>
  );
}

export function PersonDetail() {
  const app = useApp();
  const p = app.currentPerson;
  const mine = p ? SESSIONS.filter((s: any) => s.person === p).slice(0, 6) : [];
  const onSessions = (e: React.MouseEvent) => {
    const line = (e.target as HTMLElement).closest("[data-ses]") as HTMLElement | null;
    if (line) app.openSession(SESSIONS[Number(line.dataset.ses)]);
  };
  return (
    <section className={app.view === "person-detail" ? "view active" : "view"} id="view-person-detail">
      <div className="kicker"><a href="#" onClick={e => { e.preventDefault(); app.goto("adoption"); }}>← Adoption</a></div>
      <h1 id="pdName">{p ? p.name : "Person"}</h1>
      <p className="lede" id="pdLede">{p ? `${p.team} · ${p.group}. ${(COVER_WORDS as any)[p.cover]}` : ""}</p>

      <div className="grid2">
        <div className="panel">
          <h2>Coverage</h2>
          <div className="facts" id="pdCoverage" dangerouslySetInnerHTML={{ __html: p ? pdCoverageHtml(p) : "" }} />
        </div>
        <div className="panel">
          <h2>Footprint on This Fortress</h2>
          <div className="facts" id="pdFootprint" dangerouslySetInnerHTML={{ __html: p ? pdFootprintHtml(p) : "" }} />
        </div>
      </div>

      <div className="panel">
        <h2>Devices</h2>
        <div className="h2sub">Device metadata reported by the <code className="hx">hx</code> client — names, versions and liveness. Nothing on the device itself is readable from here.</div>
        <div className="rowlist ops" id="pdDevices" dangerouslySetInnerHTML={{ __html: p ? pdDevicesHtml(p) : "" }} />
      </div>

      <div className="panel">
        <h2>Recent Sessions Here</h2>
        <div className="h2sub" id="pdRecentSub">{mine.length ? "Newest metadata rows attributed to this person — titles and counts, never content." : ""}</div>
        <div className="ftable" id="pdSessions" onClick={onSessions} dangerouslySetInnerHTML={{ __html: pdSessionsHtml(mine) }} />
      </div>
    </section>
  );
}
