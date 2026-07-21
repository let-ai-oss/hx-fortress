import React, { useEffect, useMemo, useState } from "react";
import { useApp, storeUri } from "../state";
import { Term, ResultLine, useResultLine, useSubFlash } from "../components";
import { keysHtml, KEYS_SEED, checkupRows, checkupRowHtml } from "../render";
import { FORT } from "../data";
import { sleep } from "../lib/util";

export default function Ops() {
  const app = useApp();
  const { svcRunning, pid, ver } = app;

  const [svcTerm, setSvcTerm] = useState("");
  const [statusTerm, setStatusTerm] = useState("");
  const [credTerm, setCredTerm] = useState("");
  const svcVs = useSubFlash("");
  const [updSub, setUpdSub] = useState<{ html: string; ok: boolean }>({ html: "stable channel · updated Jul 9", ok: false });
  const [updAvail, setUpdAvail] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [keysState, setKeys] = useState<any[]>(KEYS_SEED.map(k => ({ ...k })));
  // The blob credential belongs to the store, so this panel shows whatever the
  // Blob Storage page holds — including which provider's shape it takes.
  const keys = useMemo(() => keysState.map(k => (k.id !== "s3" ? k : {
    ...k,
    label: app.store.kind === "gcs" ? "GCS service-account key" : "Blob storage key",
    masked: app.store.maskedKey,
    rotated: app.store.credRotated,
    sub: `reads and writes ${storeUri(app.store)} · inline in credentials.json`,
    fields: app.store.kind === "gcs"
      ? [{ ph: "paste the service-account key JSON", multiline: true }]
      : k.fields,
  })), [keysState, app.store]);
  const [rotating, setRotating] = useState<string | null>(null);
  const [checkupHtml, setCheckupHtml] = useState("");
  const [checkupBusy, setCheckupBusy] = useState(false);
  const [checkupResult, showCheckupResult] = useResultLine();

  // The Service sub-line: normal value derives from state; a green flash after
  // restart/start overrides it for 4s (the prototype's subFlash semantics).
  const svcVsText = svcRunning
    ? `systemd · pid ${pid} · since Jul 9, 09:02`
    : "stopped — devices keep queueing safely; nothing is lost while the fortress is down";

  const stopStart = () => {
    if (svcRunning) {
      app.setSvcRunning(false);
      setSvcTerm(`<span class="tok">$ hx-fortress stop</span>\nFortress stopped (systemd). Run \`hx-fortress start\` to resume.`);
      app.addTrail("Stopped the fortress service", "hx-fortress stop · devices queue safely while down");
    } else {
      app.setSvcRunning(true); app.setPid(41913);
      setSvcTerm(`<span class="tok">$ hx-fortress start</span>\nFortress started (systemd, pid 41913).\nlogs: ~/.let/hx-fortress/logs/fortress.jsonl\nstatus: hx-fortress status`);
      app.addTrail("Started the fortress service", "hx-fortress start · systemd, pid 41913");
    }
  };
  const restart = async () => {
    if (!svcRunning) return;
    setSvcTerm(`<span class="tok">$ hx-fortress stop && hx-fortress start</span>\nFortress stopped (systemd). Run \`hx-fortress start\` to resume.`);
    await sleep(700);
    app.setPid(41913);
    setSvcTerm(`<span class="tok">$ hx-fortress stop && hx-fortress start</span>\nFortress stopped (systemd). Run \`hx-fortress start\` to resume.\nFortress started (systemd, pid 41913).\nlogs: ~/.let/hx-fortress/logs/fortress.jsonl\nstatus: hx-fortress status`);
    svcVs.flash("restarted clean — systemd · pid 41913");
    app.addTrail("Restarted the fortress service", "stop + start · new pid 41913");
  };
  const runStatus = () => {
    setStatusTerm(svcRunning
      ? `<span class="tok">$ hx-fortress status</span>\nFortress:   running (systemd, pid ${pid})\nConnection: <span class="tko">connected</span>\nModules:\n  session_vault  <span class="tko">running</span>`
      : `<span class="tok">$ hx-fortress status</span>\nFortress:   stopped - run \`hx-fortress start\` to resume\nConnection: offline\nModules:    unavailable`);
  };

  const updCheck = () => {
    if (ver === FORT.nextVersion) {
      setUpdSub({ html: `hx-fortress is already on the latest version (v${ver}). Nothing to do. 🎉`, ok: true });
      setTimeout(() => setUpdSub({ html: "stable channel · up to date", ok: false }), 4000);
      return;
    }
    setUpdSub({ html: `${FORT.nextVersion} is available — nothing was installed yet.`, ok: true });
    setUpdAvail(true);
  };
  const updNow = async () => {
    setUpdating(true);
    for (let p = 0; p <= 100; p += 4) {
      setUpdSub({ html: `<span class="minibar"><i style="width:${p}%"></i></span>Downloading hx-fortress-linux-x64.gz (14.8 MB) — ${p}%`, ok: false });
      await sleep(50);
    }
    for (const [label, ms] of [["Unpacking…", 420], ["Verifying sha-256 against the published checksum…", 600], [`restarting Fortress (systemd, was pid ${pid})…`, 800], ["Reconnecting this console…", 700]] as [string, number][]) {
      setUpdSub({ html: `<span class="minibar"><i style="width:100%"></i></span>${label}`, ok: false });
      await sleep(ms);
    }
    app.setVer(FORT.nextVersion); app.setPid(42007);
    setUpdAvail(false); setUpdating(false);
    setUpdSub({ html: `Just updated to ${FORT.nextVersion} — sha256 3f9c21ab54ce… verified · service restarted, console reconnected.`, ok: true });
    app.addTrail(`Updated hx-fortress 0.12.1 → ${FORT.nextVersion}`, "sha-256 verified · service restarted cleanly");
  };

  const onKeys = (e: React.MouseEvent) => {
    const rot = (e.target as HTMLElement).closest("[data-rotate]") as HTMLElement | null;
    if (rot) { setRotating(r => (r === rot.dataset.rotate ? null : rot.dataset.rotate!)); return; }
    const save = (e.target as HTMLElement).closest("[data-rotsave]") as HTMLElement | null;
    if (save) {
      // A credential may be several fields — every one of them is required.
      const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#keysList input, #keysList textarea")];
      const empty = inputs.find(i => !i.value.trim());
      if (!inputs.length || empty) { empty?.focus(); return; }
      const id = save.dataset.rotsave!;
      const k = keys.find(x => x.id === id);
      if (id === "s3") {
        // The blob key lives with the store, so both surfaces stay in step.
        const v = inputs[0].value.trim();
        app.rotateStoreCredentials(
          app.store.kind === "s3" ? v.slice(0, 4) + "••••••••" + v.slice(-4) : "svc-acct ••••••••" + v.slice(-4),
          k.label.toLowerCase());
      } else {
        app.addTrail(`Rotated the ${k.label.toLowerCase()}`, `hx-fortress credentials set ${id} · restart pending`);
      }
      setKeys(ks => ks.map(x => (x.id === id ? { ...x, rotated: true } : x)));
      setRotating(null);
      setCredTerm(`<span class="tok">$ hx-fortress credentials set ${id}</span>\nFortress credential updated.\nRestart Fortress or reconnect it to use the new credential.`);
      return;
    }
    if ((e.target as HTMLElement).closest("[data-rotcancel]")) { setRotating(null); }
  };
  useEffect(() => {
    if (rotating) (document.getElementById("rotInput0") as HTMLInputElement | null)?.focus();
  }, [rotating]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = (e.target as HTMLElement | null)?.id ?? "";
      if (id.startsWith("rotInput")) {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
          (document.querySelector("[data-rotsave]") as HTMLElement | null)?.click();
        }
        if (e.key === "Escape") setRotating(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const runCheckup = async () => {
    setCheckupBusy(true);
    setCheckupHtml("");
    const checks = checkupRows(svcRunning, pid);
    let html = "";
    for (const c of checks) {
      await sleep(420);
      html += checkupRowHtml(c);
      setCheckupHtml(html);
    }
    setCheckupBusy(false);
    showCheckupResult(svcRunning
      ? "All 6 checks passed — this fortress is healthy."
      : "Checkup stopped at the first failure — start the service, then run it again.", !svcRunning);
  };

  return (
    <section className={app.view === "ops" ? "view active" : "view"} id="view-ops">
      <div className="kicker">System</div>
      <h1>Operate the Fortress</h1>
      <p className="lede">Everything <code className="hx">hx-fortress</code> can do from a terminal, as controls with their output inline. The service runs under systemd on <span className="mono">fortress-01.orange-corp.internal</span>.</p>

      <div className="panel">
        <h2>Service</h2>
        <div className="facts wide">
          <div className="frw"><span className="k">State</span><span><span className="v" id="opsSvcV">{svcRunning ? "Running" : "Stopped"}</span><div className={"vs" + (svcVs.cls ? " " + svcVs.cls : "")} id="opsSvcVs">{svcVs.cls ? <span dangerouslySetInnerHTML={{ __html: svcVs.html }} /> : svcVsText}</div></span><span style={{ display: "flex", gap: 8 }}><button className="btn ghost sm" id="svcRestartBtn" disabled={!svcRunning} onClick={restart}>Restart</button><button className={svcRunning ? "btn danger sm" : "btn sm"} id="svcStopBtn" onClick={stopStart}>{svcRunning ? "Stop" : "Start"}</button></span></div>
          <div className="frw"><span className="k">Uptime</span><span><span className="v" id="opsUptime">{svcRunning ? (pid === FORT.pid ? "12d 7h 42m" : "just started") : "—"}</span><div className="vs">2 clean restarts in 90 days — both for updates</div></span></div>
          <div className="frw"><span className="k">Host</span><span><span className="v mono">fortress-01.orange-corp.internal</span><div className="vs">Ubuntu 24.04 LTS · x64 · EC2 eu-north-1</div></span></div>
          <div className="frw"><span className="k">Relay tunnel</span><span><span className="v" id="opsTunnelV">{svcRunning ? "Connected" : "Offline"}</span><div className="vs" id="opsTunnelVs">{svcRunning ? "dials out to the HX Fortress relay — no inbound ports · heartbeat every 30s · reconnect backoff 1–30s" : "reconnects automatically on start"}</div></span></div>
        </div>
        <Term id="svcTerm" html={svcTerm} />
      </div>

      <div className="panel">
        <h2>Status</h2>
        <div className="setrow" style={{ borderBottom: "none", paddingBottom: 0 }}>
          <div className="txt"><b>Run <code className="hx">hx-fortress status</code></b><p>The service, the tunnel, and every module — the same table the terminal prints, straight from <span className="mono">runtime/status.json</span>.</p></div>
          <button className="btn ghost" id="statusRunBtn" onClick={runStatus}>Run status</button>
        </div>
        <Term id="statusTerm" html={statusTerm} />
      </div>

      <div className="panel">
        <h2>Update</h2>
        <div className="facts wide">
          <div className="frw"><span className="k"><code className="hx">hx-fortress</code> version</span><span><span className="v mono" id="opsVerV">v{ver}</span><div className={updSub.ok ? "vs okv" : "vs"} id="opsVerVs" dangerouslySetInnerHTML={{ __html: updSub.html }} /></span><span style={{ display: "flex", gap: 8 }}><button className="btn ghost sm" id="updCheckBtn" onClick={updCheck}>Check for updates</button><button className="btn sm" id="updNowBtn" style={{ display: updAvail ? "" : "none" }} disabled={updating} onClick={updNow}>Update to 0.13.0</button></span></div>
        </div>
        <div className="why-note" style={{ marginTop: 12 }}>Checking never installs. An update downloads the signed binary through the cloud proxy, verifies its sha-256 against the published checksum, swaps it in, and restarts the service — the console reconnects by itself.</div>
      </div>

      <div className="panel">
        <h2>Enrollment</h2>
        <div className="facts wide">
          <div className="frw"><span className="k">Enrollment</span><span><span className="v">Enrolled</span><div className="vs">Mar 12, 2026 · token consumed at first connect — re-running <code className="hx">hx-fortress enroll</code> with a fresh token re-enrolls</div></span></div>
          <div className="frw"><span className="k">Fortress id</span><span><span className="v mono">vault_93cc57c54c1a4618</span><div className="vs">bound to org <span className="mono">orange-corp</span> — one fortress, one org</div></span></div>
        </div>
      </div>

      <div className="panel" id="keysPanel" ref={el => app.registerPanel("keys", el)}>
        <h2>Keys &amp; Credentials</h2>
        <div className="h2sub">Every key this fortress holds, rotatable from one place. All of them live in <span className="mono">~/.let/session-vault/credentials.json</span> and the identity directory — chmod 600, never leaving this host.</div>
        <div className="facts wide" id="keysList" onClick={onKeys} dangerouslySetInnerHTML={{ __html: keysHtml(keys, rotating) }} />
        <Term id="credTerm" html={credTerm} />
      </div>

      <div className="panel">
        <h2>Fortress Checkup</h2>
        <div className="setrow" style={{ borderBottom: "none", paddingBottom: 0 }}>
          <div className="txt"><b>Run every health probe in sequence</b><p>Service state, status freshness, Postgres phase, a live storage self-test, the embeddings endpoint, and the tunnel — the checks scattered across this console, in one pass with one verdict.</p></div>
          <button className="btn" id="checkupBtn" disabled={checkupBusy} onClick={runCheckup}>Run checkup</button>
        </div>
        <div className="rowlist ops" id="checkupOut" style={{ marginTop: 10 }} dangerouslySetInnerHTML={{ __html: checkupHtml }} />
        <ResultLine id="checkupResult" state={checkupResult} />
      </div>

      <div className="panel">
        <h2>Command Line</h2>
        <p style={{ fontSize: 14.5, color: "var(--text-muted)", margin: "2px 0 10px" }}>Everything in this console is also <code className="hx">hx-fortress</code> in a terminal — the complete command surface:</p>
        <div className="clirow"><span className="c">hx-fortress</span><span className="d">With no arguments: the terminal status UI — modules, versions, start/stop/update per row. Safe to exit; components keep running.</span></div>
        <div className="clirow"><span className="c">{"hx-fortress enroll [token] --cloud <url>"}</span><span className="d">The guided installer — storage backend, bucket, least-privilege keys, OpenAI key, then a storage self-test before first start. Enrollment above shows its result.</span></div>
        <div className="clirow"><span className="c">{"hx-fortress credentials set <key>"}</span><span className="d">The Rotate… actions in Keys &amp; Credentials — <span className="mono">vault</span>, <span className="mono">s3</span> or <span className="mono">openai</span>; updates the credential from stdin, masked; restart to apply.</span></div>
        <div className="clirow"><span className="c">hx-fortress start · stop</span><span className="d">The Service buttons above — installs into systemd/launchd and starts, or stops cleanly.</span></div>
        <div className="clirow"><span className="c">hx-fortress status</span><span className="d">“Run status” above — service, connection, and per-module states as a table.</span></div>
        <div className="clirow"><span className="c">hx-fortress logs [module] [--lines N]</span><span className="d">The Logs page as a live terminal tail — same records, filterable by module.</span></div>
        <div className="clirow"><span className="c">hx-fortress update</span><span className="d">“Check for updates” then “Update to …” above — download, checksum, install, restart.</span></div>
        <div className="clirow"><span className="c">hx-fortress host</span><span className="d">Runs the fortress host in the foreground — what systemd supervises. Deliberately CLI-only.</span></div>
        <div className="clirow"><span className="c">hx-fortress help</span><span className="d">Prints the command list.</span></div>
        <div className="clirow"><span className="c">hx-fortress ui</span><span className="d">Serves this console.</span></div>
      </div>
    </section>
  );
}
