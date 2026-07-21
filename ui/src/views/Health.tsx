import React, { useState } from "react";
import { useApp } from "../state";
import { ResultLine, useResultLine } from "../components";
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

export function Blob() {
  const app = useApp();
  const [history, setHistory] = useState<any[]>(BLOB_HISTORY_SEED);
  const [checking, setChecking] = useState(false);
  const [result, showResult] = useResultLine();

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

      <div className="panel">
        <h2>Store</h2>
        <div className="facts">
          <div className="frw"><span className="k">Kind</span><span><span className="v">S3</span><div className="vs">from <span className="mono">credentials.json</span> · GCS equally supported</div></span></div>
          <div className="frw"><span className="k">Bucket</span><span><span className="v mono">orange-corp-hx-fortress</span><div className="vs">eu-north-1 · public access blocked · versioning on</div></span></div>
          <div className="frw"><span className="k">Credentials</span><span><span className="v mono">AKIA••••••••••••3F7Q</span><div className="vs">inline access key · chmod 600 · never leaves this host</div></span><button className="btn ghost sm" onClick={() => app.goto("ops", "keys")}>Rotate…</button></div>
          <div className="frw"><span className="k">Encryption</span><span><span className="v">SSE-KMS</span><div className="vs">customer-managed key <span className="mono">alias/orange-hx</span></div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Contents</h2>
        <div className="facts">
          <div className="frw"><span className="k">Objects</span><span><span className="v" id="blobObjects">{fmtInt(TOTAL_OBJECTS)}</span><div className="vs" id="blobObjectsSub">{fmtInt(TOTAL_SESSIONS)} canonical transcripts · {fmtInt(OBJ_ARTIFACTS)} artifacts · {OBJ_STAGING} staging (transient)</div></span></div>
          <div className="frw"><span className="k">Bytes</span><span><span className="v" id="blobBytes">{fmtMB(TOTAL_KB + 4200)}</span><div className="vs">+21.4 MB today</div></span></div>
          <div className="frw"><span className="k">Last write</span><span><span className="v">12s ago</span><div className="vs"><span className="mono">…/log.jsonl</span> append · 184 KB</div></span></div>
          <div className="frw"><span className="k">Last read</span><span><span className="v">3m ago</span><div className="vs">canonical read served over the tunnel</div></span></div>
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
  return (
    <section className={app.view === "embeddings" ? "view active" : "view"} id="view-embeddings">
      <div className="kicker">Setup &amp; health</div>
      <h1>Embeddings</h1>
      <p className="lede">Vector embeddings make sessions searchable by meaning. The fortress computes them through the configured OpenAI-compatible endpoint and stores them in its own Postgres — this page shows the endpoint, the index, and the queue.</p>

      <div className="panel">
        <h2>Endpoint</h2>
        <div className="facts">
          <div className="frw"><span className="k">Base URL</span><span><span className="v mono">https://api.openai.com/v1</span><div className="vs">OpenAI-compatible · set via <span className="mono">FORTRESS_OPENAI_BASE_URL</span>, restart to apply</div></span></div>
          <div className="frw"><span className="k">Model</span><span><span className="v mono">text-embedding-3-large</span><div className="vs">1024 dimensions — matryoshka-truncated from the native 3072</div></span></div>
          <div className="frw"><span className="k">API key</span><span><span className="v mono">sk-••••••••••••••••hV2m</span><div className="vs">in <span className="mono">credentials.json</span> · chmod 600 · never leaves this host</div></span><button className="btn ghost sm" onClick={() => app.goto("ops", "keys")}>Rotate…</button></div>
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
