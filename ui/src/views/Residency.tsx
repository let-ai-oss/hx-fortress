import React, { useState } from "react";
import { useApp } from "../state";
import { ResultLine, useResultLine } from "../components";
import {
  gatesHtml, gatesNoteHtml, auditHistoryHtml, AUDIT_RUNS_SEED, spotListHtml,
  auditCopyText, CLOUD_ONLY,
} from "../render";
import { SESSIONS, fmtInt, TOTAL_SESSIONS, N_ROSTER, N_REPOS } from "../data";
import { copyText, sleep } from "../lib/util";

export default function Residency() {
  const app = useApp();
  const [incident, setIncident] = useState(false);
  const [auditRuns, setAuditRuns] = useState<any[]>(AUDIT_RUNS_SEED);
  const [auditing, setAuditing] = useState(false);
  const [flow, setFlow] = useState({ on: false, phase: "Auditing…", pct: 0 });
  const [result, showResult] = useResultLine();

  const total = fmtInt(TOTAL_SESSIONS);
  const ok = fmtInt(TOTAL_SESSIONS - CLOUD_ONLY);

  const runAudit = async () => {
    if (auditing) return;
    setAuditing(true);
    for (let p = 0; p <= 55; p += 5) {
      setFlow({ on: true, phase: `Walking hx.sessions — ${fmtInt(Math.round((p / 55) * TOTAL_SESSIONS))} of ${total} rows…`, pct: p });
      await sleep(160);
    }
    for (let p = 55; p <= 90; p += 5) {
      setFlow({ on: true, phase: `Heading bucket objects — ${fmtInt(Math.round(((p - 55) / 35) * TOTAL_SESSIONS))} verified…`, pct: p });
      await sleep(170);
    }
    setFlow({ on: true, phase: "Checking the HX Fortress relay index for content…", pct: 97 });
    await sleep(700);
    setFlow({ on: true, phase: "Checking the HX Fortress relay index for content…", pct: 100 });
    await sleep(250);
    setFlow({ on: false, phase: "", pct: 0 });
    if (incident) {
      showResult(`Audit complete — ${fmtInt(CLOUD_ONLY)} of ${total} attributed sessions found only at the relay. Residency FAILED.`, true);
    } else {
      showResult(`Audit complete — ${total} of ${total} verified on-fortress · 0 transcript bytes at the relay · 3m 58s (sampled).`);
      setAuditRuns(r => [["", "Just now · on-demand", "run by dana.mandarin from this console", ["ok", "Verified"], "3m 58s"], ...r]);
      app.addTrail("Ran an on-demand residency audit", `verified ${total} of ${total} · 0 cloud content`);
    }
    setAuditing(false);
  };

  const onSpot = (e: React.MouseEvent) => {
    const v = (e.target as HTMLElement).closest("[data-verify]") as HTMLElement | null;
    if (v) { e.stopPropagation(); app.verifySession(SESSIONS[Number(v.dataset.verify)]); return; }
    const pl = (e.target as HTMLElement).closest(".personlink") as HTMLElement | null;
    if (pl) { e.stopPropagation(); app.openPerson(pl.dataset.person!); return; }
    const line = (e.target as HTMLElement).closest("[data-ses]") as HTMLElement | null;
    if (line) app.openSession(SESSIONS[Number(line.dataset.ses)]);
  };

  return (
    <section className={app.view === "residency" ? "view active" : "view"} id="view-residency">
      <div className="kicker">Compliance</div>
      <h1>Residency — Prove Where Sessions Rest</h1>
      <p className="lede">A session resides on enterprise systems when its metadata row is in this fortress's Postgres, its transcript object is in the orange-corp bucket at the expected path and byte count, and the HX Fortress relay holds only routing pointers. This page proves all three — per session, and fleet-wide.</p>

      <div className="banner dangerb" id="incidentBanner" style={{ display: incident ? "flex" : "none" }}>
        <span className="badge">!</span>
        <span className="btxt"><b>Previewing the incident state.</b> This is what a silent misroute looks like — the failure this page exists to catch. This fortress is actually healthy.</span>
        <button className="btn" id="incidentExitBtn" onClick={() => setIncident(false)}>Exit preview</button>
      </div>

      <div className="stats" id="resStats">
        <div className="stat"><span className="lbl">Verified on-fortress</span><div className="big" id="resVerified" style={{ color: incident ? "var(--warn)" : "" }}>{incident ? ok : total}</div><div className="sub" id="resVerifiedSub">of {total} attributed sessions</div></div>
        <div className="stat"><span className="lbl">At the relay</span><div className="big" id="resCloud" style={{ color: incident ? "var(--danger)" : "" }}>{incident ? fmtInt(CLOUD_ONLY) : "0"}</div><div className="sub" id="resCloudSub">{incident ? "sessions found ONLY at the relay — never delivered here" : "transcript bytes for orange-corp sessions"}</div></div>
        <div className="stat"><span className="lbl">Last full audit</span><div className="big" id="resLastAudit">02:00</div><div className="sub" id="resLastAuditSub">{incident ? `today · found ${fmtInt(CLOUD_ONLY)} cloud-only sessions` : "today · 4m 12s · every row + object"}</div></div>
        <div className="stat"><span className="lbl">Next audit</span><div className="big">02:00</div><div className="sub">tomorrow · nightly schedule</div></div>
      </div>

      <div className="panel">
        <h2>Fleet Audit</h2>
        <div className="h2sub">Walks every attributed session: Postgres row present → bucket object at the expected path with the expected bytes → no transcript content at the HX Fortress relay.</div>
        <div className="facts" id="auditFacts">
          <div className="frw"><span className="k">Scope</span><span><span className="v" id="auditScope">{total} sessions · {N_ROSTER} people · {N_REPOS} repos</span><div className="vs">everything attributed to orange-corp</div></span></div>
          <div className="frw"><span className="k">Postgres rows</span><span><span className="v" id="auditPg">{incident ? ok : total} present</span><div className={incident ? "vs warnv" : "vs"} id="auditPgSub">{incident ? `${fmtInt(CLOUD_ONLY)} attributed sessions have no metadata row here` : "hx.sessions — every attributed session mirrored"}</div></span></div>
          <div className="frw"><span className="k">Bucket objects</span><span><span className="v" id="auditBlob">{incident ? ok : total} verified</span><div className={incident ? "vs warnv" : "vs"} id="auditBlobSub">{incident ? "the bucket has received 0 new bytes in 10 days" : "path + byte count match the metadata row · 0 missing, 0 diverged"}</div></span></div>
          <div className="frw"><span className="k">Relay content</span><span><span className="v" id="auditCloud">{incident ? `${fmtInt(CLOUD_ONLY)} sessions` : "None"}</span><div className="vs" id="auditCloudSub" style={{ color: incident ? "var(--danger)" : undefined }}>{incident ? "transcript content held at the relay for sessions attributed to orange-corp" : "the relay holds routing pointers and this metadata mirror, nothing else"}</div></span></div>
        </div>
        <div className={flow.on ? "upflow on" : "upflow"} id="auditFlow">
          <div className="phase" id="auditPhase">{flow.phase}</div>
          <div className="pbar"><i id="auditBar" style={{ width: flow.pct + "%" }} /></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn ghost" id="auditCopyBtn" onClick={e => copyText(auditCopyText(), e.currentTarget)}>Copy audit summary</button>
          <button className="btn" id="auditRunBtn" disabled={auditing} onClick={runAudit}>Run audit now</button>
        </div>
        <ResultLine id="auditResult" state={result} />
      </div>

      <div className="panel">
        <h2>Spot-Check a Session</h2>
        <div className="h2sub">Pick any session and watch the proof chain run — the same checks the nightly audit runs, one session at a time.</div>
        <div className="ftable" id="resSpotList" onClick={onSpot} dangerouslySetInnerHTML={{ __html: spotListHtml() }} />
        <div style={{ marginTop: 12, fontSize: 14, color: "var(--text-subtle)" }}>Any session can be verified from its detail page — these are the five newest.</div>
      </div>

      <div className="panel" id="gatesPanel" ref={el => app.registerPanel("gates", el)}>
        <h2>The Routing Gates</h2>
        <div className="h2sub">Four gates decide whether a session reaches this fortress. A session that fails any gate quietly lands in a personal space instead — this table is where “quietly” becomes visible.</div>
        <div className="rowlist ops" id="gatesList" dangerouslySetInnerHTML={{ __html: gatesHtml(incident) }} />
        <div className="why-note" style={{ marginTop: 14 }} id="gatesNote" dangerouslySetInnerHTML={{ __html: gatesNoteHtml(incident) }} />
      </div>

      <div className="panel">
        <h2>Audit History</h2>
        <div className="rowlist ops" id="auditHistory" dangerouslySetInnerHTML={{ __html: auditHistoryHtml(incident, auditRuns) }} />
        <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, color: "var(--text-subtle)" }}>Retained 180 days · exportable for compliance reviews</span>
          <button className="btn ghost sm" id="incidentBtn" onClick={() => { setIncident(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Preview the incident state</button>
        </div>
      </div>
    </section>
  );
}
