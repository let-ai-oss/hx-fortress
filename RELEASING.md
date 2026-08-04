# Releasing hx-fortress

One change ships across three repositories, in one order:

1. **`hx-protocol`** — the wire types.
2. **`hx-fortress`** — this repository.
3. **`let-forge`** — the hub.

The order is not a convention. Each step is a precondition of the one after it,
and the last of them publishes a binary that fortresses in the field can install
themselves.

## Why the order is forced

**The protocol merges first, because both consumers pin it by commit.**
`hx-fortress` and `let-forge` each depend on `@let-ai/hx-protocol` at a git SHA.
A squash merge produces a **new** commit, so the SHA that exists afterwards is
not the branch tip either consumer is pinned to now. Until the protocol PR is
merged there is no SHA to pin to.

**Both consumers re-pin together, and each re-pin carries its own lockfile.**
Two consumers on different protocol commits are compiling different wire types
against each other. The lockfile has to move in the same commit as
`package.json`: a lockfile still resolving the old SHA is what actually gets
installed, so CI would go green against types nobody is shipping.

**The hub deploys before the fortress is published.** The new fortress asks the
hub questions the new protocol defines — the residency witness, the roster sync,
the console hand-off. Deploy the side that answers before the side that asks; a
hub that has not deployed yet cannot answer, and the fortress cannot tell that
apart from a hub that will not.

**The fortress push is last, and it *is* the release.** `package.json` and
`bun.lock` are both in `release.yml`'s `on.push.paths`, so the version bump and
the protocol re-pin are pushes that build, publish and move the build tag. There
is no way to land them quietly first: pushing them **is** the release.

## What breaks if the order is violated

| Violation | What happens |
| --- | --- |
| The fortress re-pin is pushed before the protocol PR merges | The pin names a commit on a branch that is about to be squashed away. It resolves today and stops resolving the moment the branch is deleted, so the build is not reproducible and a later `bun install --frozen-lockfile` fails. |
| The two consumers are re-pinned in separate rounds | The hub and the fortress serialize different shapes for the same message. The failure surfaces as a field that silently reads `undefined`, not as a build error. |
| The fortress is published before the hub deploys | Every fortress that self-updates starts asking a hub that does not understand the question. Residency runs come back qualified with a witness that was never reachable, and the console hand-off lands on a hub route that does not exist. |
| The immutable release is dispatched on a **branch** instead of the tag | `workflow_dispatch` runs the workflow file *at the dispatched ref*, and builds it there. The release is cut from whatever the branch points at now, which is not the commit the build tag records. |
| The version bump is pushed twice for one version | The rolling step force-moves `builds/hx-fortress-<version>` on every push. A build tag verified before a second push no longer names the commit that was verified. |

## The rungs

`<version>` below is the version in `package.json` for this release.

| # | Rung | How it is verified |
| --- | --- | --- |
| 0 | Precheck the signing posture: the release signing secret is unset, and the latest release carries no `.sig` sidecar. | `gh release view` the latest build tag and list its assets — no `*.sig` present. |
| 1 | Merge the `hx-protocol` PR. **Squash.** | `git rev-parse origin/main` in `hx-protocol` — the SHA is new, and is not the branch tip either consumer is pinned to. |
| 2 | In `hx-fortress` **and** `let-forge`, re-pin `@let-ai/hx-protocol` to that SHA and regenerate the lockfile **in the same commit**. | In each repo, the SHA appears in `package.json` *and* in the lockfile's dependency line *and* in its resolved entry. `bun install --frozen-lockfile` (fortress) / `pnpm install --frozen-lockfile` (hub) succeed unchanged. |
| 3 | Merge `let-forge`. Deploy `dev`, then `beta`. | The environment's own version endpoint reports the merged commit. Never the exit code of `gh run watch` — see the standing rules. |
| 4 | Confirm `MIN_FORTRESS_CONSOLE_VERSION` in the hub equals the version this release will publish. | Read it in the deployed hub, not in the branch that set it. |
| 5 | Push `hx-fortress` `main`: the version bump and the protocol re-pin. **This is the release build.** | The release workflow ran for that SHA, and `git rev-parse builds/hx-fortress-<version>` equals it. Record that commit — later rungs compare against it. |
| 6 | Publish the immutable release: `workflow_dispatch` on the **tag** `builds/hx-fortress-<version>`, never a branch. | **Pre-dispatch:** `git rev-parse builds/hx-fortress-<version>` still equals the commit recorded at rung 5. **Post:** `releases/hx-fortress-<version>` exists and its `target_commitish` is that same commit. |
| 7 | Freeze: no further push to `main` touching `src/`, `ui/`, `scripts/`, `Dockerfile`, `package.json`, `bun.lock` **or `.github/workflows/release.yml`** until rung 6 has been verified. | Those are `release.yml`'s own `on.push.paths`. Any push touching one re-runs the rolling step and force-moves the build tag — including rung 12's edit to the workflow file itself, which is why that is a release of its own. |
| 8 | Bake the production signing anchors into `src/host/trust/signing-keys.ts`, keeping the current and next public halves. This release still publishes **unsigned**. | `hasProductionAnchor()` is true for the shipped build; the release assets still carry no `.sig`. |
| 9 | Bake the let.ai **root** anchors: the production root alongside the development one. | Both keyids are present in `LETAI_ROOT_KEYS`, and a fortress on this build verifies a key proof signed by either. |
| 10 | **Fleet-verification gate.** Every fortress row in workbench-admin → HX Fortresses reports at least this version. | Rows reading OFFLINE count as **not** verified. A row offline for more than 30 days may be waived — listed by organization id, in writing. |
| 11 | Only after rung 10: set `LETAI_FORTRESS_ROOT_SIGNING_KEY` to the production key on **every** hub environment — dev, beta and prod. The variable is per-deployment. | Read it back on each environment; a missed one leaves that environment minting proofs the fleet will reject. |
| 12 | The next release signs: publish with the signing secret set, delete **both** `\|\| 'hxf-dev-2026-07'` keyid fallbacks in `release.yml`, and drop the development artifact anchor and the development root. | Assets carry `.sig` sidecars; `grep -c "hxf-dev-2026-07" .github/workflows/release.yml` is `0`; the shipped anchor sets hold production keys only. |

Rung 12 is a **release of its own** — its own version bump, its own push, its
own immutable dispatch. It is not an amendment to the one before it.

## Remediation

**The immutable release was cut from the wrong commit.** Delete the release
**and** the tag, then dispatch again on the correct build tag. Deleting the
release alone leaves the tag pointing where it was, and the next dispatch
recreates the same wrong artifact.

**Rollback has two arms, and they are not interchangeable.**

*Host installs:*

```sh
hx-fortress ui sso off          # stop advertising the console URL
                                # wait for the next tunnel reconnect
                                # VERIFY the workbench button is gone
hx-fortress ui --uninstall-service
                                # then downgrade the binary
```

*Containers:*

```sh
# via railway ssh / docker exec
hx-fortress ui sso off
# REDEPLOY — that is the reconnect gesture here
#   verify the workbench button is gone
#   then revert the image tag
```

On a container `hx-fortress ui disable` refuses while `FORTRESS_UI_ENABLE` is
set, and `systemctl` / `launchctl` mean nothing there. Unsetting the variable and
redeploying is the equivalent act.

**Before upgrading a container, check how it is started.** The image's
`ENTRYPOINT` is now `hx-fortress container-run`, and it REFUSES unless it is
pid 1 — it is what receives the runtime's SIGTERM and what orphans are
re-parented to, and started under an init wrapper it can do neither. So a
deployment that runs the image with `docker run --init`, with a shell wrapper,
or with its own `entrypoint:` override will come up refusing on the first boot
after the upgrade. Drop the wrapper, or run `hx-fortress host` directly as the
entrypoint and supervise the console yourself.

## The untrusted window

An older binary re-grants the daemon's write role full DML on its first boot,
through the blanket schema grant it issues before it knows better. So for as long
as a downgraded binary was running, five tables were writable by a role that
should not have reached them: `hx.admin_audit`, `hx.console_commands`,
`hx.audit_acks`, `hx.audit_settings` and `hx.ingest_control`.

The fifth is the one that is easy to miss. A blanket re-grant restores `DELETE`
on `hx.ingest_control`, and delete-then-reinsert mints a fresh pause anchor —
which is exactly the unbounded pause the clamp exists to bound.

A command row planted in that window is rejected by the boot fence of the binary
that comes back — it is never executed. The rows written in the window are still
there.

After re-upgrading, reconcile the acknowledgements:

```sh
hx-fortress audit acks reconcile
hx-fortress audit acks reconcile --re-confirm
```

It compares against the **on-disk spool only**. `hx.admin_audit` is itself
writable inside the window, so it cannot be its own witness. Acknowledgements the
spool no longer covers are re-confirmed through the fenced routine, which puts
them back in a trail that a database role cannot forge.

## Standing rules

- **Never trust `gh run watch`'s exit code.** A deploy job goes red on a log
  stream that failed while the build rolls out normally minutes later. Confirm
  with `pnpm devops <env> status` or the environment's version endpoint, and cut
  a missing tag-release by hand.
- **Dispatch tags, not branches.** `workflow_dispatch` runs and builds the
  workflow file at the ref it was dispatched on.
- **One version, one push.** The rolling step recreates the release and
  force-moves `builds/hx-fortress-<version>` every time it runs.
