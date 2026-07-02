/* eslint-disable @typescript-eslint/no-explicit-any -- standalone diagnostic ingest script */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHxDb } from "./src/host/postgres/db";
import { makeMigrationExec } from "./src/host/postgres/sql-exec";
import { runMigrations } from "./src/host/postgres/migrate";
import { migrations } from "./src/host/postgres/migrations/manifest";
import { ingestCommit } from "./src/ingest/ingest";
import { S3Store } from "./src/modules/session-vault/store/s3-store";
import { createEmbedWorker, createOpenAIEmbedder } from "./src/modules/embed-worker";

const DSN = "postgres://forge:forge@localhost:5499/hx-db";
const DEV = "pfXr1vzR7Cfr5R2MV2CehrlfKC7eImlJ";
const DESK = "/mnt/c/Users/Mr_Fi/Desktop";
const s3 = readFileSync(`${DESK}/s3.txt`, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const OPENAI = readFileSync(`${DESK}/openai.txt`, "utf8").trim();
const store = new S3Store({ region: "us-east-2", bucketName: "sm-s3-yaspafortres-prod", credentials: { accessKeyId: s3[0], secretAccessKey: s3[1], sessionToken: s3[2] } });
const embedder = createOpenAIEmbedder({ apiKey: OPENAI, model: "text-embedding-3-large", dimensions: 1024 });

const dir = "/home/feuer/.claude/projects/-home-feuer-let-forge";
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f}`).sort((a, b) => statSync(a).size - statSync(b).size);

function extractMeta(text: string): { cwd: string | null; gitBranch: string | null; title: string } {
  let cwd: string | null = null, gitBranch: string | null = null, summary: string | null = null, firstUser: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "summary" && typeof o.summary === "string" && !summary) summary = o.summary;
    if (o.type === "user" && !cwd && typeof o.cwd === "string") { cwd = o.cwd; gitBranch = typeof o.gitBranch === "string" ? o.gitBranch : null; }
    if (o.type === "user" && !firstUser) {
      const c = o.message?.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b?.type === "text")?.text : null;
      if (typeof t === "string" && t.trim()) firstUser = t.trim().slice(0, 90);
    }
  }
  return { cwd, gitBranch, title: (summary ?? firstUser ?? "session").slice(0, 120) };
}

async function main() {
  const sqlx = makeMigrationExec(DSN);
  await runMigrations(sqlx, migrations);
  // clean prior e2e/validate residue for a clean corpus
  const db = createHxDb(DSN);
  let ok = 0, fail = 0, blobFail = 0;
  for (const f of files) {
    const sid = basename(f, ".jsonl");
    const key = { userId: DEV, family: "claude-cli", sessionId: sid };
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const meta = extractMeta(text);
    try {
      const signed = await store.signStagingUpload(key, "c1");
      const put = await fetch(signed.url, { method: "PUT", body: text, headers: { "content-type": "application/x-ndjson" } });
      if (!put.ok) throw new Error(`PUT ${put.status}`);
      await store.appendChunkToCanonical(key, "c1", { replace: false });
    } catch (e: any) { blobFail++; console.log(`  blob FAIL ${sid.slice(0, 8)}: ${e?.message?.slice(0, 50)}`); }
    try {
      await ingestCommit(db, { attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null }, key, chunkId: "c1", replace: false, chunkText: text, totalBytes: text.length, componentCount: 1, meta });
      ok++; console.log(`OK ${sid.slice(0, 8)} ${(text.length / 1e6).toFixed(1)}MB · ${meta.title.slice(0, 42)}`);
    } catch (e: any) { fail++; console.log(`INGEST FAIL ${sid.slice(0, 8)}: ${e?.message?.slice(0, 70)}`); }
  }
  console.log(`\n== ingest done: ok=${ok} fail=${fail} blobFail=${blobFail} ==`);
  const worker = createEmbedWorker({ dsn: DSN, embedder, maxPerPass: 500 });
  let pass = 0, total = 0;
  for (;;) {
    const r = await worker.runOnce();
    total += r.written; pass++;
    if (pass % 3 === 0 || r.claimed === 0) console.log(`embed pass ${pass}: claimed=${r.claimed} written=${r.written} reused=${r.reused} failed=${r.failedIds.length}`);
    if (r.claimed === 0) break;
  }
  await worker.stop();
  const [{ v }] = await sqlx.query<{ v: number }>(`SELECT count(*)::int v FROM hx.embeddings WHERE model='text-embedding-3-large'`);
  console.log(`\n== embed done: total written this run=${total}, text-embedding-3-large vectors in DB=${v} ==`);
  process.exit(0);
}
main().catch((e) => { console.error("HARNESS FAILED:", e?.message ?? e); process.exit(1); });
