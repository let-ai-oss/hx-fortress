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
| `/people/{id}` | One person, e.g. `/people/erik` |
| `/adoption` | Roster vs reality |
| `/adoption/by/{team\|group\|coverage\|status}` | …grouped |
| `/adoption/{not-installed\|quiet\|gone-quiet\|partial\|outdated}` | …one cohort |
| `/adoption/search/{q}` | …searched |
| `/residency` | Residency proof |
| `/residency/gates` | …scrolled to the routing gates |
| `/residency/incident` | …the incident preview |
| `/compliance` | Posture, egress, retention, audit |
| `/compliance/{egress\|retention\|audit}` | …at that panel |
| `/postgres` · `/postgres/failed-boot` | Postgres, and the failed-boot preview |
| `/storage` · `/embeddings` | Blob storage · embeddings |
| `/ops` · `/ops/keys` | Ops tools, and the keys panel |
| `/logs` | Log viewer |
| `/logs/{source}/{warnings\|errors}/{1h\|7d\|boot}` | …filtered, e.g. `/logs/session_vault/errors/7d` |

Segments compose (`/adoption/by/coverage/not-installed`) and defaults are
omitted, so the URL is always the shortest thing that says what you mean. The
log segments use disjoint vocabularies, so order doesn't matter and any subset
works — `/logs/boot`, `/logs/errors`, `/logs/postgres/boot` all parse.

Unknown paths rewrite themselves to `/`.

**Serving this:** it is a single-page app, so the host must return `index.html`
for any unmatched path (Vite's dev server and `vite preview` already do). Serve
`dist/` with a history fallback or every deep link 404s on refresh.

## Layout

- `src/data.ts` — the demo world. Replace this module to wire real data.
- `src/router.ts` — path ⇆ state.
- `src/state.tsx` — route + service/version/audit-trail state.
- `src/render.ts` — row/list/table markup shared across views.
- `src/views/` — one file per section.
- `src/styles.css` — the design system, byte-identical to the approved prototype.
