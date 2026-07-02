# Embedded pgvector Packaging — Implementation Plan

> **Status:** design for review, not yet approved for build.
> **Origin:** surfaced from MC-2467 (workbench session-viewer semantic search). Semantic search returns `vector_index_unavailable` on every embedded-Postgres fortress because the stock zonky bundle ships no pgvector, so the gated `0006`/`0010` migrations never apply. The workbench side is done; this closes the fortress side.

**Goal:** Every fortress — fresh install *and* already-running — has pgvector available in its embedded Postgres, so `hx.embeddings` + the HNSW index get created and semantic search works, with zero manual steps and no external Postgres.

**Architecture:** We do NOT build pgvector on the customer host (the zonky bundle ships no `pg_config`/headers, and an appliance must not require a C toolchain). Instead: a CI job produces a small, checksummed **pgvector artifact per `(classifier × PG-major)`** and publishes it as a release asset alongside the fortress binaries. At runtime, an **idempotent, best-effort inject step** runs on every boot before migrations: if `vector.control` isn't already in the bundle, it downloads the matching artifact (sha256-verified) and drops `vector.<so|dylib>` + `vector.control` + `vector--*.sql` into the bundle's lib + extension dirs. The already-gated migrations then apply and the embed worker backfills.

**Tech stack:** Bun, TypeScript, embedded zonky Postgres (PG 18), GitHub Actions, pgvector.

## Global constraints

- **2-space indentation.** Type-safe; no `as any`/`as unknown`/`as never`.
- **Host-clean — everything under `~/.let`.** The injected `vector.{so,dylib}` + control + SQL land in the fortress's *own* embedded bundle (`~/.let/fortress/postgres/<version>/lib` and `.../share/extension`), beside the stock extensions (`pgcrypto`, `pg_trgm`) it already uses. Nothing is written to `/usr/local`, `/opt`, a system Postgres, or anywhere outside `~/.let` (or `FORTRESS_ROOT` when set). This works because PostgreSQL is **relocatable**: the running `postgres` binary derives `$libdir`/sharedir relative to its own extracted location. The only place host packages are touched is the **CI build runner** (ephemeral), never the customer host — the host only receives the prebuilt artifact.
- **Best-effort, never fatal:** a missing/failed pgvector artifact must NEVER block fortress boot or session reads. Semantic search staying unavailable is acceptable; a crash is not. This mirrors the existing gated-migration philosophy ("skipped and retried on a later boot").
- **Idempotent + sentinel-independent:** the inject step must upgrade an *existing* install (which already wrote the `.ready` bundle sentinel and has live data) without re-extracting or touching the data dir.
- **Checksum every download** (sha256 sidecar), exactly like `acquireBinaries` already does for the zonky jar.
- **No commits to `main`.** Feature branch `feat/embedded-pgvector-packaging`.

## The one open decision (resolve before Task 1)

**How CI produces the per-platform `vector` artifact.** pgvector upstream ships source only; prebuilt binaries live in per-platform OS repos (PGDG apt/yum for glibc Linux, Homebrew for macOS, Alpine `apk` for musl). Two options:

- **A — Build from source in CI (recommended).** Per platform, install a PG 18 (apt.postgresql.org / `brew install postgresql@18`) with headers, `make PG_CONFIG=… && make DESTDIR=… install` pgvector at a pinned version, harvest the 3 file types. Most reproducible; we control the exact PG major + flags; no coupling to a distro's packaging layout.
- **B — Extract from prebuilt OS packages.** Pull `postgresql-18-pgvector` (deb) / brew bottle / apk, unpack, harvest the same files. Less build infra, but N heterogeneous sources and their layouts to track.

Either way the output is **our** single checksummed artifact per classifier, so the runtime has one coordinate (not 3 third-party repos). This plan is written for **Option A**; switching to B changes only Task 1's harvesting step.

ABI note: pgvector's module is stable within a PG major, so a PG 18 build for a given arch/libc loads into zonky's PG 18.x for the same classifier. Match libc (glibc vs musl) and arch per classifier.

## Platform matrix

Align with the fortress release targets + the embedded-PG classifiers:

| Classifier | libc/arch | pgvector source (Option A) | Priority |
| --- | --- | --- | --- |
| `linux-amd64` | glibc x64 | apt.postgresql.org PG18 + build | P0 (prod) |
| `linux-arm64v8` | glibc arm64 | arm64 runner + build | P0 |
| `darwin-arm64v8` | macOS arm64 | `brew postgresql@18` + build | P1 (dev) |
| `darwin-amd64` | macOS x64 | `brew postgresql@18` + build | P1 |
| `linux-amd64-alpine` | musl x64 | Alpine container + build | P2 (deferred; note in `log()` if a musl fortress can't get it) |

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `.github/workflows/release.yml` | Add a `pgvector` job/matrix that builds + publishes `pgvector-pg<major>-<classifier>.tar.gz` (+ `.sha256`) as release assets | Modify |
| `src/host/postgres/pgvector-artifact.ts` | Pure helpers: artifact filename, URL, sha256 verification | Create |
| `src/host/postgres/pgvector-artifact.test.ts` | Unit tests for the above | Create |
| `src/host/postgres/pgvector-install.ts` | `ensurePgvectorInstalled(deps)` — idempotent locate + inject | Create |
| `src/host/postgres/pgvector-install.test.ts` | Unit tests (injected fs + downloader) | Create |
| `src/host/postgres/index.ts` | Call `ensurePgvectorInstalled` before `migrate()`, embedded mode only | Modify |
| `src/host/postgres/resolve.ts` | Resolve `FORTRESS_PGVECTOR_URL` / `FORTRESS_PGVECTOR_VERSION` | Modify |
| `docs/plans/embedded-pgvector-packaging.md` | This plan | Create |

Migrations (`0006`/`0010`) and the embed worker are **unchanged** — they already do the right thing once `vector` is present.

---

### Task 1: CI — build & publish pgvector artifacts

**Files:** `.github/workflows/release.yml`

**Interfaces:**
- Produces release assets named `pgvector-pg<major>-<classifier>.tar.gz` and `pgvector-pg<major>-<classifier>.tar.gz.sha256`, each tar containing `lib/vector.<so|dylib>` and `share/extension/vector.control` + `share/extension/vector--*.sql`. `<major>` = `18`; `<classifier>` ∈ the matrix above. pgvector version pinned via a workflow env `PGVECTOR_REF` (e.g. `v0.8.0`).

- [ ] **Step 1: Add a matrix job**

Add a job `pgvector` to `release.yml` (runs before/parallel to publish). For each P0/P1 classifier: install PG 18 with headers, build pgvector at `PGVECTOR_REF`, harvest files, tar, checksum. Example (linux-amd64 leg):

```yaml
  pgvector:
    name: Build pgvector (${{ matrix.classifier }})
    runs-on: ${{ matrix.runner }}
    permissions: { contents: write }
    strategy:
      matrix:
        include:
          - classifier: linux-amd64
            runner: ubuntu-latest
          - classifier: linux-arm64v8
            runner: ubuntu-24.04-arm
          - classifier: darwin-arm64v8
            runner: macos-14
          - classifier: darwin-amd64
            runner: macos-13
    env:
      PG_MAJOR: "18"
      PGVECTOR_REF: "v0.8.0"
    steps:
      - name: Install PostgreSQL ${{ env.PG_MAJOR }} (+ headers)
        shell: bash
        run: |
          set -euo pipefail
          if [[ "${{ runner.os }}" == "Linux" ]]; then
            sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release; echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
            curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
            sudo apt-get update
            sudo apt-get install -y "postgresql-server-dev-${PG_MAJOR}" build-essential
            echo "PG_CONFIG=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config" >> "$GITHUB_ENV"
          else
            brew install "postgresql@${PG_MAJOR}"
            echo "PG_CONFIG=$(brew --prefix postgresql@${PG_MAJOR})/bin/pg_config" >> "$GITHUB_ENV"
          fi
      - name: Build pgvector
        shell: bash
        run: |
          set -euo pipefail
          git clone --depth 1 --branch "${PGVECTOR_REF}" https://github.com/pgvector/pgvector.git
          make -C pgvector PG_CONFIG="${PG_CONFIG}"
          make -C pgvector PG_CONFIG="${PG_CONFIG}" DESTDIR="$PWD/stage" install
      - name: Assemble + checksum artifact
        shell: bash
        run: |
          set -euo pipefail
          libdir="$("${PG_CONFIG}" --pkglibdir)"; sharedir="$("${PG_CONFIG}" --sharedir)"
          out="pgvector-pg${PG_MAJOR}-${{ matrix.classifier }}"
          mkdir -p "pkg/${out}/lib" "pkg/${out}/share/extension"
          cp "$PWD/stage${libdir}"/vector.* "pkg/${out}/lib/"
          cp "$PWD/stage${sharedir}/extension/"vector.control "$PWD/stage${sharedir}/extension/"vector--*.sql "pkg/${out}/share/extension/"
          tar -C "pkg/${out}" -czf "${out}.tar.gz" .
          shasum -a 256 "${out}.tar.gz" | awk '{print $1}' > "${out}.tar.gz.sha256"
      - name: Upload as release asset
        # reuse the same gh release the fortress binaries publish to (same tag/version)
        run: gh release upload "v${{ needs.release.outputs.version }}" "${out}.tar.gz" "${out}.tar.gz.sha256" --clobber
        env: { GH_TOKEN: "${{ github.token }}" }
```

> `runner.os` picks `pg_config`; on Linux from PGDG's `postgresql-server-dev-18`, on macOS from the brew keg. Wire the job into the release's version/tag outputs so assets land on the same release the binaries do.

- [ ] **Step 2: Pin & document the pgvector version**

Add `PGVECTOR_REF` as the single source of truth in the workflow env, and a one-line note in the workflow comment that bumping pgvector = bump this ref.

- [ ] **Step 3: Verify assets exist**

After a dry `workflow_dispatch`, confirm the release has `pgvector-pg18-linux-amd64.tar.gz` (+ `.sha256`) etc. Manual gate — no code test.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(fortress): build + publish per-platform pgvector artifacts"
```

---

### Task 2: Runtime — artifact URL + checksum helpers (pure, TDD)

**Files:** `src/host/postgres/pgvector-artifact.ts`, `src/host/postgres/pgvector-artifact.test.ts`

**Interfaces:**
- Consumes: `ZonkyClassifier` from `./classifier`.
- Produces:
  - `pgMajorOf(version: string): number` — `"18.4.0" → 18`.
  - `pgvectorArtifactName(pgMajor: number, classifier: ZonkyClassifier): string` — `pgvector-pg18-linux-amd64.tar.gz`.
  - `pgvectorArtifactUrl(baseUrl: string, pgMajor: number, classifier: ZonkyClassifier): string`.
  - `verifySha256(bytes: Uint8Array, expectedHex: string): boolean`.

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pgMajorOf, pgvectorArtifactName, pgvectorArtifactUrl, verifySha256,
} from "./pgvector-artifact.ts";
import { createHash } from "node:crypto";

describe("pgvector-artifact", () => {
  it("extracts the PG major from a full version", () => {
    assert.equal(pgMajorOf("18.4.0"), 18);
  });
  it("builds the classifier-scoped artifact name", () => {
    assert.equal(pgvectorArtifactName(18, "linux-amd64"), "pgvector-pg18-linux-amd64.tar.gz");
  });
  it("joins base + name into a URL (no double slash)", () => {
    assert.equal(
      pgvectorArtifactUrl("https://x/rel/", 18, "darwin-arm64v8"),
      "https://x/rel/pgvector-pg18-darwin-arm64v8.tar.gz",
    );
  });
  it("verifies a sha256 hex digest", () => {
    const bytes = new TextEncoder().encode("hi");
    const hex = createHash("sha256").update(bytes).digest("hex");
    assert.equal(verifySha256(bytes, hex), true);
    assert.equal(verifySha256(bytes, "deadbeef"), false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test --import tsx src/host/postgres/pgvector-artifact.test.ts`).

- [ ] **Step 3: Implement**

```typescript
import { createHash } from "node:crypto";
import type { ZonkyClassifier } from "./classifier";

export function pgMajorOf(version: string): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) throw new Error(`bad PG version: ${version}`);
  return major;
}

export function pgvectorArtifactName(pgMajor: number, classifier: ZonkyClassifier): string {
  return `pgvector-pg${pgMajor}-${classifier}.tar.gz`;
}

export function pgvectorArtifactUrl(
  baseUrl: string,
  pgMajor: number,
  classifier: ZonkyClassifier,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pgvectorArtifactName(pgMajor, classifier)}`;
}

export function verifySha256(bytes: Uint8Array, expectedHex: string): boolean {
  return createHash("sha256").update(bytes).digest("hex") === expectedHex.trim();
}
```

- [ ] **Step 4: Run — expect PASS. Step 5: Commit** `feat(fortress): pgvector artifact url + checksum helpers`.

---

### Task 3: Runtime — idempotent inject (`ensurePgvectorInstalled`)

**Files:** `src/host/postgres/pgvector-install.ts`, `src/host/postgres/pgvector-install.test.ts`

**Interfaces:**
- Consumes: `pgvectorArtifactUrl`, `verifySha256` (Task 2); a `fetchImpl: typeof fetch`; a tar extractor (reuse the `Spawner` pattern from `extract.ts`); node `fs`.
- Produces:
  ```typescript
  export interface EnsurePgvectorDeps {
    versionDir: string;              // ~/.let/fortress/postgres/<version>
    classifier: ZonkyClassifier;
    pgMajor: number;
    baseUrl: string;                 // FORTRESS_PGVECTOR_URL
    darwin: boolean;                 // macOS → strip quarantine + ad-hoc sign the .dylib
    fetchImpl: typeof fetch;
    extractTarGz: (tarPath: string, destDir: string) => Promise<void>;
    spawn: (cmd: string[]) => Promise<void>;   // for xattr/codesign (Spawner)
    log: (msg: string, meta?: Record<string, unknown>) => void;
  }
  export async function ensurePgvectorInstalled(deps: EnsurePgvectorDeps): Promise<"present" | "installed" | "skipped">;
  ```
  Semantics: returns `"present"` if `vector.control` already in the bundle (no work); `"installed"` after a successful download+inject; `"skipped"` on any failure (logged, never thrown).

- [ ] **Step 1: Failing tests** (inject a fake fs layout + fake fetch)

Cover: (a) returns `"present"` and does not fetch when `share/extension/vector.control` exists; (b) locates the extension dir by an existing sibling `*.control` and copies `vector.*` into it + `vector.<so|dylib>` into the lib dir, returns `"installed"`; (c) a fetch failure returns `"skipped"` and does NOT throw; (d) a checksum mismatch returns `"skipped"` and injects nothing.

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePgvectorInstalled } from "./pgvector-install.ts";

async function bundle(withVector = false): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pgv-"));
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await mkdir(path.join(dir, "share", "extension"), { recursive: true });
  await writeFile(path.join(dir, "share", "extension", "plpgsql.control"), "");
  if (withVector) await writeFile(path.join(dir, "share", "extension", "vector.control"), "");
  return dir;
}
const okFetch = ((): typeof fetch =>
  (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch)();

describe("ensurePgvectorInstalled", () => {
  it("no-ops when vector.control already present", async () => {
    const dir = await bundle(true);
    let fetched = false;
    const r = await ensurePgvectorInstalled({
      versionDir: dir, classifier: "linux-amd64", pgMajor: 18, baseUrl: "https://x",
      fetchImpl: (async () => { fetched = true; return new Response(); }) as unknown as typeof fetch,
      darwin: false, extractTarGz: async () => {}, spawn: async () => {}, log: () => {},
    });
    assert.equal(r, "present");
    assert.equal(fetched, false);
  });

  it("returns 'skipped' (no throw) when the download fails", async () => {
    const dir = await bundle(false);
    const r = await ensurePgvectorInstalled({
      versionDir: dir, classifier: "linux-amd64", pgMajor: 18, baseUrl: "https://x",
      fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
      darwin: false, extractTarGz: async () => {}, spawn: async () => {}, log: () => {},
    });
    assert.equal(r, "skipped");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `ensurePgvectorInstalled`:

Sketch (wrap the whole body in try/catch → `log` + `return "skipped"`):

```typescript
export async function ensurePgvectorInstalled(deps: EnsurePgvectorDeps): Promise<"present" | "installed" | "skipped"> {
  try {
    const extDir = await findExtensionDir(deps.versionDir);     // dir holding *.control (e.g. plpgsql.control)
    if (existsSync(path.join(extDir, "vector.control"))) return "present";

    const url = pgvectorArtifactUrl(deps.baseUrl, deps.pgMajor, deps.classifier);
    const [tarBytes, expected] = await Promise.all([
      fetchBytes(deps.fetchImpl, url),
      fetchText(deps.fetchImpl, `${url}.sha256`),
    ]);
    if (!verifySha256(tarBytes, expected)) { deps.log("pgvector checksum mismatch", { url }); return "skipped"; }

    const tmp = await mkdtemp(path.join(os.tmpdir(), "pgv-inject-"));
    const tarPath = path.join(tmp, "v.tgz");
    await writeFile(tarPath, tarBytes);
    await deps.extractTarGz(tarPath, tmp);                       // yields lib/ + share/extension/
    const libDir = await findLibDir(deps.versionDir);           // dir holding stock extension modules, else <versionDir>/lib
    await copyInto(path.join(tmp, "lib"), libDir, /^vector\./);
    await copyInto(path.join(tmp, "share", "extension"), extDir, /^vector(\.control|--.*\.sql)$/);
    // macOS: a DOWNLOADED .dylib carries a com.apple.quarantine xattr that blocks
    // dlopen by the local postgres process. Strip it and ad-hoc re-sign so the
    // library loads — still entirely within ~/.let, nothing host-wide. No-op on
    // Linux (deps.darwin false). Failures here are non-fatal (fall to "skipped").
    if (deps.darwin) {
      const dylib = path.join(libDir, "vector.dylib");
      await deps.spawn(["xattr", "-d", "com.apple.quarantine", dylib]).catch(() => {});
      await deps.spawn(["codesign", "--force", "--sign", "-", dylib]).catch(() => {});
    }
    await rm(tmp, { recursive: true, force: true });
    deps.log("pgvector installed into embedded bundle", { classifier: deps.classifier, pgMajor: deps.pgMajor });
    return "installed";
  } catch (err) {
    deps.log("pgvector install skipped (best-effort)", { err: String(err) });
    return "skipped";
  }
}
```

Helpers `findExtensionDir` / `findLibDir` self-locate by an existing stock file (`plpgsql.control`; an existing `*.so`/`*.dylib` module) so no bundle-layout path is hardcoded. `copyInto(src, dest, re)` copies matching filenames.

- [ ] **Step 4: Run — expect PASS. Step 5: Commit** `feat(fortress): idempotent best-effort pgvector inject`.

---

### Task 4: Wire into boot + config

**Files:** `src/host/postgres/index.ts`, `src/host/postgres/resolve.ts`

**Interfaces:**
- Consumes: `ensurePgvectorInstalled` (Task 3); `resolvePostgresConfig` (existing).
- Produces: `resolved.pgvectorUrl` (from `FORTRESS_PGVECTOR_URL`, default = the release-assets base) and the inject call in the embedded provider's boot sequence, before `migrate()`.

- [ ] **Step 1:** In `resolve.ts`, add `pgvectorUrl` to `ResolvedPostgresConfig` and resolve it: `pick(env.FORTRESS_PGVECTOR_URL, persisted.pgvectorUrl, DEFAULT_PGVECTOR_URL)`. Define `DEFAULT_PGVECTOR_URL` = the GitHub release-assets base for the current version (same base the binary installer/download proxy uses).

- [ ] **Step 2:** In `index.ts` embedded provider, add a step **before** `migrate`:

```typescript
ensureVector: async () => {
  await ensurePgvectorInstalled({
    versionDir,
    classifier,
    pgMajor: pgMajorOf(resolved.version),
    baseUrl: resolved.pgvectorUrl,
    darwin: (deps.platform ?? process.platform) === "darwin",
    fetchImpl: fetch,
    extractTarGz: makeTarGzExtractor(spawner),
    spawn: async (cmd) => { await spawner.run(cmd); },
    log: (msg, meta) => log.info(meta ?? {}, msg),
  });
},
```

and call it in the start orchestration between `ensureDbSchema` and `migrate` (so a newly-injected `vector.control` is visible — `pg_available_extensions` reads control files at query time, no PG restart needed). For **external** mode, do NOT inject (operator owns that PG). This covers BOTH fresh installs (bundle just extracted) and existing installs (runs every boot, idempotent, independent of the `.ready` sentinel).

- [ ] **Step 3:** Type-check (`bun run typecheck` or `tsc --noEmit`) — no errors.

- [ ] **Step 4: Commit** `feat(fortress): inject pgvector before migrate (embedded), FORTRESS_PGVECTOR_URL knob`.

---

### Task 5: End-to-end verification (manual, on a dev fortress)

- [ ] **Step 1:** On a fortress whose embedded DB currently reports `vector_index_unavailable`, deploy this branch and restart. Confirm the log shows `pgvector installed into embedded bundle`.
- [ ] **Step 2:** Confirm migrations `0006`/`0010` now apply (they were skipped-and-unrecorded, so they run this boot) — check `hx.schema_migrations` contains `0006_embeddings` and `0010_embeddings_indexes`.
- [ ] **Step 3:** Confirm the embed worker's boot-time backfill drains (`hx.embeddings` row count climbs to the turn count).
- [ ] **Step 4:** From the workbench session viewer, switch to **Search**, run a natural-language query, and confirm ranked hits return (the MC-2467 UI now shows results instead of the `unavailableNoIndex` message).
- [ ] **Step 5:** Restart again → confirm `ensurePgvectorInstalled` returns `"present"` (idempotent, no re-download).

---

## Self-review

**Coverage vs the goal:**
- Fresh install gets pgvector → Task 1 (artifact) + Task 3/4 (inject during boot after extract). ✓
- Existing install upgrades seamlessly → Task 4 runs the idempotent inject every boot, independent of `.ready`; no data touched; gated migrations (unrecorded when skipped) apply; embed worker backfills. ✓
- No host toolchain / no external PG required → artifacts prebuilt in CI, injected as files. ✓
- Host-clean → inject targets only the bundle dirs under `~/.let` (relocatable PG resolves them); macOS quarantine/codesign handled in-place; nothing host-wide. ✓
- Never blocks boot → Task 3 is best-effort (`"skipped"` on any failure, never throws); Task 4 doesn't await it as fatal. ✓
- Air-gap / mirror → `FORTRESS_PGVECTOR_URL` (Task 4). ✓

**Open items to confirm during build:**
- Exact `pkglibdir`/`sharedir` names inside the zonky bundle — resolved at runtime by self-locating against a stock `*.control` / existing module, so no hardcoded path; verify the stock control file name used as the anchor (`plpgsql.control` is always present).
- `linux-arm64v8` needs an arm64 runner (`ubuntu-24.04-arm`) or a cross-build; confirm availability.
- musl/alpine (`linux-amd64-alpine`) deferred to P2 — if a musl fortress can't fetch an artifact, `ensurePgvectorInstalled` returns `"skipped"` and semantic search stays unavailable there (honest, non-fatal). Log it.
- ABI: build pgvector against PG 18 for each classifier's arch/libc; loads into zonky PG 18.x. Confirm the zonky PG major stays 18 (`DEFAULT_PG_VERSION`); if it bumps, the artifact `pgMajor` follows automatically via `pgMajorOf(resolved.version)`.
