# HX Fortress UI

The administration console `hx-fortress ui` serves. Vite + React + TypeScript,
no backend: every number, name and log line is demo data in `src/data.ts`.

```sh
pnpm install && pnpm dev     # http://localhost:5641
pnpm build                   # typecheck + bundle to dist/
```

## URLs

Every stateful surface is addressable. No query strings, no hashes — the path
is the source of truth, parsed in `src/router.ts` and rendered from there, so
a cold load of any link below lands exactly where it says.

| Path | Shows |
| --- | --- |
| `/` | Overview |
| `/sessions` | Metadata explorer |
| `/sessions/by/{team\|person\|project\|repo\|newest}` | …grouped |
| `/sessions/search/routing+gates` | …searched (spaces are `+`) |
| `/sessions/{family}/{sessionId}` | One session — its storage key, e.g. `/sessions/claude-cli/59e3ccf5-8f8b` |
| `/sessions/{family}/{sessionId}/verify` | …its residency proof, re-run on load |
| `/people/{id}` | One person, e.g. `/people/erik` |
| `/adoption` | Roster vs reality |
| `/adoption/by/{team\|group\|coverage\|status}` | …grouped |
| `/adoption/{not-installed\|quiet\|gone-quiet\|partial\|outdated}` | …one cohort |
| `/adoption/search/{q}` | …searched |
| `/residency` | Residency proof |
| `/residency/gates` | …scrolled to the routing gates |
| `/residency/incident` | …the incident preview |
| `/residency/verify/{family}/{sessionId}` | …proving one session, without leaving the audit |
| `/compliance` | Posture, egress, retention, audit |
| `/compliance/{egress\|retention\|audit}` | …at that panel |
| `/postgres` · `/postgres/failed-boot` | Postgres, and the failed-boot preview |
| `/storage` · `/embeddings` | Blob storage · embeddings |
| `/storage/credentials` | …rotating the store key in place |
| `/storage/target` | …changing provider, bucket or region |
| `/storage/runs/{runId}` | One migration run and its log, e.g. `/storage/runs/mig_7f3a` |
| `/ops` · `/ops/keys` | Ops tools, and the keys panel |
| `/logs` | Log viewer |
| `/logs/{source}/{warnings\|errors}/{1h\|7d\|boot}` | …filtered, e.g. `/logs/session_vault/errors/7d` |
| `…/shortcuts` | The keyboard map, over any page — `/shortcuts`, `/logs/errors/shortcuts` |

Segments compose (`/adoption/by/coverage/not-installed`) and defaults are
omitted, so the URL is always the shortest thing that says what you mean. The
log segments use disjoint vocabularies, so order doesn't matter and any subset
works — `/logs/boot`, `/logs/errors`, `/logs/postgres/boot` all parse.

Dialogs are locations too. They nest under the page they cover, so the backdrop
is never lost and a shared link opens the dialog over the right context.
Opening one pushes a marked history entry, so dismissing it — button, `Esc`, or
browser Back — rewinds instead of leaving debris; a dialog link opened cold
rewrites to the page underneath instead. Navigating to another section
dismisses whatever dialog is open, so overlays never pile up in later URLs.

Unknown paths rewrite themselves to `/`.

**Serving this:** it is a single-page app, so the host must return `index.html`
for any unmatched path (Vite's dev server and `vite preview` already do). Serve
`dist/` with a history fallback or every deep link 404s on refresh.

## Changing where transcripts rest

A credential rotation is edited in place on `/storage` — S3 takes both halves of
the key, GCS a whole service-account document — and needs only a service
restart, because the store is built once at module init.

Changing the **provider, bucket or region** is different: the new target is
empty, so the console asks the one question that matters before anything moves.

- **Copy & switch** — a run copies every object to the new bucket, verifies the
  byte counts, and only then rewrites `credentials.json`. Nothing is deleted
  from the old bucket.
- **Start fresh** — the switch is immediate and the objects already stored stay
  behind. They stop resolving from this fortress, so residency verification
  fails for them; the page says so, before and after.

Runs are addressable and kept forever with their logs. A failed run switches
nothing, and **Retry** resumes — the inventory counts what already landed and
moves only the remainder, because a copy is idempotent.

## Layout

- `src/data.ts` — the demo world. Replace this module to wire real data.
- `src/router.ts` — path ⇆ state.
- `src/state.tsx` — route + service/version/audit-trail state.
- `src/render.ts` — row/list/table markup shared across views.
- `src/views/` — one file per section.
- `src/styles.css` — the design system, byte-identical to the approved prototype.
