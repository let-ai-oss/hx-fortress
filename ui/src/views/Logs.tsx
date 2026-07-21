import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { MenuPill } from "../components";
import { fmtRecord, recText, LVL_SHORT, RANGE_SHORT, RANGE_LONG, TAIL_POOL } from "../render";
import { LOG_BOOT, LOG_TODAY, LOG_OLDER } from "../data";
import { copyText, downloadBlob } from "../lib/util";
import { I } from "../icons";

const MAXI = "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5";
const MINI = "M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5";
const COPY_SVG = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

const initialLogs = () => [
  ...LOG_BOOT.map((r: any) => ({ ...r, d: 12 })),
  ...LOG_OLDER,
  ...LOG_TODAY.map((r: any) => ({ ...r, d: 0 })),
];

export default function Logs() {
  const app = useApp();
  const [logs, setLogs] = useState<any[]>(initialLogs);
  const [src, setSrc] = useState("all");
  const [lvl, setLvl] = useState("all");
  const [range, setRange] = useState("24h");
  const [q, setQ] = useState("");
  const [ctx, setCtx] = useState(false);
  const [tail, setTail] = useState(true);
  const [full, setFull] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef(tail); tailRef.current = tail;
  const svcRef = useRef(app.svcRunning); svcRef.current = app.svcRunning;
  const viewRef = useRef(app.view); viewRef.current = app.view;

  const recMatch = (r: any) => {
    if (src !== "all" && r.mod !== src) return false;
    if (lvl === "warn" && !["warn", "error"].includes(r.lvl)) return false;
    if (lvl === "error" && r.lvl !== "error") return false;
    const query = q.trim().toLowerCase();
    if (query && !recText(r).toLowerCase().includes(query)) return false;
    return true;
  };
  const recInRange = (r: any) => {
    if (range === "boot") return true;
    if (range === "7d") return r.d <= 7;
    if (range === "24h") return r.d === 0;
    return r.d === 0 && r.t >= "15:44";
  };

  const { paneHtml, shown, inRangeCount } = useMemo(() => {
    const inRange = logs.filter(recInRange);
    const query = q.trim();
    const rx = query ? new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig") : null;
    let count = 0;
    const parts: string[] = [];
    inRange.forEach((r, i) => {
      const match = recMatch(r);
      if (!match) {
        if (ctx && query) {
          const near = inRange.slice(Math.max(0, i - 2), i + 3).some(x => x !== r && recMatch(x));
          if (near) parts.push(`<div class="ln ctx ${r.lvl === "warn" ? "warnl" : r.lvl === "error" ? "errl" : ""}">${fmtRecord(r)}</div>`);
        }
        return;
      }
      count++;
      let html = fmtRecord(r);
      if (rx) html = html.replace(rx, '<mark class="hl">$1</mark>');
      parts.push(`<div class="ln ${r.lvl === "warn" ? "warnl" : r.lvl === "error" ? "errl" : r.msg.includes("vault RPC ok") ? "up" : ""}">${html}</div>`);
    });
    return {
      paneHtml: parts.join("") || `<div class="ln" style="color:#8b90ad">No records match this filter in this range.</div>`,
      shown: count,
      inRangeCount: inRange.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, src, lvl, range, q, ctx]);

  const hasFilter = q.trim() || src !== "all" || lvl !== "all";

  // Tail: append a fresh record every 3.8s while following, exactly like the
  // prototype (guards inside the interval; wall-clock timestamps).
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!tailRef.current || !svcRef.current) return;
      if (viewRef.current !== "logs") return;
      const now = new Date();
      const ts = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
      const r = { ...TAIL_POOL[Math.floor(Math.random() * TAIL_POOL.length)](), t: ts, d: 0 };
      setLogs(l => {
        const next = [...l, r];
        if (next.length > 400) next.splice(0, next.length - 400);
        return next;
      });
    }, 3800);
    return () => window.clearInterval(t);
  }, []);

  // Follow the bottom while tailing.
  useEffect(() => {
    if (tail && paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [paneHtml, tail]);

  // Space toggles the tail on the logs view (guarded like every shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " " && viewRef.current === "logs") { e.preventDefault(); setTail(x => !x); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Esc exits the full-page view — App dispatches this when the shell is full.
  useEffect(() => {
    const onExit = () => setFull(false);
    window.addEventListener("hx-exit-logfull", onExit);
    return () => window.removeEventListener("hx-exit-logfull", onExit);
  }, []);

  const onPaneClick = (e: React.MouseEvent) => {
    const f = (e.target as HTMLElement).closest(".fld") as HTMLElement | null;
    if (!f) return;
    setQ(f.textContent || "");
  };
  const onPaneScroll = () => {
    const p = paneRef.current!;
    if (tail && p.scrollHeight - p.scrollTop - p.clientHeight > 80) setTail(false);
  };
  const onCopy = (e: React.MouseEvent<HTMLButtonElement>) => {
    const text = [...document.querySelectorAll("#logPane .ln")].map(ln => ln.textContent).join("\n");
    copyText(text);
    const btn = e.currentTarget;
    btn.innerHTML = I.check;
    setTimeout(() => (btn.innerHTML = COPY_SVG), 1200);
  };
  const onDownload = () => {
    const text = [...document.querySelectorAll("#logPane .ln")].map(ln => ln.textContent).join("\n");
    downloadBlob(text, "text/plain", "fortress-logs-filtered.txt");
  };
  const clearFilters = () => {
    setQ(""); setSrc("all"); setLvl("all");
  };

  return (
    <section className={app.view === "logs" ? "view active" : "view"} id="view-logs">
      <div className="kicker">System</div>
      <h1>Fortress Logs</h1>
      <p className="lede">Structured records from every module on this host — the host itself, <span className="mono">session_vault</span>, <span className="mono">embed-worker</span>, <span className="mono">postgres</span> and the gateway.</p>

      <div id="logShell" className={full ? "full" : undefined}>
        <div className="logtitle">Fortress Logs — orange-corp · fortress-01</div>
        <div className="logbar oneline">
          <div className="lgroup">
            <span className="llbl">Source</span>
            <MenuPill pillId="logSrcPill" menuId="logSrcMenu" valueId="logSrcVal" mini
              value={src === "all" ? "All" : src} selKey={src} dataAttr="data-src"
              items={[
                { key: "all", label: "All sources" },
                { key: "host", label: "host" },
                { key: "session_vault", label: "session_vault" },
                { key: "embed-worker", label: "embed-worker" },
                { key: "postgres", label: "postgres" },
                { key: "gateway", label: "gateway" },
              ]}
              onPick={setSrc} />
          </div>
          <div className="lgroup">
            <span className="llbl">Level</span>
            <MenuPill pillId="logLevelPill" menuId="logLevelMenu" valueId="logLevelVal" mini
              value={(LVL_SHORT as any)[lvl]} selKey={lvl} dataAttr="data-lf"
              items={[
                { key: "all", label: "Everything" },
                { key: "warn", label: "Warnings & errors" },
                { key: "error", label: "Errors only" },
              ]}
              onPick={setLvl} />
          </div>
          <div className="lgroup">
            <span className="llbl">Range</span>
            <MenuPill pillId="logRangePill" menuId="logRangeMenu" valueId="logRangeVal" mini
              value={(RANGE_SHORT as any)[range]} selKey={range} dataAttr="data-r"
              items={[
                { key: "1h", label: "Last hour" },
                { key: "24h", label: "Last 24 hours" },
                { key: "7d", label: "Last 7 days" },
                { key: "boot", label: "Since last boot" },
              ]}
              onPick={setRange} />
          </div>
          <div className="search compact" style={{ flex: "1 1 200px", minWidth: 160 }}>
            <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-subtle)" }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input id="logFilter" placeholder="Search, or key=value…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <button className={ctx ? "fpill sel" : "fpill"} id="logCtxBtn" onClick={() => setCtx(c => !c)}>{ctx ? "Context: ±2" : "Context: Off"}</button>
          <span className="help" style={{ margin: "0 0 8px 0" }}><span className="q">?</span><div className="pop">
            <b>Context</b> shows the two records before and after every match when you search or filter — dimmed, so a hit is never read in isolation. Off shows matching records only.
          </div></span>
          <button className={tail ? "fpill sel" : "fpill"} id="logTailBtn" onClick={() => setTail(t => !t)}>{tail ? "Tail: On" : "Tail: Paused"}</button>
          <button className="iconbtn" id="logCopyBtn" title="Copy visible rows" style={{ width: 36, height: 36 }} onClick={onCopy} dangerouslySetInnerHTML={{ __html: COPY_SVG }} />
          <button className="iconbtn" id="logDownloadBtn" title="Download the filtered view" style={{ width: 36, height: 36 }} onClick={onDownload}>
            <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4v10M8.5 11L12 14.5 15.5 11M5 18h14" /></svg>
          </button>
          <button className="iconbtn" id="logMaxBtn" title="Full-page view" style={{ width: 36, height: 36 }} onClick={() => setFull(f => !f)}>
            <svg className="ic" id="logMaxIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={full ? MINI : MAXI} /></svg>
          </button>
        </div>
        <div className={hasFilter ? "minibanner on" : "minibanner"} id="logFilterBanner">
          <span id="logFilterText">{hasFilter ? `Filtering live — showing ${shown} of ${inRangeCount} records in range.` : ""}</span>
          <span style={{ flex: 1 }}></span>
          <button className="btn link sm" id="logFilterClear" onClick={clearFilters}>Clear</button>
        </div>
        <div className="logpane scrolly" id="logPane" ref={paneRef} onClick={onPaneClick} onScroll={onPaneScroll}
          dangerouslySetInnerHTML={{ __html: paneHtml }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 10, fontSize: 14.5, color: "var(--text-subtle)" }}>
          <span id="logCount">Showing {shown} of {inRangeCount} records · range: {(RANGE_LONG as any)[range]}</span>
          <span>tail follows new records · scroll up or press <span className="kbd">Space</span> to pause</span>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>Log Files on Disk</h2>
        <div className="pathrow"><span className="k">Structured log</span><span className="p">~/.let/hx-fortress/logs/fortress.jsonl</span><button className="btn ghost sm" onClick={e => copyText("~/.let/hx-fortress/logs/fortress.jsonl", e.currentTarget)}>Copy path</button></div>
        <div className="pathrow"><span className="k">Service stdout</span><span className="p">~/.let/hx-fortress/logs/service.log</span><button className="btn ghost sm" onClick={e => copyText("~/.let/hx-fortress/logs/service.log", e.currentTarget)}>Copy path</button></div>
        <div className="pathrow"><span className="k">Status snapshot</span><span className="p">~/.let/hx-fortress/runtime/status.json</span><button className="btn ghost sm" onClick={e => copyText("~/.let/hx-fortress/runtime/status.json", e.currentTarget)}>Copy path</button></div>
        <div className="why-note" style={{ marginTop: 14 }}>The terminal equivalent of this page is <code className="hx">hx-fortress logs</code> — add a module (<code className="hx">hx-fortress logs session_vault</code>) or <span className="mono">--lines 200</span> for more history.</div>
      </div>
    </section>
  );
}
