import React from "react";

import { api } from "../api";
import {
  FactRow,
  Loaded,
  MutationControl,
  Panel,
  ResultLine,
  Stat,
  useConfirm,
  useResultLine,
} from "../components";
import { COMMAND_REQUEST_NOTE, NO_POLLER_REFUSAL } from "../../../src/ui/copy";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";
import { VerifyResidencyPanel } from "./Verify";

const POSTURE_COPY: Record<string, string> = {
  fresh: "Answered by let.ai, recently.",
  stale: "The last answer from let.ai is old enough that it may no longer describe today.",
  unavailable: "let.ai could not be asked, so this is what this host knows on its own.",
  "never-fetched": "let.ai has not been asked yet.",
};

/**
 * Where sessions rest, answered from the two things this host can actually see:
 * the channel each session arrived on, and whatever let.ai last said about
 * sessions it believes belong to this organization.
 *
 * There is no "verified" verdict here and no fleet walk. Proving a session's
 * bytes are where the row says they are means heading every object in the
 * bucket, and that engine is not this page's to fake — a green tick with nothing
 * behind it is worse than an honest count.
 */
export default function Residency(): React.ReactElement {
  const app = useApp();
  const active = app.view === "residency";
  const posture = useResource(() => api.posture(), [], { pollMs: 60_000, active });
  const page = useResource(() => api.sessions({ limit: "1" }), [], { pollMs: 30_000, active });

  const totals = page.data?.totals ?? null;

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Compliance</div>
      <h1>Residency</h1>
      <p className="lede">
        Every session below is on this host: its metadata row is in this fortress's own database and
        its transcript is in the organization's own bucket. What differs between them is how they
        got here, which is the fact that decides what can be proven about them.
      </p>

      <div className="stats">
        <Stat label="Sessions here" value={fmt.int(totals?.sessions)} sub={fmt.bytes(totals?.bytes)} />
        <Stat
          label="Relayed by let.ai"
          value={fmt.int(totals?.tunnel)}
          sub="cloud-relayed, so let.ai can be asked about them"
        />
        <Stat
          label="Direct to the gateway"
          value={fmt.int(totals?.gateway)}
          sub="never passed through let.ai at all"
        />
        <Stat
          label="Unknown provenance"
          value={fmt.int(totals?.unknownProvenance)}
          sub="recovered by the reconciler, or written before the channel was stamped"
        />
      </div>

      {page.data && page.data.foreign.sessions > 0 ? (
        <div className="banner info">
          <span className="badge">i</span>
          <span className="btxt">{page.data.foreign.label}</span>
        </div>
      ) : null}

      <Panel
        title="What let.ai says"
        sub="The routing posture, as this fortress last managed to read it."
      >
        <Loaded resource={posture}>
          {(data) => (
            <>
              <div className="facts wide">
                <FactRow
                  k="Answer"
                  v={data.state.split("-").join(" ")}
                  vs={POSTURE_COPY[data.state] ?? undefined}
                  tone={data.state === "fresh" ? "ok" : "warn"}
                />
                <FactRow k="As of" v={fmt.when(data.asOf)} vs={fmt.ago(data.asOf)} />
                <FactRow
                  k="Held only by let.ai"
                  v={fmt.int(data.cloudOnlySessions)}
                  vs="sessions let.ai believes belong here and this host has never received"
                />
                <FactRow
                  k="Routed here"
                  v={fmt.int(data.routedHere)}
                  vs="sessions let.ai says it delivered to this fortress"
                />
              </div>
              <div className="why-note" style={{ marginTop: 14 }}>
                {data.qualification}
              </div>
            </>
          )}
        </Loaded>
      </Panel>

      <AuditPanel daemonRunning={posture.data !== null} />

      {page.data?.rows[0] ? (
        <VerifyResidencyPanel
          family={page.data.rows[0].family}
          sessionId={page.data.rows[0].sessionId}
          sub="A spot check against the most recent session here. Every session's own page carries the same control."
        />
      ) : null}

      <Panel
        title="Why provenance decides what can be proven"
        sub="The three channels, and what each one leaves behind."
      >
        <div className="rowlist ops">
          <div className="row">
            <span className="dot"></span>
            <div className="who">
              <b>Relayed by let.ai</b>
              <div className="sub">
                let.ai forwarded the transcript it already held, so its own index names the session
                and can be asked whether a copy remained.
              </div>
            </div>
            <div>
              <span className="pill ok pc">Provable both ways</span>
            </div>
            <div className="m">tunnel</div>
          </div>
          <div className="row">
            <span className="dot"></span>
            <div className="who">
              <b>Direct to the gateway</b>
              <div className="sub">
                The client posted straight to this host. let.ai never saw the session, so it has
                nothing to be asked about — the absence is the property, not a gap.
              </div>
            </div>
            <div>
              <span className="pill fortress pc">Local only</span>
            </div>
            <div className="m">gateway</div>
          </div>
          <div className="row">
            <span className="dot warn"></span>
            <div className="who">
              <b>Unknown provenance</b>
              <div className="sub">
                Recovered by the reconciler after an outage, or written by a build that predates the
                channel column. The route is not recorded, and inventing one would be a claim
                nothing supports.
              </div>
            </div>
            <div>
              <span className="pill warn pc">Not asked</span>
            </div>
            <div className="m">reconciled</div>
          </div>
        </div>
      </Panel>
    </section>
  );
}

/**
 * The audit itself, asked for from here.
 *
 * Two controls, and the second one is an EGRESS switch: with the witness on,
 * the session ids of cloud-relayed sessions are sent to let.ai so it can say
 * whether it still holds a copy. With it off nothing leaves the box and every
 * eligible session reports the witness as unavailable — which is a different
 * answer from "let.ai holds no copy", and the run says so.
 */
function AuditPanel(props: { daemonRunning: boolean }): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const reason = props.daemonRunning ? undefined : NO_POLLER_REFUSAL;

  const submit = async (
    kind: string,
    params: Record<string, unknown>,
    confirm: { title: string; body: string; confirmLabel: string; danger?: boolean },
    done: string,
  ): Promise<void> => {
    if (!(await ask(confirm))) return;
    setBusy(true);
    try {
      await api.submitCommand(kind, params);
      showResult(done);
    } catch (error) {
      showResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Run the audit"
      sub="The daemon lists the bucket, checks every session this fortress claims against what is actually there, and records a run you can come back to."
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Residency audit"
          v="On demand"
          vs={COMMAND_REQUEST_NOTE}
          action={
            <MutationControl
              label="Run audit"
              small
              disabled={busy || reason !== undefined}
              {...(reason ? { reason } : {})}
              onClick={() =>
                void submit(
                  "run_audit",
                  { scope: "console" },
                  {
                    title: "Run the residency audit?",
                    body: "The daemon lists this organization's bucket and checks every session against it. Large fortresses take a while; the run is paced so it cannot become an outage.",
                    confirmLabel: "Run it",
                  },
                  "Asked the daemon to run it. Its verdict appears under Commands.",
                )
              }
            />
          }
        />
        <FactRow
          k="Ask let.ai"
          v="Cloud witness"
          vs="With it on, the ids of cloud-relayed sessions are sent to let.ai during a run. With it off nothing leaves this host, and every eligible session reports the witness as unavailable."
          action={
            <span style={{ display: "inline-flex", gap: 8 }}>
              <MutationControl
                label="Turn on"
                small
                disabled={busy || reason !== undefined}
                {...(reason ? { reason } : {})}
                onClick={() =>
                  void submit(
                    "witness_toggle",
                    { enabled: true },
                    {
                      title: "Send session ids to let.ai during an audit?",
                      body: "Only for sessions that reached this fortress THROUGH let.ai — it has already seen those ids. Nothing else is sent, and no transcript ever is.",
                      confirmLabel: "Turn it on",
                    },
                    "Asked the daemon to turn the cloud witness on.",
                  )
                }
              />
              <MutationControl
                label="Turn off"
                small
                danger
                disabled={busy || reason !== undefined}
                {...(reason ? { reason } : {})}
                onClick={() =>
                  void submit(
                    "witness_toggle",
                    { enabled: false },
                    {
                      title: "Stop asking let.ai?",
                      body: "No session id leaves this host from then on. Every eligible session will report the witness as unavailable, which is not the same as let.ai reporting no copy — and the run will say so.",
                      confirmLabel: "Turn it off",
                      danger: true,
                    },
                    "Asked the daemon to turn the cloud witness off.",
                  )
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
