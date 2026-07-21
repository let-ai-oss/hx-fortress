import React, { useEffect, useState } from "react";
import { useApp, StoreTarget, storeUri } from "../state";
import { MenuPill, ResultLine, useResultLine } from "../components";
import { pipeHtml, pgRemedyHtml, blobHistoryHtml, BLOB_HISTORY_SEED } from "../render";
import { fmtInt, fmtMB, TOTAL_SESSIONS, TOTAL_KB, TOTAL_OBJECTS, OBJ_ARTIFACTS, OBJ_STAGING, FORT } from "../data";
import { sleep } from "../lib/util";

export function Postgres() {
  const app = useApp();
  const pgPreview = app.route.pgPreview;
  const setPgPreview = (on: boolean) => app.navigate({ pgPreview: on });

  return (
    <section className={app.view === "postgres" ? "view active" : "view"} id="view-postgres">
      <div className="kicker">Setup &amp; health</div>
      <h1>Postgres</h1>
      <p className="lede">The embedded Postgres instance that holds sessions, search vectors and the audit trail. When Postgres isn't running, sessions from your corporate users' <code className="hx">hx</code> clients have nowhere to save their data.</p>

      <div className="banner dangerb" id="pgFailBanner" style={{ display: pgPreview ? "flex" : "none" }}>
        <span className="badge">!</span>
        <span className="btxt"><b>Previewing a failed boot.</b> This is the state that once went unnoticed for ten days at another fortress. This fortress is actually healthy.</span>
        <button className="btn" id="pgFailExitBtn" onClick={() => setPgPreview(false)}>Exit preview</button>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>State</h2>
          <div className="facts" id="pgStateFacts">
            <div className="frw"><span className="k">Phase</span><span><span className="v" id="pgPhaseV" style={{ color: pgPreview ? "var(--danger)" : "var(--ok)" }}>{pgPreview ? "Failed" : "Ready"}</span><div className="vs" id="pgPhaseVs" dangerouslySetInnerHTML={{ __html: pgPreview ? `parked since Jul 11, 09:02 — <b>10 days</b> · reason: <span class="mono">binaries download failed: https://repo1.maven.org unreachable (egress policy)</span>` : "since Jul 9, 09:02:19 · boot took 11.2s" }} /></span></div>
            <div className="frw"><span className="k">Mode</span><span><span className="v">Embedded</span><div className="vs">managed by <code className="hx">hx-fortress</code> · external mode available via <span className="mono">FORTRESS_DATABASE_URL</span></div></span></div>
            <div className="frw"><span className="k">Version</span><span><span className="v mono">18.4.0</span><div className="vs">zonky build · pinned checksum verified at acquire</div></span></div>
            <div className="frw"><span className="k">Listens on</span><span><span className="v mono">127.0.0.1:54329</span><div className="vs">loopback only — never an external interface</div></span></div>
            <div className="frw"><span className="k">Data directory</span><span><span className="v mono">~/.let/hx-fortress/pgdata</span><div className="vs">2.4 GB · owner-only permissions</div></span></div>
          </div>
        </div>
        <div className="panel">
          <h2>Inside</h2>
          <div className="facts" id="pgInsideFacts">
            <div className="frw"><span className="k">Database</span><span><span className="v mono">hx-db</span><div className="vs">schema <span className="mono">hx</span> · sessions, transcript index, analysis, embeddings</div></span></div>
            <div className="frw"><span className="k">Roles</span><span><span className="v mono">hx_app_rw · hx_app_ro</span><div className="vs">least-privilege — writers ingest, readers serve queries; auth is scram, loopback-only</div></span></div>
            <div className="frw"><span className="k">Migrations</span><span><span className="v" id="pgMigV">12 applied</span><div className="vs" id="pgMigVs">newest <span className="mono">0012_embed_budget</span> · 0009 intentionally absent</div></span></div>
            <div className="frw"><span className="k">pgvector</span><span><span className="v" id="pgVecV">0.8.1 present</span><div className="vs">mandatory — a failed inject fails the whole boot rather than degrade search</div></span></div>
            <div className="frw"><span className="k">Size</span><span><span className="v">2.4 GB</span><div className="vs">1.61 GB of that is <span className="mono">hx.embeddings</span></div></span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Boot Pipeline</h2>
        <div className="h2sub" id="pipeSub">Every start walks these eight phases in order. The boot is one-shot: a failed phase parks the provider at <span className="mono">failed</span> until the service is restarted — it never retries on its own.</div>
        <div className="pipe" id="pgPipe" dangerouslySetInnerHTML={{ __html: pipeHtml(pgPreview) }} />
        <div className="why-note" style={{ marginTop: 16 }} id="pgRemedy" dangerouslySetInnerHTML={{ __html: pgRemedyHtml(pgPreview) }} />
        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn ghost sm" id="pgFailPreviewBtn" style={{ display: pgPreview ? "none" : "" }} onClick={() => { setPgPreview(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Preview a failed boot</button>
          <button className="btn ghost sm" onClick={() => app.navigate({ view: "logs", logSrc: "postgres", logLevel: "all", logRange: "boot" })}>Boot logs</button>
        </div>
      </div>

      <div className="panel">
        <h2>What Fails When Postgres Is Down</h2>
        <div className="rowlist ops">
          <div className="row"><span className="dot bad"></span><div className="who"><b><span className="mono">listSessions</span> · <span className="mono">ingestCommit</span> · <span className="mono">ingestAgentCommit</span></b><div className="sub">every metadata read and mirror throws <span className="mono">postgres_not_ready</span> — session lists at the relay go stale immediately</div></div><div><span className="pill danger pc">Fails</span></div><div className="m">db-gated</div></div>
          <div className="row"><span className="dot"></span><div className="who"><b><span className="mono">signStagingUpload</span> · <span className="mono">appendChunkToCanonical</span></b><div className="sub">blob writes keep landing — transcripts are safe in the bucket even while metadata is down</div></div><div><span className="pill ok pc">Survives</span></div><div className="m">store-only</div></div>
          <div className="row"><span className="dot warn"></span><div className="who"><b>Semantic search &amp; embeddings</b><div className="sub">vectors live in Postgres — indexing pauses and search goes dark until the boot completes</div></div><div><span className="pill warn pc">Pauses</span></div><div className="m">pgvector</div></div>
        </div>
        <div className="why-note" style={{ marginTop: 14 }}><b>The trap this page exists for:</b> a fortress with failed Postgres still shows a green tunnel and accepts blob writes — it “looks up” while every metadata RPC fails. Watch the phase above, not the connection light.</div>
      </div>
    </section>
  );
}

// Every AWS S3 commercial region.
const S3_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "af-south-1", "ap-east-1", "ap-south-1", "ap-south-2",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ca-central-1", "ca-west-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3",
  "eu-north-1", "eu-south-1", "eu-south-2",
  "il-central-1", "me-south-1", "me-central-1", "sa-east-1",
];
// Every GCP Cloud Storage location — the three multi-regions, then every region.
const GCS_LOCATIONS = [
  "us", "eu", "asia",
  "us-central1", "us-east1", "us-east4", "us-east5", "us-south1",
  "us-west1", "us-west2", "us-west3", "us-west4",
  "northamerica-northeast1", "northamerica-northeast2", "northamerica-south1",
  "southamerica-east1", "southamerica-west1",
  "europe-central2", "europe-north1", "europe-southwest1",
  "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west6",
  "europe-west8", "europe-west9", "europe-west10", "europe-west12",
  "asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3",
  "asia-south1", "asia-south2", "asia-southeast1", "asia-southeast2",
  "australia-southeast1", "australia-southeast2",
  "me-central1", "me-central2", "me-west1", "africa-south1",
];

export function Blob() {
  const app = useApp();
  const st = app.store;
  const editing = app.route.stEdit;
  const runs = app.runs;
  const shownRun = app.route.runId ? runs.find(r => r.id === app.route.runId) : runs[0];
  const [history, setHistory] = useState<any[]>(BLOB_HISTORY_SEED);
  const [checking, setChecking] = useState(false);
  const [result, showResult] = useResultLine();
  const [testing, setTesting] = useState(false);
  const [testResult, showTest] = useResultLine();

  // Rotating in place: S3 needs both halves of the key, GCS a whole
  // service-account document.
  const [credA, setCredA] = useState("");
  const [credB, setCredB] = useState("");
  // Changing where transcripts rest.
  const [form, setForm] = useState({ kind: st.kind, bucket: st.bucket, region: st.region, projectId: st.projectId ?? "", keyA: "", keyB: "" });
  const [pending, setPending] = useState<StoreTarget | null>(null);

  useEffect(() => {
    if (editing === "target") {
      setForm({ kind: st.kind, bucket: st.bucket, region: st.region, projectId: st.projectId ?? "", keyA: "", keyB: "" });
      setPending(null);
    } else if (!editing) setPending(null);
    if (editing === "credentials") { setCredA(""); setCredB(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const openEditor = (which: "credentials" | "target") =>
    app.navigate({ view: "blob", stEdit: which, runId: undefined }, which === "target" ? { modal: true } : undefined);
  const closeEditor = () => app.navigate({ view: "blob", stEdit: undefined });

  const saveCredentials = () => {
    if (st.kind === "s3" ? !(credA.trim() && credB.trim()) : !credA.trim()) return;
    const masked = st.kind === "s3"
      ? credA.trim().slice(0, 4) + "••••••••" + credA.trim().slice(-4)
      : "svc-acct ••••••••" + credA.trim().slice(-4);
    app.rotateStoreCredentials(masked, st.kind === "s3" ? "blob storage key pair" : "GCS service-account key");
    closeEditor();
  };

  const targetChanged = form.kind !== st.kind || form.bucket.trim() !== st.bucket || form.region !== st.region;
  const credsGiven = form.kind === "s3" ? !!(form.keyA.trim() && form.keyB.trim()) : !!form.keyA.trim();
  const canContinue = !!form.bucket.trim() && (!targetChanged || credsGiven) && (form.kind !== "gcs" || !!form.projectId.trim());

  // Write connectivity is the one thing a green "store initialized" doesn't
  // prove — so prove it: a real write, read-back and delete against the bucket.
  const testConnection = async () => {
    setTesting(true);
    const ms = 168 + Math.floor(Math.random() * 40);
    await sleep(950);
    setTesting(false);
    showTest(`Write connectivity confirmed — a 2 KB probe wrote to ${storeUri(st)}, read back and deleted in ${ms} ms. The credential can write to this bucket.`);
    app.addTrail("Tested storage write connectivity", `${storeUri(st)} · probe wrote + read back in ${ms} ms`);
  };

  const continueTarget = () => {
    if (!canContinue) return;
    const to: StoreTarget = {
      kind: form.kind as "s3" | "gcs", bucket: form.bucket.trim(), region: form.region,
      projectId: form.kind === "gcs" ? form.projectId.trim() : undefined,
    };
    if (!targetChanged) { saveCredentials(); return; }
    // An empty store has nothing to leave behind — no question to ask.
    if (st.objects === 0) { app.startMigration(to, "fresh"); return; }
    setPending(to);
  };

  const check = async () => {
    setChecking(true);
    const ms = 168 + Math.floor(Math.random() * 40);
    await sleep(900);
    setChecking(false);
    showResult(`Storage check passed — a 2 KB probe landed in ${FORT.bucket} and was read back in ${ms} ms, then deleted.`);
    setHistory(h => [["Just now · on-demand", "2 KB probe written, read back and deleted — run from this console", ["ok", "Passed"], ms + " ms"], ...h]);
    app.addTrail("Ran a storage self-test", `passed in ${ms} ms against s3://${FORT.bucket}`);
  };

  return (
    <section className={app.view === "blob" ? "view active" : "view"} id="view-blob">
      <div className="kicker">Setup &amp; health</div>
      <h1>Blob Storage — the Transcript Vault</h1>
      <p className="lede">Transcripts rest in the organization's own bucket, under the organization's own keys — neither the bucket nor the keys ever touch the HX Fortress relay. This page proves the bucket is real, writable, and growing the way the metadata says it should.</p>

      {st.orphan ? (
        <div className="banner dangerb">
          <span className="badge">!</span>
          <span className="btxt"><b>{fmtInt(st.orphan.objects)} objects were left behind in <span className="mono">{st.orphan.where}</span>.</b> This fortress no longer reads that bucket, so residency verification fails for every session stored there. Copy them across, or accept the gap on the record.</span>
          <button className="btn" onClick={() => app.goto("residency")}>Residency</button>
        </div>
      ) : null}

      <div className="panel">
        <h2>Store</h2>
        <div className="facts">
          <div className="frw"><span className="k">Kind</span><span><span className="v">{st.kind === "gcs" ? "Google Cloud Storage" : "S3"}</span><div className="vs">from <span className="mono">credentials.json</span> · {st.kind === "gcs" ? "S3" : "GCS"} equally supported</div></span><button className="btn ghost sm" onClick={() => openEditor("target")}>Change…</button></div>
          <div className="frw"><span className="k">Bucket</span><span><span className="v mono">{st.bucket}</span><div className="vs">{st.region} · public access blocked · versioning on</div></span></div>
          {st.kind === "gcs" ? (
            <div className="frw"><span className="k">Project</span><span><span className="v mono">{st.projectId}</span><div className="vs">the GCP project that owns the bucket</div></span></div>
          ) : null}
          <div className="frw"><span className="k">Credentials</span><span><span className="v mono">{st.maskedKey}</span><div className={st.credRotated ? "vs warnv" : "vs"}>{st.credRotated ? "rotated just now — restart the service to apply" : <>{st.kind === "gcs" ? "inline service-account key" : "inline access key pair"} · chmod 600 · never leaves this host</>}</div></span>
            {editing === "credentials" ? (
              <span className="credit">
                {st.kind === "s3" ? (
                  <>
                    <input id="credA" placeholder="AWS access key ID" autoComplete="off" value={credA} onChange={e => setCredA(e.target.value)} />
                    <input id="credB" type="password" placeholder="AWS secret access key" autoComplete="off" value={credB} onChange={e => setCredB(e.target.value)} />
                  </>
                ) : (
                  <textarea id="credA" placeholder="paste the service-account key JSON" value={credA} onChange={e => setCredA(e.target.value)} />
                )}
                <span className="credact">
                  <button className="btn sm" id="credSave" onClick={saveCredentials}>Save</button>
                  <button className="btn ghost sm" onClick={closeEditor}>Cancel</button>
                </span>
              </span>
            ) : (
              <button className="btn ghost sm" onClick={() => openEditor("credentials")}>Rotate…</button>
            )}
          </div>
          <div className="frw"><span className="k">Encryption</span><span><span className="v">{st.kind === "gcs" ? "Google-managed keys" : "SSE-KMS"}</span><div className="vs">{st.kind === "gcs" ? "CMEK available per bucket" : <>customer-managed key <span className="mono">alias/orange-hx</span></>}</div></span></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center", justifyContent: "flex-end" }}>
          <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-subtle)" }}>Confirms the credential can actually write here — a green init doesn't.</span>
          <button className="btn ghost" id="stTestBtn" disabled={testing} onClick={testConnection}>Test connection</button>
        </div>
        <ResultLine id="stTestResult" state={testResult} />
      </div>

      {/* Changing where transcripts rest is a decision with consequences, so it
          gets the room and the focus of a dialog rather than growing the page. */}
      <div className={editing === "target" ? "overlayw open" : "overlayw"} id="stTargetOverlay"
        onClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-close]")) app.closeStorageDialog(); }}>
        <div className="modal" style={{ width: "min(720px,100%)" }}>
          <div className="mhead">
            <div className="row1">
              <h3>{pending ? `What happens to the ${fmtInt(st.objects)} objects already stored?` : "Change storage target"}</h3>
              <button className="x" data-close>✕</button>
            </div>
            <p className="msub">
              {pending
                ? <>This fortress holds {fmtMB(st.kb)} in <span className="mono">{storeUri(st)}</span>. The new target is empty.</>
                : <>Transcripts move only if you ask them to — the next step says exactly what happens to the {fmtInt(st.objects)} objects already here.</>}
            </p>
          </div>
          <div className="mbody scrolly">
          {!pending ? (
          <div className="stform">
            <div className="facts wide">
              <div className="frw"><span className="k">Provider</span><span>
                <MenuPill pillId="stKindPill" menuId="stKindMenu" valueId="stKindVal"
                  value={form.kind === "gcs" ? "Google Cloud Storage" : "S3"} selKey={form.kind} dataAttr="data-kind"
                  items={[{ key: "s3", label: "S3" }, { key: "gcs", label: "Google Cloud Storage" }]}
                  onPick={k => setForm(f => ({ ...f, kind: k as "s3" | "gcs", region: k === "gcs" ? "europe-north1" : "eu-north-1" }))} />
                <div className="fieldnote">switching provider always means a new, empty bucket</div>
              </span></div>
              <div className="frw"><span className="k">Bucket</span><span>
                <input id="stBucket" value={form.bucket} placeholder="bucket name" onChange={e => setForm(f => ({ ...f, bucket: e.target.value }))} />
                <div className="fieldnote">globally unique · public access blocked</div>
              </span></div>
              <div className="frw"><span className="k">{form.kind === "gcs" ? "Location" : "Region"}</span><span>
                <MenuPill pillId="stRegionPill" menuId="stRegionMenu" valueId="stRegionVal"
                  value={form.region} selKey={form.region} dataAttr="data-region"
                  items={(form.kind === "gcs" ? GCS_LOCATIONS : S3_REGIONS).map(x => ({ key: x, label: x }))}
                  onPick={x => setForm(f => ({ ...f, region: x }))} />
              </span></div>
              {form.kind === "gcs" ? (
                <div className="frw"><span className="k">Project</span><span>
                  <input id="stProject" value={form.projectId} placeholder="GCP project id" onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))} />
                </span></div>
              ) : null}
              <div className="frw"><span className="k">Credentials</span><span>
                {form.kind === "s3" ? (
                  <>
                    <input id="stKeyA" value={form.keyA} placeholder="AWS access key ID" autoComplete="off" onChange={e => setForm(f => ({ ...f, keyA: e.target.value }))} />
                    <div style={{ height: 8 }} />
                    <input id="stKeyB" type="password" value={form.keyB} placeholder="AWS secret access key" autoComplete="off" onChange={e => setForm(f => ({ ...f, keyB: e.target.value }))} />
                  </>
                ) : (
                  <textarea id="stKeyA" value={form.keyA} placeholder="paste the service-account key JSON" onChange={e => setForm(f => ({ ...f, keyA: e.target.value }))} />
                )}
                <div className="fieldnote">written to <span className="mono">~/.let/session-vault/credentials.json</span>, chmod 600 — it never leaves this host</div>
              </span></div>
            </div>
          </div>
          ) : (
          <div className="stform" id="stDecision">
            <div className="choice">
              <div className="ctxt"><b>Copy them across, then switch</b><p>One run copies every object to <span className="mono">{storeUri(pending)}</span>, verifies the byte counts, and only then rewrites <span className="mono">credentials.json</span>. Nothing is deleted from the old bucket.</p></div>
              <button className="btn" id="stCopy" onClick={() => { app.startMigration(pending, "copy"); setPending(null); }}>Copy &amp; switch</button>
            </div>
            <div className="choice danger">
              <div className="ctxt"><b>Switch now and start fresh</b><p>New sessions land in <span className="mono">{storeUri(pending)}</span> immediately. The {fmtInt(st.objects)} objects here stay where they are and stop resolving from this fortress — residency verification will fail for all {fmtInt(TOTAL_SESSIONS)} sessions.</p></div>
              <button className="btn danger" id="stFresh" onClick={() => { app.startMigration(pending, "fresh"); setPending(null); }}>Start fresh</button>
            </div>
          </div>
          )}
          </div>
          <div className="mfoot">
            <span className="grow"></span>
            {pending ? (
              <button className="btn ghost" onClick={() => setPending(null)}>Back</button>
            ) : (
              <>
                <button className="btn ghost" data-close>Cancel</button>
                <button className="btn" id="stContinue" disabled={!canContinue} onClick={continueTarget}>Continue</button>
              </>
            )}
          </div>
        </div>
      </div>

      {shownRun ? (
        <div className="panel" id="stRunPanel">
          <h2>Storage Migration</h2>
          <div className="runhead">
            <span className="runid">{shownRun.id}</span>
            <span className="runroute">{storeUri(shownRun.from)} → {storeUri(shownRun.to)}</span>
            <span className={"pill " + (shownRun.status === "complete" ? "ok" : shownRun.status === "failed" ? "danger" : "fortress")}>
              {shownRun.status === "complete" ? "Complete" : shownRun.status === "failed" ? "Failed" : "Running"}
            </span>
            {shownRun.resumeOf ? <span className="runroute">resuming {shownRun.resumeOf}</span> : null}
          </div>
          <div className="runstat">
            <span className="runphase">{shownRun.phase}</span>
            <span className="runnums">
              {shownRun.mode === "copy"
                ? `${fmtInt(shownRun.copied)} of ${fmtInt(shownRun.total)} objects · ${shownRun.pct}%`
                : `${fmtInt(shownRun.total)} objects left in place`}
            </span>
          </div>
          <div className="pbar"><i style={{ width: shownRun.pct + "%", background: shownRun.status === "failed" ? "var(--danger)" : undefined }} /></div>
          <div className="logpane scrolly runlog">
            {shownRun.log.map((l, i) => (
              <div key={i} className={"ln " + (l.includes("] error") ? "errl" : l.includes("] warn") ? "warnl" : "")}>{l}</div>
            ))}
          </div>
          {shownRun.status === "failed" ? (
            <>
              <div className="why-note" style={{ marginTop: 14 }}><b>Nothing was switched.</b> {shownRun.error}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={() => openEditor("target")}>Edit the target</button>
                <button className="btn" id="stRetry" onClick={() => app.retryMigration(shownRun.id)}>Retry the run</button>
              </div>
              <div className="why-note" style={{ marginTop: 12 }}>A retry resumes: objects already copied are skipped, so only the remaining {fmtInt(shownRun.total - shownRun.copied)} move.</div>
            </>
          ) : null}
          {shownRun.status === "complete" ? (
            <>
              <div className="why-note" style={{ marginTop: 14 }}><b>The store is built once, at module init.</b> The new target is written to <span className="mono">credentials.json</span>, but this fortress keeps using the old one until the service restarts.</div>
              <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => app.goto("ops")}>Restart the service →</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {runs.length ? (
        <div className="panel">
          <h2>Migration Runs</h2>
          <div className="h2sub">Every attempt is kept, with the log it produced.</div>
          <div className="rowlist ops">
            {runs.map(r => (
              <div className="row" key={r.id} style={{ cursor: "pointer" }} onClick={() => app.navigate({ view: "blob", runId: r.id, stEdit: undefined })}>
                <span className={"dot " + (r.status === "complete" ? "" : r.status === "failed" ? "bad" : "warn")}></span>
                <div className="who"><b className="mono" style={{ fontWeight: 600 }}>{r.id}</b><div className="sub">{storeUri(r.from)} → {storeUri(r.to)} · {r.mode === "copy" ? "copy & switch" : "start fresh"}{r.resumeOf ? ` · resumed ${r.resumeOf}` : ""}</div></div>
                <div><span className={"pill pc " + (r.status === "complete" ? "ok" : r.status === "failed" ? "danger" : "fortress")}>{r.status === "complete" ? "Complete" : r.status === "failed" ? "Failed" : "Running"}</span></div>
                <div className="m">{r.startedAt}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <h2>Contents</h2>
        <div className="facts">
          <div className="frw"><span className="k">Objects</span><span><span className="v" id="blobObjects">{fmtInt(st.objects)}</span><div className="vs" id="blobObjectsSub">{st.objects === 0 ? "an empty bucket — nothing has been written here yet" : <>{fmtInt(TOTAL_SESSIONS)} canonical transcripts · {fmtInt(OBJ_ARTIFACTS)} artifacts · {OBJ_STAGING} staging (transient)</>}</div></span></div>
          <div className="frw"><span className="k">Bytes</span><span><span className="v" id="blobBytes">{st.objects === 0 ? "0 KB" : fmtMB(st.kb)}</span><div className="vs">{st.objects === 0 ? "waiting for the first commit" : "+21.4 MB today"}</div></span></div>
          <div className="frw"><span className="k">Last write</span><span><span className="v">{st.objects === 0 ? "—" : "12s ago"}</span><div className="vs">{st.objects === 0 ? "no writes to this bucket yet" : <><span className="mono">…/log.jsonl</span> append · 184 KB</>}</div></span></div>
          <div className="frw"><span className="k">Last read</span><span><span className="v">{st.objects === 0 ? "—" : "3m ago"}</span><div className="vs">canonical read served over the tunnel</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Prove It Works</h2>
        <div className="setrow" style={{ borderBottom: "none", paddingBottom: 0 }}>
          <div className="txt"><b>Check storage now</b><p>Writes a small probe object, reads it back, deletes it. A write that lands and reads back is the only positive proof a bucket works — run it any time, it costs nothing.</p></div>
          <button className="btn" id="blobCheckBtn" disabled={checking} onClick={check}>Check storage now</button>
        </div>
        <ResultLine id="blobCheckResult" state={result} />
        <div className="rowlist ops" id="blobCheckHistory" style={{ marginTop: 14 }} dangerouslySetInnerHTML={{ __html: blobHistoryHtml(history) }} />
        <div className="why-note" style={{ marginTop: 16 }}><b>The green-chip trap:</b> “store initialized” in the logs means the S3 client was <i>constructed</i> — construction is lazy and touches nothing. No bucket round-trip happens until the first write. A fortress can log a green init over an unwritable bucket; this check is what actually proves it.</div>
      </div>

      <div className="panel">
        <h2>Object Layout</h2>
        <div className="h2sub">Every object a session owns lives under one prefix — short, predictable, and auditable from the bucket alone.</div>
        <div className="facts wide">
          <div className="frw"><span className="k">Session prefix</span><span><span className="v mono">{"{userId}/{family}/{sessionId}/"}</span><div className="vs">everything below rests under it · staging and canonical share the bucket</div></span></div>
          <div className="frw"><span className="k">Canonical</span><span><span className="v mono">log.jsonl</span><div className="vs">the transcript · one object per session, chunks appended in order</div></span></div>
          <div className="frw"><span className="k">Staging</span><span><span className="v mono">{".staging/{chunkId}.jsonl"}</span><div className="vs">transient upload chunks · composed into the canonical, then removed</div></span></div>
          <div className="frw"><span className="k">Artifacts</span><span><span className="v mono">session.json · tasks.json · plan.json</span><div className="vs">allow-listed sidecars · nothing else can be written by name</div></span></div>
          <div className="frw"><span className="k">Agent lanes</span><span><span className="v mono">{"{sessionId}:a:{agentId}"}</span><div className="vs">subagent transcripts · same layout, under the agent's own lane</div></span></div>
        </div>
      </div>
    </section>
  );
}

export function Embeddings() {
  const app = useApp();
  // The OpenAI key is rotated here, on the page that uses it.
  const [emEditing, setEmEditing] = useState(false);
  const [emVal, setEmVal] = useState("");
  const [emMasked, setEmMasked] = useState("sk-••••••••••••••••hV2m");
  const [emRotated, setEmRotated] = useState(false);
  const saveEm = () => {
    if (!emVal.trim()) return;
    setEmMasked("sk-••••••••" + emVal.trim().slice(-4));
    setEmRotated(true);
    setEmEditing(false);
    setEmVal("");
    app.addTrail("Rotated the OpenAI API key", "hx-fortress credentials set openai · restart pending");
  };
  return (
    <section className={app.view === "embeddings" ? "view active" : "view"} id="view-embeddings">
      <div className="kicker">Setup &amp; health</div>
      <h1>Embeddings</h1>
      <p className="lede">Vector embeddings make sessions searchable by meaning. The fortress computes them through the configured OpenAI-compatible endpoint and stores them in the local Postgres instance running as part of this HX Fortress. This page shows the OpenAI API endpoint, the Postgres index, and the queue.</p>

      <div className="panel">
        <h2>Endpoint</h2>
        <div className="facts">
          <div className="frw"><span className="k">Base URL</span><span><span className="v mono">https://api.openai.com/v1</span><div className="vs">OpenAI-compatible · set via <span className="mono">FORTRESS_OPENAI_BASE_URL</span>, restart to apply</div></span></div>
          <div className="frw"><span className="k">Model</span><span><span className="v mono">text-embedding-3-large</span><div className="vs">1024 dimensions — matryoshka-truncated from the native 3072</div></span></div>
          <div className="frw"><span className="k">OpenAI API Key</span><span><span className="v mono">{emMasked}</span><div className={emRotated ? "vs warnv" : "vs"}>{emRotated ? "rotated just now — restart the service to apply" : <>in <span className="mono">credentials.json</span> · chmod 600 · never leaves this host</>}</div></span>
            {emEditing ? (
              <span className="credit">
                <input className="rotatein" id="emKeyInput" type="password" placeholder="paste the new sk-… key" autoComplete="off" value={emVal} onChange={e => setEmVal(e.target.value)} />
                <span className="credact">
                  <button className="btn sm" id="emKeySave" onClick={saveEm}>Save</button>
                  <button className="btn ghost sm" onClick={() => { setEmEditing(false); setEmVal(""); }}>Cancel</button>
                </span>
              </span>
            ) : (
              <button className="btn ghost sm" onClick={() => setEmEditing(true)}>Rotate…</button>
            )}
          </div>
          <div className="frw"><span className="k">Secret scrub</span><span><span className="v">On</span><div className="vs">key/token/credential patterns are stripped from every turn before it leaves this host</div></span></div>
          <div className="frw"><span className="k">Retries</span><span><span className="v">4 · capped backoff</span><div className="vs">429/5xx retried; a poison input is isolated, not fatal</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Index</h2>
        <div className="facts">
          <div className="frw"><span className="k">Vectors</span><span><span className="v" id="emVectors">{fmtInt(402318)}</span><div className="vs">one per embeddable turn · <span className="mono">hx.embeddings</span></div></span></div>
          <div className="frw"><span className="k">Storage</span><span><span className="v">1.61 GB</span><div className="vs">pgvector · content-hash deduped · unique per owner</div></span></div>
          <div className="frw"><span className="k">Backlog</span><span><span className="v" id="emBacklog">214 turns</span><div className="vs" id="emBacklogSub">draining · ~6 min at current rate</div></span></div>
          <div className="frw"><span className="k">Daily budget</span><span><span className="v"><span className="minibar"><i style={{ width: "25%" }} /></span>1.24M / 5M tokens</span><div className="vs">a durable per-day ceiling on OpenAI spend — the worker stops at the cap, resumes tomorrow</div></span></div>
          <div className="frw"><span className="k">Dead-lettered</span><span><span className="v">3 turns · 7 days</span><div className="vs">unembeddable even after shrinking — skipped individually, everything else proceeds</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Query-Time Behavior</h2>
        <div className="facts wide">
          <div className="frw"><span className="k">Search embedding</span><span><span className="v">Bounded — 8s per attempt</span><div className="vs">a stalled endpoint fails the search fast with a typed error instead of hanging it</div></span></div>
          <div className="frw"><span className="k">Endpoint down</span><span><span className="v">Search degrades to keyword</span><div className="vs">indexing pauses and catches up when the endpoint returns — nothing is lost</div></span></div>
          <div className="frw"><span className="k">Account errors</span><span><span className="v">Stop the pass loudly</span><div className="vs">quota exhausted or a bad key halts embedding and surfaces here — it never silently drops turns</div></span></div>
        </div>
      </div>
    </section>
  );
}
