import React from "react";

import { helpEntries } from "../../../src/ui/help";
import { api, type CommandView } from "../api";
import { Empty, FactRow, Loaded, Panel } from "../components";
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
