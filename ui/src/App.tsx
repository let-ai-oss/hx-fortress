import React, { useEffect, useState } from "react";
import { AppProvider, useApp, ViewName } from "./state";
import { FORT } from "./data";
import { I } from "./icons";
import { closeAllMenus, copyText } from "./lib/util";
import Overview from "./views/Overview";
import { Sessions, SessionDetail } from "./views/Sessions";
import { Adoption, PersonDetail } from "./views/Adoption";
import Residency from "./views/Residency";
import Compliance from "./views/Compliance";
import { Postgres, Blob, Embeddings } from "./views/Health";
import Ops from "./views/Ops";
import Logs from "./views/Logs";

const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>';
const MOON = '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const VIEW_KEYS: Record<string, ViewName> = { "1": "overview", "2": "sessions", "3": "adoption", "4": "residency", "5": "compliance", "6": "postgres", "7": "blob", "8": "embeddings", "9": "ops", "0": "logs" };

function Chrome() {
  const app = useApp();
  const [theme, setThemeState] = useState<string>(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const kbdOpen = app.shortcutsOpen;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Keyboard: number keys for sections, ? for the shortcuts modal, Esc cascade.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") { app.toggleShortcuts(); return; }
      const v = VIEW_KEYS[e.key];
      if (v) app.goto(v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [app.goto, app.toggleShortcuts]);
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const shell = document.getElementById("logShell");
      if (shell && shell.classList.contains("full")) { window.dispatchEvent(new CustomEvent("hx-exit-logfull")); return; }
      if (app.anyDialogOpen) { app.dismissDialog(); return; }
      closeAllMenus();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [app.anyDialogOpen, app.dismissDialog]);

  return (
    <>
      <div className="topbar">
        <div className="mark"><i></i><i></i><i></i><i></i></div>
        <div className="wordmark">HX Fortress <span>UI</span></div>

        <div className="chip" id="svcChip" style={{ marginLeft: 8 }}>
          <span className="dot" id="svcDot" style={{ background: app.svcRunning ? "var(--ok)" : "var(--border-strong)" }}></span> <span id="svcLabel">{app.svcRunning ? "Running" : "Stopped"}</span>
          <div className="pop left">
            <div className="plbl">Service</div>
            <span id="popSvc">{app.svcRunning ? `Running — systemd · pid ${app.pid}` : "Stopped — run `hx-fortress start` to resume"}</span>
            <div className="plbl">Host</div>
            <span className="mono" style={{ fontSize: 13.5 }}>fortress-01.orange-corp.internal</span> <span className="psub">· Ubuntu 24.04 · up 12d 7h</span>
            <div className="plbl">Relay tunnel</div>
            <span id="popTunnel">{app.svcRunning ? "Connected — outbound only · last beat 4s ago" : "Offline — the service is stopped"}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn ghost sm" onClick={() => app.goto("ops")}>Ops Tools →</button>
              <button className="btn ghost sm" onClick={() => app.goto("logs")}>Logs →</button>
            </div>
          </div>
        </div>

        <div className="spacer"></div>

        <button className="iconbtn" id="themeBtn" title="Switch theme" onClick={() => setThemeState(t => (t === "dark" ? "light" : "dark"))}>
          <svg className="ic" id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" dangerouslySetInnerHTML={{ __html: theme === "dark" ? SUN : MOON }} />
        </button>

        <div className="chip click" id="fortChip" onClick={() => app.goto("ops")}>
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 4.8-3.2 7.7-7 9-3.8-1.3-7-4.2-7-9V6z" /></svg>
          <b>Orange Corp | HX Fortress</b>
          <div className="pop">
            <div className="pname">Orange Corp | HX Fortress</div>
            <div className="psub">run by orange-corp on its own servers</div>
            <div className="plbl">Fortress id</div>
            <span className="mono" style={{ fontSize: 13 }}>vault_93cc57c54c1a4618</span>
            <div className="plbl">Enrolled to</div>
            orange-corp <span className="psub">· since Mar 12, 2026</span>
            <div className="plbl"><code className="hx">hx-fortress</code> version</div>
            <span className="mono" style={{ fontSize: 13.5 }} id="popVer">v{app.ver}</span> <span className="psub" id="popVerSub">{app.ver === FORT.nextVersion ? "· just updated" : "· stable channel"}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn ghost sm" onClick={e => { e.stopPropagation(); app.goto("ops"); }}>Ops Tools →</button>
            </div>
          </div>
        </div>

        <div className="chip">
          <span className="avatar">DM</span> <b>Dana Mandarin</b>
          <div className="pop">
            <div className="pname">Dana Mandarin</div>
            <div className="psub">IT Administrator · Orange Corp</div>
            <div className="plbl">Console access</div>
            administrator — full ops &amp; compliance surfaces
            <div className="plbl">This console shows</div>
            session metadata only — never transcript content
          </div>
        </div>
      </div>

      <div className="shell">
        <nav className="side">
          <div className="navlbl">Operate</div>
          <NavBtn v="overview" n="01" label="Overview" />
          <NavBtn v="sessions" n="02" label="Sessions" />
          <NavBtn v="adoption" n="03" label="Adoption" />
          <div className="navlbl">Compliance</div>
          <NavBtn v="residency" n="04" label="Residency" />
          <NavBtn v="compliance" n="05" label="Posture & Audit" />
          <div className="navlbl">Setup &amp; health</div>
          <NavBtn v="postgres" n="06" label="Postgres" />
          <NavBtn v="blob" n="07" label="Blob Storage" />
          <NavBtn v="embeddings" n="08" label="Embeddings" />
          <div className="navlbl">System</div>
          <NavBtn v="ops" n="09" label="Ops Tools" />
          <NavBtn v="logs" n="10" label="Logs" />
        </nav>

        <main>
          <Overview />
          <Sessions />
          <SessionDetail />
          <Adoption />
          <PersonDetail />
          <Residency />
          <Compliance />
          <Postgres />
          <Blob />
          <Embeddings />
          <Ops />
          <Logs />
        </main>
      </div>

      <footer>
        <div className="inner">
          <div className="mark" style={{ marginTop: 5 }}><i></i><i></i><i></i><i></i></div>
          <div className="txt">
            <b>HX Fortress UI runs on the fortress host, as part of the <code className="hx">hx-fortress</code> service.</b><br />
            This console is served from the fortress itself and shows session metadata only.<br />
            Transcript content never appears here.
          </div>
          <div className="oss">
            <div className="osslbl">Open source</div>
            <a href="https://github.com/hx-framework/hx-fortress"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.66.41.36.78 1.06.78 2.14v3.17c0 .31.2.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" /></svg> github.com/hx-framework/hx-fortress</a>
            <a href="https://hxframework.org">About the HX framework</a>
          </div>
        </div>
      </footer>

      <div className={kbdOpen ? "overlayw open" : "overlayw"} id="kbdOverlay"
        onClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-close]")) app.closeShortcuts(); }}>
        <div className="modal" style={{ width: "min(560px,100%)" }}>
          <div className="mhead">
            <div className="row1"><h3>Keyboard Shortcuts</h3><button className="x" data-close>✕</button></div>
            <p className="msub">Available anywhere, except while typing in a field.</p>
          </div>
          <div className="mbody scrolly" style={{ paddingBottom: 26 }}>
            <div className="clirow"><span className="c"><span className="kbd">1</span> – <span className="kbd">9</span></span><span className="d">Go to a section: Overview, Sessions, Adoption, Residency, Posture &amp; Audit, Postgres, Blob Storage, Embeddings, Ops Tools.</span></div>
            <div className="clirow"><span className="c"><span className="kbd">0</span></span><span className="d">Go to Logs.</span></div>
            <div className="clirow"><span className="c"><span className="kbd">?</span></span><span className="d">Show or hide this menu.</span></div>
            <div className="clirow"><span className="c"><span className="kbd">Esc</span></span><span className="d">Close dialogs and menus, or leave the full-page log view.</span></div>
          </div>
        </div>
      </div>

      <VerifyOverlay />
    </>
  );
}

function NavBtn({ v, n, label }: { v: ViewName; n: string; label: string }) {
  const app = useApp();
  return (
    <button className={app.view === v ? "active" : undefined} onClick={() => app.goto(v)}>
      <span className="n">{n}</span> {label}
    </button>
  );
}

function VerifyOverlay() {
  const app = useApp();
  const s = app.verifyTarget;
  return (
    <div className={app.verifyOpen ? "overlayw open" : "overlayw"} id="verifyOverlay"
      onClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-close]")) app.closeVerify(); }}>
      <div className="modal" style={{ width: "min(720px,100%)" }}>
        <div className="mhead">
          <div className="row1"><h3>Verify Residency</h3><button className="x" data-close>✕</button></div>
          <p className="msub" id="verifySub" dangerouslySetInnerHTML={{ __html: s ? `“${s.title}” — ${s.person.name} · <span class="mono">${s.family}/${s.sid}</span>` : "Proving where this session rests — live against the fortress Postgres, the bucket, and the cloud index." }} />
        </div>
        <div className="mbody scrolly">
          <div className="vsteps" id="verifySteps">
            {app.verifySteps.map((st, i) => (
              <div key={i} className={"vstep" + (st.shown ? " onv" : "") + (st.done ? " okv2" : "")} id={"vstep" + i}>
                <div className="vnode" dangerouslySetInnerHTML={{ __html: st.done ? (st.none ? I.xS : I.checkS) : '<span class="spin"></span>' }} />
                <div className="vbody"><div className="vname">{st.name}</div><div className="vsub" dangerouslySetInnerHTML={{ __html: st.sub }} /><div className="vres" id={"vres" + i}>{st.done ? st.res : ""}</div></div>
              </div>
            ))}
          </div>
          <div className={app.verifyProof ? "proof on" : "proof"} id="verifyProof">{app.verifyProof}</div>
        </div>
        <div className="mfoot">
          <span className="status" id="verifyStatus" dangerouslySetInnerHTML={{ __html: app.verifyDone ? `<b style="color:var(--ok)">Resides on enterprise systems</b> — all four checks passed.` : "Running checks…" }} />
          <span className="grow"></span>
          <button className="btn ghost" id="verifyCopyBtn" style={{ display: app.verifyDone ? "" : "none" }} onClick={e => copyText(app.verifyProof, e.currentTarget)}>Copy proof</button>
          <button className="btn" data-close>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Chrome />
    </AppProvider>
  );
}
