import React from "react";

import { helpEntries } from "../../../src/ui/help";
import {
  COMMAND_REQUEST_NOTE,
  CONTAINER_SERVICE_REFUSAL,
  NO_POLLER_REFUSAL,
} from "../../../src/ui/copy";
import { api, ApiError, NO_ANSWER, type CommandView, type StatusView } from "../api";
import {
  Empty,
  FactRow,
  Loaded,
  MutationControl,
  Panel,
  ResultLine,
  useConfirm,
  useResultLine,
} from "../components";
import { COMMAND_SURFACE_NOTE, OPS_SESSION_LINE, opsLede } from "../copy";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";

const CORROBORATION_PILL: Record<string, { label: string; tone: string }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  awaiting: { label: "Awaiting corroboration", tone: "fortress" },
  "reported-unconfirmed": { label: "Reported (unconfirmed)", tone: "warn" },
  disputed: { label: "Disputed", tone: "danger" },
};

export default function Ops(): React.ReactElement {
  const app = useApp();
  const active = app.view === "ops";
  const status = useResource(() => api.status(), [], { pollMs: 10_000, active });
  const identity = useResource(() => api.identity(), [], { pollMs: 60_000, active });
  const version = useResource(() => api.version(), [], { pollMs: 300_000, active });
  const commands = useResource(() => api.commands(), [], { pollMs: 10_000, active });

  const principal = app.auth.kind === "signed-in" ? app.auth.principal : null;
  const container = status.data?.serviceManager === "container";

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">System</div>
      <h1>Operate the fortress</h1>
      <p className="lede">{opsLede(container)}</p>

      <Panel title="This install">
        <Loaded resource={identity}>
          {(data) => (
            <div className="facts wide">
              <FactRow
                k="Enrollment"
                v={data.boundOrgId ? "Enrolled" : "Not enrolled"}
                vs={
                  data.boundOrgId
                    ? `bound to ${data.boundOrgId} — one fortress, one organization`
                    : "run `hx-fortress enroll` with a token from your organization"
                }
                tone={data.boundOrgId ? "ok" : "warn"}
              />
              <FactRow
                k="Fortress id"
                v={<span className="mono">{data.fortressId ?? "—"}</span>}
                vs={
                  data.credentialWrittenAt
                    ? `credential written ${fmt.when(data.credentialWrittenAt)}`
                    : "no credential on this host"
                }
              />
              <FactRow
                k="Fortress root"
                v={<span className="mono">{data.root}</span>}
                vs={
                  data.rootMatch === "same"
                    ? "the daemon reads the same directory"
                    : data.rootMatch === "different"
                      ? `the daemon published ${data.daemonRoot ?? "another root"}`
                      : "the daemon has not published a root, so this cannot be compared"
                }
                tone={data.rootMatch === "different" ? "warn" : undefined}
              />
              <FactRow
                k="Service"
                v={status.data?.serviceManager ?? "—"}
                vs={
                  container
                    ? "your orchestrator starts, stops and updates this fortress"
                    : "the daemon runs under this host's service manager"
                }
              />
            </div>
          )}
        </Loaded>
      </Panel>

      <ServicePanel
        status={status.data}
        container={container}
        onChanged={() => {
          status.reload();
          commands.reload();
        }}
      />

      <Panel title="Version">
        <Loaded resource={version}>
          {(remote) => (
            <div className="facts wide">
              <FactRow
                k="Running"
                v={<span className="mono">{status.data?.version ?? "—"}</span>}
                vs={
                  remote.kind === "available"
                    ? remote.version === status.data?.version
                      ? "which is the latest release"
                      : `latest release: ${remote.version}`
                    : `latest release: not checked — ${remote.reason}`
                }
                tone={
                  remote.kind === "available" && remote.version !== status.data?.version
                    ? "warn"
                    : undefined
                }
              />
              <FactRow
                k="Checked"
                v={fmt.ago(remote.checkedAt)}
                vs={remote.cached ? "from this console's cache" : "asked just now"}
              />
              <UpdateRow
                container={container}
                daemon={status.data?.daemon ?? null}
                available={
                  remote.kind === "available" && remote.version !== status.data?.version
                    ? remote.version
                    : null
                }
                onSubmitted={() => commands.reload()}
              />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Commands"
        sub="Work the console asked the daemon to do, and whether the daemon's own record agrees that it did it."
        panelKey="commands"
        register={app.registerPanel}
      >
        <Loaded
          resource={commands}
          emptyWhen={(data) => data.commands.length === 0}
          empty={<Empty>Nothing has been asked of the daemon from this console.</Empty>}
        >
          {(data) => (
            <div className="rowlist ops">
              {data.commands.map((command) => (
                <CommandLine key={command.id} command={command} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="This sign-in" sub={OPS_SESSION_LINE}>
        <div className="facts wide">
          <FactRow
            k="Signed in as"
            v={principal?.login ?? "—"}
            vs={
              principal?.role === "operator"
                ? "operator — full read, and every control this console has"
                : "read-only — every view, no controls"
            }
          />
          <FactRow
            k="Since"
            v={fmt.when(principal?.createdAt ?? null)}
            vs={app.sessionBudgets ?? "held per browser tab — a second tab signs in again"}
          />
          {principal?.workbenchSub ? (
            <FactRow
              k="Arrived as"
              v={<span className="mono">{principal.workbenchSub}</span>}
              vs="the workbench identity recorded alongside what this session does"
            />
          ) : null}
          <FactRow
            k="End it"
            v="Sign out"
            vs="ends this tab's session on the fortress; other tabs and other people are untouched"
            action={
              <button className="btn ghost sm" onClick={() => void app.signOut()}>
                Sign out
              </button>
            }
          />
        </div>
      </Panel>

      <Panel title="Command line" sub={COMMAND_SURFACE_NOTE} panelKey="cli" register={app.registerPanel}>
        {helpEntries().map((entry) => (
          <div className="clirow" key={entry.usage}>
            <span className="c">{entry.usage}</span>
            <span className="d">{entry.summary}</span>
          </div>
        ))}
      </Panel>
    </section>
  );
}

function CommandLine({ command }: { command: CommandView }): React.ReactElement {
  const pill = CORROBORATION_PILL[command.corroboration.state] ?? {
    label: command.corroboration.state,
    tone: "warn",
  };
  const disputed = command.corroboration.state === "disputed";
  return (
    <div className="row" style={{ alignItems: "start" }}>
      <span className={disputed ? "dot bad" : command.status === "done" ? "dot" : "dot warn"}></span>
      <div className="who">
        <b>{command.kind}</b>
        <div className="sub">
          {command.status}
          {command.requestedBy ? ` · asked by ${command.requestedBy}` : ""}
          {command.outcome ? ` · ${command.outcome}` : ""}
          {command.error ? ` · ${command.error}` : ""}
        </div>
        {command.copy.length > 0 ? (
          <div className={disputed ? "why-note" : "sub"} style={{ marginTop: 8 }}>
            {command.copy.map((line, i) => (
              <p className="saidby" key={i}>
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        <span className={`pill pc ${pill.tone}`}>{pill.label}</span>
      </div>
      <div className="m">{fmt.ago(command.completedAt ?? command.requestedAt)}</div>
    </div>
  );
}

/**
 * The daemon's lifecycle, driven from the browser.
 *
 * Every action confirms, states what it does to THIS page as well as to the
 * fortress, and answers in place with the server's own sentence. A console that
 * stops the daemon keeps serving — that is the point of a separate process — and
 * the copy says so, because a page that went blank after Stop would read as a
 * crash.
 */
function ServicePanel(props: {
  status: StatusView | null;
  container: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const running = props.status?.pid !== null && props.status?.pid !== undefined;

  const drive = async (
    action: "start" | "stop" | "restart",
    confirm: { title: string; body: string; confirmLabel: string; danger?: boolean },
  ): Promise<void> => {
    if (!(await ask(confirm))) return;
    setBusy(true);
    try {
      const answer = await api.serviceAction(action);
      showResult(answer.copy);
    } catch (error) {
      showResult(
        error instanceof ApiError && error.status === NO_ANSWER
          ? "This console stopped answering. It is restarting; this page follows it."
          : error instanceof Error
            ? error.message
            : String(error),
        true,
      );
    } finally {
      setBusy(false);
      props.onChanged();
    }
  };

  return (
    <Panel
      title="Service"
      sub={
        props.container
          ? CONTAINER_SERVICE_REFUSAL
          : "Start, restart and stop the daemon. This console runs in its own process and keeps answering either way."
      }
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Daemon"
          v={props.status?.copy ?? "—"}
          vs={
            running
              ? `pid ${props.status?.pid}, under ${props.status?.serviceManager ?? "this host"}`
              : "nothing is running to answer for this fortress"
          }
          tone={running ? "ok" : "warn"}
          action={
            <span style={{ display: "inline-flex", gap: 8 }}>
              <MutationControl
                label="Start"
                small
                disabled={props.container || busy || running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("start", {
                    title: "Start the fortress?",
                    body: "The daemon comes up under this host's service manager and begins accepting uploads again.",
                    confirmLabel: "Start",
                  })
                }
              />
              <MutationControl
                label="Restart"
                small
                disabled={props.container || busy || !running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("restart", {
                    title: "Restart the fortress?",
                    body: "Uploads in flight fail and their senders retry. The unit is restarted exactly as installed — nothing about it is rewritten.",
                    confirmLabel: "Restart",
                  })
                }
              />
              <MutationControl
                label="Stop"
                small
                danger
                disabled={props.container || busy || !running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("stop", {
                    title: "Stop the fortress?",
                    body: "Uploads stop being accepted and the tunnel closes until it is started again. This console keeps answering, and every panel that needs the daemon will say it is stopped.",
                    confirmLabel: "Stop the fortress",
                    danger: true,
                  })
                }
              />
            </span>
          }
        />
      </div>
      <ResultLine state={result} />
    </Panel>
  );
}

/** Applying an update is host code execution, asked for from a browser. It is
 *  confirmed, it is recorded, and the daemon — not this page — reports what
 *  happened. */
function UpdateRow(props: {
  container: boolean;
  daemon: string | null;
  available: string | null;
  onSubmitted: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const noPoller = props.daemon !== "running";
  const reason = props.container
    ? CONTAINER_SERVICE_REFUSAL
    : noPoller
      ? NO_POLLER_REFUSAL
      : props.available === null
        ? "there is no newer release to install"
        : undefined;

  return (
    <>
      {dialog}
      <FactRow
        k="Update"
        v={props.available ? `${props.available} available` : "up to date"}
        vs={COMMAND_REQUEST_NOTE}
        action={
          <MutationControl
            label="Install update"
            small
            disabled={busy || reason !== undefined}
            {...(reason ? { reason } : {})}
            onClick={() => {
              void (async () => {
                const ok = await ask({
                  title: `Install ${props.available ?? "the latest release"}?`,
                  body: "The daemon downloads the release, verifies it, replaces its own binary and restarts. Uploads in flight fail and their senders retry.",
                  confirmLabel: "Install and restart",
                  danger: true,
                });
                if (!ok) return;
                setBusy(true);
                try {
                  await api.submitCommand("update_apply");
                  showResult("Asked the daemon to install it. Its answer appears under Commands.");
                } catch (error) {
                  showResult(error instanceof Error ? error.message : String(error), true);
                } finally {
                  setBusy(false);
                  props.onSubmitted();
                }
              })();
            }}
          />
        }
      />
      <ResultLine state={result} />
    </>
  );
}
