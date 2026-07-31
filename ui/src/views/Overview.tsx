import React, { useRef, useState } from "react";
import { useApp } from "../state";
import { attentionHtml, ATTENTION, growthTip } from "../render";
import { GROWTH, fmtInt, fmtMB, TOTAL_SESSIONS, TOTAL_KB, N_ROSTER } from "../data";

// Health tiles — content matches the prototype's paintService() exactly.
const TILES: [string, string, string, string][] = [
  ["tilePg", "postgres", "Ready", "embedded 18.4.0 · 12 migrations"],
  ["tileBlob", "blob", "Healthy", "s3 · verified 184 ms · 06:00"],
  ["tileTunnel", "ops", "Connected", "outbound only · beat 4s ago"],
  ["tileEmbed", "embeddings", "Indexing", "402k vectors · backlog 214"],
  ["tileIngest", "sessions", "Flowing", "last commit 12s ago · 0 errors"],
];
const TILE_HEADS: Record<string, string> = {
  tilePg: "Postgres", tileBlob: "Blob storage", tileTunnel: "Relay tunnel",
  tileEmbed: "Embeddings", tileIngest: "Ingest",
};

export default function Overview() {
  const app = useApp();
  const total = fmtInt(TOTAL_SESSIONS);
  const barsRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; left: number; show: boolean }>({ text: "", left: 0, show: false });

  const onAttention = (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest("[data-att]") as HTMLElement | null;
    if (!b) return;
    const a = ATTENTION[Number(b.dataset.att)].act as any;
    if (a.person) { app.openPerson(a.person); return; }
    if (a.adfilter) { app.setAdFilter(a.adfilter); app.goto("adoption"); return; }
    app.goto(a.goto, a.then);
  };

  const onBarsOver = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "I") {
      const r = t.getBoundingClientRect(), pr = barsRef.current!.getBoundingClientRect();
      setTip({ text: t.dataset.tip || "", left: r.left - pr.left + r.width / 2, show: true });
    }
  };

  return (
    <section className={app.view === "overview" ? "view active" : "view"} id="view-overview">
      <div className="kicker">This fortress</div>
      <h1>Operational truth, at a glance</h1>
      <p className="lede">Orange Corp | HX Fortress, serving <span id="ovPeopleLede">{N_ROSTER}</span> people. <code className="hx">hx-fortress</code> holds session metadata in its own Postgres and transcripts in the organization's bucket — this console shows the metadata, never the content.</p>

      <div className="tiles" id="healthTiles">
        {TILES.map(([id, dest, state, sub]) => (
          <div key={id}
            className={"tile" + (app.svcRunning ? "" : " off")}
            id={id}
            onClick={() => app.goto(dest as any)}>
            <div className="thead"><span className="tdot"></span> {TILE_HEADS[id]}</div>
            <div className="tstate">{app.svcRunning ? state : "Stopped"}</div>
            <div className="tsub">{app.svcRunning ? sub : "service stopped"}</div>
          </div>
        ))}
      </div>

      <div className="stats">
        <div className="stat">
          <span className="lbl">Sessions on this fortress</span>
          <div className="big statlink" onClick={() => app.goto("sessions")}><span id="ovSessions">{total}</span><div className="pop">Open the metadata explorer →</div></div>
          <div className="sub"><span id="ovBytes">{fmtMB(TOTAL_KB)}</span> · <span className="dashy">metadata only<div className="pop">
            <b>What this console holds</b>
            <div style={{ marginTop: 6 }}>Titles, people, repos, sizes, timestamps and storage locations — mirrored into the fortress Postgres. Transcript content rests in the bucket and is never displayed here.</div>
          </div></span></div>
        </div>
        <div className="stat">
          <span className="lbl">Residency</span>
          <div className="big statlink" onClick={() => app.goto("residency")}><span id="ovResidency">Verified</span><div className="pop">Open the residency audit →</div></div>
          <div className="sub" id="ovResidencySub">{total} of {total} on-fortress · audited 02:00</div>
        </div>
        <div className="stat">
          <span className="lbl">Ingested today</span>
          <div className="big statlink" id="ovTodayBig" onClick={() => app.goto("sessions")}>132<div className="pop">See today's sessions →</div></div>
          <div className="sub">sessions · 21.4 MB · <span className="dashy">41 people active<div className="pop">
            <b>Active in the last 24 hours</b>
            <div style={{ marginTop: 6 }}>41 of 42 rostered people had at least one session commit mirrored to this fortress. The quiet one: Lena Kraus — <code className="hx">hx</code> not installed.</div>
          </div></span></div>
        </div>
        <div className="stat">
          <span className="lbl">RPC health</span>
          <div className="big"><span className="hovinfo">38 ms<div className="pop">
            <b>Vault RPC latency, p95 over the last hour.</b>
            <div style={{ marginTop: 6 }}>Measured across <span className="mono">ingestCommit</span>, <span className="mono">listSessions</span> and the blob RPCs arriving over the tunnel. p50 is 14 ms. 0 errors in the last 24 h.</div>
          </div></span></div>
          <div className="sub">p95 · 3,412 calls today · 0 errors</div>
        </div>
      </div>

      <div className="sechead">Needs Attention</div>
      <div className="panel" id="attentionPanel" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <div className="rowlist" id="attentionList" onClick={onAttention} dangerouslySetInnerHTML={{ __html: attentionHtml() }} />
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Where Sessions Land</h2>
          <div className="h2sub">Destination inventory for sessions attributed to orange-corp — the number that catches silent misrouting.</div>
          <div className="facts">
            <div className="frw"><span className="k">This fortress</span><span><span className="v" id="destFortress">{total} sessions</span><div className="vs okv">every attributed session — routing verified nightly</div></span></div>
            <div className="frw"><span className="k">HX Fortress relay</span><span><span className="v">0 sessions</span><div className="vs">the relay holds routing pointers, never transcript bytes</div></span></div>
            <div className="frw"><span className="k">Unattributed</span><span><span className="v" id="destUnattributed">1 repo</span><div className="vs warnv"><span className="mono">orange-corp/rind</span> is unclaimed — its sessions route to personal spaces</div></span><button className="btn ghost sm" onClick={() => app.goto("residency", "gates")}>Review</button></div>
          </div>
        </div>
        <div className="panel">
          <h2>Right Now</h2>
          <div className="facts">
            <div className="frw"><span className="k">Throughput</span><span><span className="v">0.4 sessions/min</span><div className="vs">1.1 MB/min into the bucket</div></span></div>
            <div className="frw"><span className="k">Embed backlog</span><span><span className="v" id="rnBacklog">214 turns</span><div className="vs">draining · ~6 min at current rate</div></span></div>
            <div className="frw"><span className="k">Last ingest</span><span><span className="v">12s ago</span><div className="vs"><span className="mono">ingestCommit</span> · Squeeze · 184 KB</div></span></div>
            <div className="frw"><span className="k">Storage self-test</span><span><span className="v">Passed</span><div className="vs">06:00 today · write + read-back in 184 ms</div></span></div>
            <div className="frw"><span className="k">Uptime</span><span><span className="v">12d 7h</span><div className="vs">service since Jul 9, 09:02 · <code className="hx">hx-fortress</code> <span className="mono" id="rnVer">v{app.ver}</span></div></span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Storage Growth</h2>
        <div className="h2sub">Bucket bytes added per day, last 30 days — hover any bar for the exact numbers.</div>
        <div className="chart">
          <div className="yaxis"><span>40 MB</span><span>20 MB</span><span>0</span></div>
          <div className="plot">
            <div className="gridl" style={{ top: 0 }}></div>
            <div className="gridl" style={{ top: "50%" }}></div>
            <div className="bars" id="growthBars" ref={barsRef} onMouseOver={onBarsOver} onMouseLeave={() => setTip(t => ({ ...t, show: false }))}>
              <div className="tip" id="growthTip" style={{ display: tip.show ? "block" : "none", left: tip.left }}>{tip.text}</div>
              {GROWTH.map((mb, i) => (
                <i key={i}
                  className={mb >= 25 ? "hot" : undefined}
                  style={{ height: Math.max(3, (mb / 40) * 100) + "%" }}
                  data-tip={growthTip(i)} />
              ))}
            </div>
            <div className="axis"><span>Jun 22</span><span>Jun 29</span><span>Jul 6</span><span>Jul 13</span><span>today</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
