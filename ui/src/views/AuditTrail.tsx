import React from "react";

import { API, api, downloadFromServer, type AuditRow } from "../api";
import { Empty, Loaded, Panel } from "../components";
import * as fmt from "../format";
import { useResource } from "../hooks";

// The admin audit trail.
//
// The markup is here and complete; nothing mounts it yet. The rows it renders
// are drained into hx.admin_audit from the daemon's 0600 spool, and that drain
// does not exist on this build — so a panel mounted now would render an empty
// trail on a fortress that has been recording all along, which is the one thing
// an audit surface must never do. The task that builds the drain mounts it.

export function AuditTrailPanel({ active }: { active: boolean }): React.ReactElement {
  const rows = useResource(() => api.audit({ limit: "100" }), [], { pollMs: 30_000, active });
  return (
    <Panel
      title="Admin audit trail"
      sub="Every state-changing action taken in this console, and every copy of fortress data that left it. Bounded reads of this panel are not themselves recorded; the full-range export is."
    >
      <Loaded
        resource={rows}
        emptyWhen={(data) => data.rows.length === 0}
        empty={<Empty>Nothing has been recorded on this fortress yet.</Empty>}
      >
        {(data) => (
          <>
            <div className="rowlist ops">
              {data.rows.map((row) => (
                <AuditLine key={row.id} row={row} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
              <button
                className="btn ghost"
                onClick={() => void downloadFromServer(API.auditExport, "hx-fortress-audit.jsonl")}
              >
                Export the trail
              </button>
            </div>
          </>
        )}
      </Loaded>
    </Panel>
  );
}

function AuditLine({ row }: { row: AuditRow }): React.ReactElement {
  return (
    <div className="row">
      <span className={row.error ? "dot bad" : row.kind === "intent" ? "dot warn" : "dot"}></span>
      <div className="who">
        <b>{row.action}</b>
        <div className="sub">
          {row.actor ?? row.origin}
          {row.outcome ? ` · ${row.outcome}` : ""}
          {row.error ? ` · ${row.error}` : ""}
        </div>
      </div>
      <div>
        <span className={`pill pc ${row.kind === "intent" ? "warn" : "ok"}`}>{row.kind}</span>
      </div>
      <div className="m">{fmt.when(row.ts)}</div>
    </div>
  );
}
