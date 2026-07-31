// @ts-nocheck — this module is the prototype's data + formulas, kept verbatim
// so the demo world is byte-identical. Do not "improve"; a later engineer
// replaces this module when wiring the real fortress.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
  const fmtInt = n => n.toLocaleString("en-US");
  const fmtMB = kb => kb >= 1048576 ? (kb / 1048576).toFixed(2) + " GB" : kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB";

  // Deterministic PRNG so the demo world is identical on every load.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── The fortress ──────────────────────────────────────
  const FORT = {
    org: "orange-corp",
    name: "Orange Corp | HX Fortress",
    id: "vault_93cc57c54c1a4618",
    version: "0.12.1",
    nextVersion: "0.13.0",
    bucket: "orange-corp-hx-fortress",
    region: "eu-north-1",
    host: "fortress-01.orange-corp.internal",
    pid: 41772,
    service: "systemd",
  };

  // ── People — 42, hand-tuned so per-person sessions sum to exactly 12,847 ──
  // cover: all | some | few | quiet (installed, nothing in 30d) | none (no client)
  // lastUp: days since last upload; lastSeen: days since device liveness.
  const PEOPLE = [
    { id:"johnny",  name:"Johnny Orange",   team:"Payments", group:"Checkout",     sessions:266, kbAvg:158.6, cover:"all",  pct:99,  lastUp:0,  devices:[{n:"claude-container", os:"Linux arm64 · container", v:"76.2.4", seen:0}] },
    { id:"marta",   name:"Marta Nilsson",   team:"Payments", group:"Checkout",     sessions:712, kbAvg:151,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"marta-mbp", os:"macOS arm64", v:"76.2.4", seen:0},{n:"dev-pay-1", os:"Linux x64 · container", v:"76.2.4", seen:0}] },
    { id:"priya",   name:"Priya Shah",      team:"Payments", group:"Checkout",     sessions:668, kbAvg:149,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"priya-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"tomas",   name:"Tomas Berg",      team:"Payments", group:"Checkout",     sessions:391, kbAvg:147,   cover:"all",  pct:96,  lastUp:1,  devices:[{n:"tomas-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"jonas",   name:"Jonas Weber",     team:"Payments", group:"Billing Core", sessions:344, kbAvg:143,   cover:"some", pct:78,  lastUp:1,  devices:[{n:"jonas-thinkpad", os:"Linux x64", v:"76.2.4", seen:0}] },
    { id:"ana",     name:"Ana Costa",       team:"Payments", group:"Billing Core", sessions:296, kbAvg:141,   cover:"some", pct:71,  lastUp:2,  devices:[{n:"ana-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"sofia",   name:"Sofia Marino",    team:"Payments", group:"Billing Core", sessions:522, kbAvg:152,   cover:"all",  pct:99,  lastUp:0,  devices:[{n:"sofia-mbp", os:"macOS arm64", v:"76.2.4", seen:0},{n:"dev-pay-2", os:"Linux x64 · container", v:"76.2.4", seen:0}] },
    { id:"henrik",  name:"Henrik Dahl",     team:"Payments", group:"Billing Core", sessions:402, kbAvg:146,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"henrik-mbp", os:"macOS x64", v:"76.2.4", seen:0}] },
    { id:"elena",   name:"Elena Vasquez",   team:"Platform", group:"Runtime",      sessions:633, kbAvg:156,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"elena-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"marcus",  name:"Marcus Chen",     team:"Platform", group:"Runtime",      sessions:787, kbAvg:161,   cover:"all",  pct:99,  lastUp:0,  devices:[{n:"marcus-mbp", os:"macOS arm64", v:"76.2.4", seen:0},{n:"dev-rt-4", os:"Linux x64 · container", v:"76.2.4", seen:0}] },
    { id:"ingrid",  name:"Ingrid Solberg",  team:"Platform", group:"Runtime",      sessions:512, kbAvg:150,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"ingrid-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"david",   name:"David Okafor",    team:"Platform", group:"Runtime",      sessions:444, kbAvg:148,   cover:"some", pct:83,  lastUp:1,  devices:[{n:"david-thinkpad", os:"Linux x64", v:"76.2.4", seen:0}] },
    { id:"camille", name:"Camille Roux",    team:"Platform", group:"Build & Release", sessions:379, kbAvg:145, cover:"some", pct:69, lastUp:3,  devices:[{n:"camille-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"peter",   name:"Peter Novak",     team:"Platform", group:"Build & Release", sessions:428, kbAvg:149, cover:"all",  pct:96,  lastUp:0,  devices:[{n:"peter-mbp", os:"macOS x64", v:"76.2.4", seen:0}] },
    { id:"astrid",  name:"Astrid Falk",     team:"Platform", group:"Build & Release", sessions:356, kbAvg:144, cover:"all",  pct:98,  lastUp:0,  devices:[{n:"astrid-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"viktor",  name:"Viktor Hall",     team:"Mobile",   group:"iOS",          sessions:2,   kbAvg:120,   cover:"few",  pct:12,  lastUp:6,  devices:[{n:"viktor-mbp", os:"macOS arm64", v:"76.1.9", seen:0}] },
    { id:"emma",    name:"Emma Lindgren",   team:"Mobile",   group:"iOS",          sessions:312, kbAvg:142,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"emma-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"lucas",   name:"Lucas Ferreira",  team:"Mobile",   group:"iOS",          sessions:288, kbAvg:140,   cover:"all",  pct:96,  lastUp:0,  devices:[{n:"lucas-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"nadia",   name:"Nadia Osman",     team:"Mobile",   group:"Android",      sessions:267, kbAvg:139,   cover:"some", pct:74,  lastUp:2,  devices:[{n:"nadia-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"oliver",  name:"Oliver Grant",    team:"Mobile",   group:"Android",      sessions:0,   kbAvg:0,     cover:"quiet",pct:0,   lastUp:34, devices:[{n:"oliver-thinkpad", os:"Linux x64", v:"76.2.1", seen:2}] },
    { id:"freja",   name:"Freja Holm",      team:"Mobile",   group:"Android",      sessions:243, kbAvg:138,   cover:"some", pct:66,  lastUp:1,  devices:[{n:"freja-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"lena",    name:"Lena Kraus",      team:"Data",     group:"Pipelines",    sessions:0,   kbAvg:0,     cover:"none", pct:0,   lastUp:-1, devices:[] },
    { id:"raj",     name:"Raj Patel",       team:"Data",     group:"Pipelines",    sessions:656, kbAvg:157,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"raj-mbp", os:"macOS arm64", v:"76.2.4", seen:0},{n:"dev-data-2", os:"Linux x64 · container", v:"76.2.4", seen:0}] },
    { id:"yuki",    name:"Yuki Tanaka",     team:"Data",     group:"Pipelines",    sessions:41,  kbAvg:135,   cover:"few",  pct:31,  lastUp:11, devices:[{n:"yuki-mbp", os:"macOS arm64", v:"76.1.9", seen:1}] },
    { id:"clara",   name:"Clara Bergman",   team:"Data",     group:"Analytics",    sessions:388, kbAvg:146,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"clara-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"samuel",  name:"Samuel Boateng",  team:"Data",     group:"Analytics",    sessions:342, kbAvg:144,   cover:"some", pct:81,  lastUp:1,  devices:[{n:"samuel-mbp", os:"macOS x64", v:"76.2.4", seen:0}] },
    { id:"nina",    name:"Nina Petrov",     team:"Data",     group:"Analytics",    sessions:315, kbAvg:143,   cover:"all",  pct:96,  lastUp:0,  devices:[{n:"nina-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"erik",    name:"Erik Lindqvist",  team:"Web",      group:"Storefront",   sessions:187, kbAvg:141,   cover:"some", pct:72,  lastUp:9,  devices:[{n:"erik-mbp", os:"macOS arm64", v:"76.2.4", seen:9, unsent:14}] },
    { id:"maria",   name:"Maria Santos",    team:"Web",      group:"Storefront",   sessions:611, kbAvg:153,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"maria-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"jakob",   name:"Jakob Nilsen",    team:"Web",      group:"Storefront",   sessions:376, kbAvg:145,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"jakob-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"aisha",   name:"Aisha Rahman",    team:"Web",      group:"Storefront",   sessions:328, kbAvg:143,   cover:"some", pct:77,  lastUp:1,  devices:[{n:"aisha-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"tom",     name:"Tom Becker",      team:"Web",      group:"Design Systems", sessions:289, kbAvg:141, cover:"all",  pct:96,  lastUp:0,  devices:[{n:"tom-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"julia",   name:"Julia Weiss",     team:"Web",      group:"Design Systems", sessions:28,  kbAvg:132, cover:"few",  pct:24,  lastUp:9,  devices:[{n:"julia-mbp", os:"macOS arm64", v:"76.2.1", seen:3}] },
    { id:"felix",   name:"Felix Andersen",  team:"Web",      group:"Design Systems", sessions:0,  kbAvg:0,    cover:"none", pct:0,   lastUp:-1, devices:[] },
    { id:"omar",    name:"Omar Haddad",     team:"Security", group:"AppSec",       sessions:298, kbAvg:147,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"omar-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"vera",    name:"Vera Kovac",      team:"Security", group:"AppSec",       sessions:273, kbAvg:144,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"vera-thinkpad", os:"Linux x64", v:"76.2.4", seen:0}] },
    { id:"liam",    name:"Liam O'Brien",    team:"Security", group:"AppSec",       sessions:244, kbAvg:142,   cover:"all",  pct:96,  lastUp:1,  devices:[{n:"liam-mbp", os:"macOS arm64", v:"76.2.4", seen:0}] },
    { id:"ida",     name:"Ida Strand",      team:"Security", group:"AppSec",       sessions:0,   kbAvg:0,     cover:"quiet",pct:0,   lastUp:99, devices:[{n:"ida-mbp", os:"macOS arm64", v:"76.2.1", seen:1}] },
    { id:"dana",    name:"Dana Mandarin",   team:"IT Ops",   group:"IT",           sessions:87,  kbAvg:136,   cover:"all",  pct:97,  lastUp:0,  devices:[{n:"dana-thinkpad", os:"Linux x64", v:"76.2.4", seen:0}] },
    { id:"niklas",  name:"Niklas Falk",     team:"IT Ops",   group:"IT",           sessions:132, kbAvg:138,   cover:"all",  pct:98,  lastUp:0,  devices:[{n:"niklas-thinkpad", os:"Linux x64", v:"76.2.4", seen:0}] },
    { id:"rosa",    name:"Rosa Jimenez",    team:"IT Ops",   group:"IT",           sessions:0,   kbAvg:0,     cover:"none", pct:0,   lastUp:-1, devices:[] },
    { id:"karl",    name:"Karl Viklund",    team:"IT Ops",   group:"IT",           sessions:0,   kbAvg:0,     cover:"quiet",pct:0,   lastUp:41, devices:[{n:"karl-thinkpad", os:"Linux x64", v:"76.1.9", seen:5}] },
  ];
  const TEAM_ORDER = ["Payments", "Platform", "Mobile", "Data", "Web", "Security", "IT Ops"];
  PEOPLE.forEach((p, i) => { p.userId = "u_" + (0x9f27ab41 + i * 0x11d3).toString(16); p.kb = p.sessions * p.kbAvg; });

  // Derived totals — computed, never hand-written, so every surface agrees.
  const TOTAL_SESSIONS = PEOPLE.reduce((n, p) => n + p.sessions, 0);       // 12,847
  const TOTAL_KB = PEOPLE.reduce((n, p) => n + p.kb, 0);
  const N_ROSTER = PEOPLE.length;                                          // 42
  const N_INSTALLED = PEOPLE.filter(p => p.cover !== "none").length;       // 39
  const N_SENDING = PEOPLE.filter(p => ["all", "some", "few"].includes(p.cover)).length; // 36
  const N_ACTIVE_WEEK = PEOPLE.filter(p => p.lastUp >= 0 && p.lastUp <= 7).length;       // 33
  const N_FULL = PEOPLE.filter(p => p.cover === "all").length;             // 24
  const OUTDATED_DEVICES = PEOPLE.flatMap(p => p.devices).filter(d => d.v !== "76.2.4").length; // 6

  // ── Projects & repos ──────────────────────────────────
  const PROJECTS = [
    { name: "Squeeze",      repos: ["orange-corp/squeeze", "orange-corp/pulp"], teams: ["Payments"] },
    { name: "Zest Monitor", repos: ["orange-corp/zest-monitor"],               teams: ["Platform", "Payments"] },
    { name: "Peel",         repos: ["orange-corp/peel-ios", "orange-corp/peel-android"], teams: ["Mobile"] },
    { name: "Citrus Press", repos: ["orange-corp/citrus-press"],               teams: ["Data"] },
    { name: "Storefront",   repos: ["orange-corp/storefront"],                 teams: ["Web"] },
    { name: "Marmalade",    repos: ["orange-corp/marmalade"],                  teams: ["Security", "IT Ops"] },
    { name: "Juicer",       repos: ["orange-corp/juicer"],                     teams: ["Platform", "Data"] },
  ];
  const N_REPOS = PROJECTS.reduce((n, p) => n + p.repos.length, 0); // 9
  const repoProject = {}; PROJECTS.forEach(p => p.repos.forEach(r => (repoProject[r] = p.name)));
  const teamProjects = t => PROJECTS.filter(p => p.teams.includes(t));

  const TITLES = {
    "Squeeze": ["Fix S3 routing gates", "Squeeze onboarding flow", "Refund idempotency keys", "Ledger reconcile pass", "Chargeback webhook retries", "Settlement report export", "Card vault token rotation", "3DS fallback flow"],
    "Zest Monitor": ["Tighten zest alert thresholds", "Zest alert thresholds", "Position monitor backfill", "Alert dedupe window", "Latency panel regression", "Pager rotation sync"],
    "Peel": ["Peel push token refresh", "Offline cart sync", "Biometric unlock flow", "App-clip checkout", "Deep link routing fix", "Store review prompt timing"],
    "Citrus Press": ["Nightly ETL memory spike", "Parquet compaction pass", "Schema drift detector", "Backfill 2025 events", "Dedup pipeline stage", "Warehouse cost audit"],
    "Storefront": ["Cart drawer a11y pass", "PDP image pipeline", "Checkout AB harness", "Search facet cache", "Hero LCP regression", "Promo banner scheduler"],
    "Marmalade": ["Access review exporter", "Secret scanner tuning", "SSO group mapping", "Endpoint agent rollout", "Vendor risk checklist", "Patch cadence report"],
    "Juicer": ["Build cache warmup", "Flaky test quarantine", "Runner pool autoscale", "Artifact GC policy", "Trace sampling config", "Release notes generator"],
  };
  const FAMILIES = ["claude-cli", "claude-cli", "claude-cli", "claude-desktop", "codex-cli"]; // weighted
  const MODELS = { "claude-cli": "claude-fable-5", "claude-desktop": "claude-sonnet-5", "codex-cli": "gpt-5.2-codex" };
  const BRANCHES = ["main", "main", "feat/routing-gates", "fix/alerts", "feat/onboarding", "chore/deps", "fix/lcp", "feat/export"];

  // ── Recent sessions — 420 deterministic rows (the loaded window) ──────────
  const SESSIONS = (() => {
    const rnd = mulberry32(0x5eed);
    const senders = PEOPLE.filter(p => p.sessions > 0);
    const weights = senders.map(p => p.sessions);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const pick = () => { let r = rnd() * wsum; for (let i = 0; i < senders.length; i++) { r -= weights[i]; if (r <= 0) return senders[i]; } return senders[0]; };
    const out = [];
    let minsAgo = 0.2;
    for (let i = 0; i < 420; i++) {
      const p = pick();
      const projs = teamProjects(p.team);
      const proj = projs[Math.floor(rnd() * projs.length)] || PROJECTS[0];
      const repo = proj.repos[Math.floor(rnd() * proj.repos.length)];
      const fam = FAMILIES[Math.floor(rnd() * FAMILIES.length)];
      const pool = TITLES[proj.name];
      const title = pool[Math.floor(rnd() * pool.length)];
      const events = 40 + Math.floor(rnd() * 480);
      const prompts = Math.max(2, Math.round(events * 0.11));
      const replies = Math.max(2, Math.round(events * 0.14));
      const tools = Math.max(1, Math.round(events * 0.32));
      const kb = Math.round(60 + rnd() * 420);
      const sid = ((0x10000000 + Math.floor(rnd() * 0xefffffff)) >>> 0).toString(16).padStart(8, "0") + "-" + Math.floor(rnd() * 0xffff).toString(16).padStart(4, "0");
      out.push({
        i, person: p, title, repo, project: proj.name, family: fam,
        model: MODELS[fam], branch: BRANCHES[Math.floor(rnd() * BRANCHES.length)],
        events, prompts, replies, tools, kb, sid,
        tokensIn: events * 900 + Math.floor(rnd() * 40000), tokensOut: events * 260 + Math.floor(rnd() * 9000),
        minsAgo: Math.round(minsAgo),
      });
      minsAgo += 0.5 + rnd() * 24; // ~420 rows stretch back ~3.5 days
    }
    return out;
  })();
  const agoStr = m => m < 1 ? "just now" : m < 60 ? Math.round(m) + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";

  // ── Storage growth (30 days, MB/day) ──────────────────
  const GROWTH = [22,26,24,9,7,25,29,31,27,24,10,8,28,33,30,26,23,9,7,27,31,29,34,26,11,8,25,30,28,21];

  // ── Logs — real record shapes from the fortress log format ────────────────
  // { d: day-offset (0=today), t:"HH:MM:SS", mod, lvl, msg, f:{k:v} }
  const LOG_BOOT = [
    { t:"09:02:07", mod:"host", lvl:"info", msg:"fortress host starting", f:{ version:"0.12.1", pid:41772 } },
    { t:"09:02:07", mod:"postgres", lvl:"info", msg:"phase acquiring", f:{ version:"18.4.0", cache:"hit" } },
    { t:"09:02:08", mod:"postgres", lvl:"info", msg:"phase initializing", f:{ dataDir:"~/.let/hx-fortress/pgdata" } },
    { t:"09:02:09", mod:"postgres", lvl:"info", msg:"server started", f:{ port:54329, listen:"127.0.0.1" } },
    { t:"09:02:09", mod:"postgres", lvl:"info", msg:"auth hardened", f:{ method:"scram-sha-256", hba:"loopback-only" } },
    { t:"09:02:10", mod:"postgres", lvl:"info", msg:"pgvector present", f:{ version:"0.8.1" } },
    { t:"09:02:18", mod:"postgres", lvl:"info", msg:"migrations applied", f:{ count:12, newest:"0012_embed_budget" } },
    { t:"09:02:19", mod:"postgres", lvl:"info", msg:"phase ready", f:{ bootMs:11214 } },
    { t:"09:02:19", mod:"session_vault", lvl:"info", msg:"store initialized", f:{ kind:"s3", bucket:"orange-corp-hx-fortress", orgId:"orange-corp", fortressId:"vault_93cc57c54c1a4618" } },
    { t:"09:02:19", mod:"session_vault", lvl:"info", msg:"storage self-test passed", f:{ ms:196 } },
    { t:"09:02:20", mod:"embed-worker", lvl:"info", msg:"embed worker started", f:{ model:"text-embedding-3-large", dimensions:1024 } },
    { t:"09:02:20", mod:"gateway", lvl:"info", msg:"gateway listening", f:{ port:8787, mcp:"/mcp" } },
    { t:"09:02:21", mod:"host", lvl:"info", msg:"relay connected", f:{ tunnel:"outbound", heartbeatMs:30000 } },
  ];
  const LOG_TODAY = [
    { t:"02:00:00", mod:"host", lvl:"info", msg:"residency audit started", f:{ scope:"all", sessions:12847 } },
    { t:"02:04:12", mod:"host", lvl:"info", msg:"residency audit complete", f:{ verified:12847, cloudContent:0, ms:252140 } },
    { t:"06:00:01", mod:"session_vault", lvl:"info", msg:"storage self-test passed", f:{ ms:184 } },
    { t:"11:38:09", mod:"embed-worker", lvl:"warn", msg:"rate limited, backing off", f:{ status:429, attempt:2, waitMs:1800 } },
    { t:"11:38:14", mod:"embed-worker", lvl:"info", msg:"embed pass complete", f:{ embedded:96, deadLetter:0, tokens:118204 } },
    { t:"14:02:44", mod:"host", lvl:"warn", msg:"tunnel closed, reconnecting", f:{ reason:"idle_timeout", backoffMs:1000 } },
    { t:"14:02:45", mod:"host", lvl:"info", msg:"relay connected", f:{ tunnel:"outbound", reconnects:2 } },
    { t:"15:58:44", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"ingestCommit", userId:"u_9f27ab41", family:"claude-cli", bytes:509558 } },
    { t:"16:12:03", mod:"gateway", lvl:"info", msg:"request served", f:{ route:"/sessions", grant:"read", ms:12 } },
    { t:"16:31:20", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"appendChunkToCanonical", userId:"u_9f27ab41", family:"claude-cli", bytes:402330 } },
    { t:"16:40:00", mod:"embed-worker", lvl:"info", msg:"embed pass complete", f:{ embedded:64, deadLetter:0, tokens:80112 } },
    { t:"16:41:56", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"listSessions", userId:"u_9f27cee7", rows:214, ms:9 } },
    { t:"16:43:41", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"signStagingUpload", userId:"u_9f27ab41", family:"claude-cli" } },
    { t:"16:43:58", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"ingestCommit", userId:"u_9f27ab41", family:"claude-cli", bytes:188416 } },
  ];
  const LOG_OLDER = [
    { d:1, t:"02:04:05", mod:"host", lvl:"info", msg:"residency audit complete", f:{ verified:12809, cloudContent:0, ms:249301 } },
    { d:1, t:"09:14:22", mod:"session_vault", lvl:"error", msg:"vault RPC failed", f:{ method:"readChunkText", error:"staging object not found", chunkId:"c_4471aa" } },
    { d:1, t:"09:14:23", mod:"session_vault", lvl:"info", msg:"vault RPC ok", f:{ method:"readChunkText", note:"client retried with re-signed chunk" } },
    { d:2, t:"02:04:18", mod:"host", lvl:"info", msg:"residency audit complete", f:{ verified:12771, cloudContent:0, ms:255870 } },
    { d:2, t:"13:40:31", mod:"embed-worker", lvl:"error", msg:"input dead-lettered after shrink", f:{ ownerId:"t_88ff02", reason:"token_limit" } },
    { d:3, t:"02:03:59", mod:"host", lvl:"info", msg:"residency audit complete", f:{ verified:12754, cloudContent:0, ms:247332 } },
  ];

  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : n;

  // Derived totals — same formulas as the prototype logic block.
  const N_WITH_SESSIONS = PEOPLE.filter(p => p.sessions > 0).length;
  const COVERAGE_PCT = Math.round((N_SENDING / N_ROSTER) * 100);
  const OBJ_ARTIFACTS = 2081, OBJ_STAGING = 12;
  const TOTAL_OBJECTS = TOTAL_SESSIONS + OBJ_ARTIFACTS + OBJ_STAGING;

  export {
    plural, fmtInt, fmtMB, fmtTok, agoStr, mulberry32,
    FORT, PEOPLE, TEAM_ORDER, PROJECTS, N_REPOS, repoProject, teamProjects,
    TITLES, FAMILIES, MODELS, BRANCHES, SESSIONS, GROWTH,
    LOG_BOOT, LOG_TODAY, LOG_OLDER,
    TOTAL_SESSIONS, TOTAL_KB, N_ROSTER, N_INSTALLED, N_SENDING, N_ACTIVE_WEEK,
    N_FULL, OUTDATED_DEVICES, N_WITH_SESSIONS, COVERAGE_PCT,
    OBJ_ARTIFACTS, OBJ_STAGING, TOTAL_OBJECTS,
  };
