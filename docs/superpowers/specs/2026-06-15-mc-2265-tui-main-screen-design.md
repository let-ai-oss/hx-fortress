# MC-2265 TUI Main Screen Design

## Goal

When `hx-fortress` runs with no arguments, it should open a terminal UI that shows the main Fortress component table instead of printing help. The screen must reflect live host state, expose the same lifecycle operations as the CLI, and present future components honestly without dead or misleading affordances.

## Scope

In scope:

- No-args CLI entry to the TUI.
- Main screen table for `session_vault`, `session_computer`, and `devops-utility`.
- Live status derived from the running host plus installed-module metadata.
- Inline actions for Start, Stop, Update, and View Details.
- A main-screen navigation action for details selection.
- Tests for CLI dispatch, screen-model derivation, and action availability.

Out of scope:

- The details screen renderer and its uninstall flow. That remains MC-2266.
- New host lifecycle behavior. The TUI must call existing lifecycle/update code paths.
- New copy for future modules beyond the row labels and unavailable state.

## Current State

The repo already has:

- `start`, `stop`, and `status` CLI paths in `src/cli.ts` and `src/cli-lifecycle.ts`.
- A status snapshot persisted to `status.json` and read via `FileStatusReader`.
- Installed runtime-module metadata in `module-inventory.json`.
- Runtime module install/update behavior in `ModuleLoader`, where reinstalling an existing module replaces it with a new version.

What is missing is a TUI entrypoint, a screen model that merges runtime status with inventory/update metadata, and a stable representation for the future rows that are visible but not actionable.

## Recommended Approach

Build the TUI around a pure screen-model layer and keep the terminal renderer thin.

Why this approach:

- The existing CLI and host code already provide the side-effecting operations. The TUI should compose them, not reimplement them.
- A pure derivation layer makes the tricky parts testable without terminal mocking.
- The future details screen can reuse the same row model and navigation state later.

Alternatives considered:

1. Render directly from `status.json` inside the TUI.
   This is simpler short term, but it cannot express unavailable future rows or installed/update metadata cleanly.
2. Expand `status.json` until it contains every TUI field.
   This couples the host snapshot to a presentation concern and adds churn to runtime persistence without clear benefit for MC-2265.

## Design

### CLI behavior

- `runCli([])` will launch the TUI instead of printing help.
- `help` and `--help` continue to print the command list.
- The TUI will receive a small dependency bundle so tests can replace status, lifecycle, and rendering behavior.

### Screen model

Introduce a main-screen view-model builder that reads:

- service manager state
- host status snapshot
- installed module inventory
- available update metadata

It will always produce three rows in this order:

1. `session_vault`
2. `session_computer`
3. `devops-utility`

Each row will carry:

- `id`
- `label`
- `statusLabel`
- `availability`
- `installedVersion`
- `availableVersion`
- `actions`

`availability` rules:

- `session_vault`: live component, backed by real runtime/install data.
- `session_computer`: unavailable, inert.
- `devops-utility`: unavailable, inert.

`statusLabel` rules:

- Running host + module running: `running`
- Running host + module stopped/failed/starting/stopping: mapped from module state
- Service loaded but not running, stale snapshot, or no snapshot: `stopped` for `session_vault`
- Future rows: `unavailable`

### Actions

Main-screen actions are derived, not hard-coded:

- `Start`: only for `session_vault` when Fortress is not running.
- `Stop`: only for `session_vault` when Fortress is running.
- `Update to vN`: only when update metadata exists for that row.
- `View Details`: always present as a navigation action, but only the navigation state changes in MC-2265.

For unavailable future rows:

- No start/stop/update actions.
- `View Details` remains selectable only if it leads to a non-rendered navigation target managed by the TUI state machine. MC-2265 will not promise a rendered details page.

### Update metadata

MC-2265 should not invent a second update mechanism. The TUI will depend on an update-status provider that surfaces whether a component has a newer version available and, if so, which version label to show. The main screen only needs read access to that metadata and a callable action that delegates to the existing update path.

If the current repo has only the loader-level update plumbing and no higher-level update-status reader yet, MC-2265 should add the smallest shared interface needed for the TUI and CLI to consume the same source later. That interface belongs near CLI/TUI orchestration, not in the host status snapshot.

### Navigation

The TUI state machine will support:

- `main`
- `details`

MC-2265 implements only the transition out of `main` by recording the selected component as pending details navigation. The actual details rendering remains behind MC-2266.

Practically, this means the main screen code must not bake in assumptions that details are unavailable forever. It should emit a navigation event or next-state token that MC-2266 can attach to later.

### Copy

The main screen includes the note:

`Safe to exit HX Fortress. Components keep running in the background.`

Future rows use honest production copy:

- status `unavailable`
- no placeholder or roadmap language

## Error Handling

- If service state cannot be read, the TUI should surface a top-level error and exit non-zero rather than showing a fabricated table.
- If the status snapshot is missing or stale while the service is running, the table still renders with `session_vault` shown as stopped and without update/detail-derived version claims from runtime state.
- If inventory or update metadata cannot be read, the TUI still renders with version/update fields omitted and without crashing.
- Action failures surface as inline or top-level TUI errors, but they do not corrupt the row model.

## Testing

Add focused tests for:

- `runCli([])` dispatches into the TUI path.
- Help output still works for `help` and `--help`.
- Screen-model derivation for:
  - running Fortress with `session_vault` running
  - stopped Fortress
  - stale or missing snapshot
  - unavailable future rows
  - update-available state
- Action availability for Start, Stop, Update, and View Details.
- Navigation event/state emitted by selecting View Details.

Terminal rendering should stay lightly tested. Most coverage belongs in the pure model/state layer.

## Implementation Notes

- Prefer a new `src/tui/` area instead of mixing TUI state into `cli.ts`.
- Keep the first pass small: one main screen renderer, one model builder, one controller for actions/navigation.
- Reuse existing lifecycle functions wherever their side effects already match the CLI contract.
- Do not extend `status.json` unless implementation proves the existing snapshot plus inventory/update data is insufficient.

## Open Decisions Resolved For This Task

- `View Details` is present on the main screen because the ticket requires it.
- MC-2265 stops at navigation state and does not render the details page.
- `session_computer` and `devops-utility` are visible but inert, with `unavailable` status and no lifecycle/update actions.
