import React from "react";

import { api, type DeviceRow } from "../api";
import { Empty, FactRow, Loaded, Panel, Stat } from "../components";
import { DISCLOSURE_PEOPLE_NOTE } from "../disclosure";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";

// The roster — who the organization employs, which teams they sit in, and who
// has no client at all — arrives from let.ai and lands in a later phase. Until
// it does, this page answers the question it CAN answer honestly: who is sending
// to this fortress, from which machines. It does not show a coverage percentage,
// because a percentage needs a denominator this host does not have, and one
// invented from the people who already appear here would always read 100%.

export function People(): React.ReactElement {
  const app = useApp();
  const active = app.view === "people";
  const people = useResource(() => api.people(), [], { pollMs: 60_000, active });
  const devices = useResource(() => api.devices(), [], { pollMs: 60_000, active });

  const rows = people.data?.people ?? [];
  const deviceRows = devices.data?.devices ?? [];
  const outdated = deviceRows.filter((d) => d.lastSeenAt === null).length;

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Operate</div>
      <h1>People sending to this fortress</h1>
      <p className="lede">
        Everyone with at least one session on this host, and the machines those sessions came from.
      </p>

      <div className="stats">
        <Stat label="People" value={fmt.int(people.data ? rows.length : null)} sub="with sessions here" />
        <Stat label="Devices" value={fmt.int(devices.data ? deviceRows.length : null)} sub="registered against those people" />
        <Stat
          label="Never seen"
          value={fmt.int(devices.data ? outdated : null)}
          sub="devices registered but never observed since"
        />
        <Stat
          label="Sessions"
          value={fmt.int(people.data ? rows.reduce((n, p) => n + p.sessions, 0) : null)}
          sub="summed over the people below"
        />
      </div>

      <Panel title="Who is sending" sub="Ordered by how much is here, not alphabetically.">
        <Loaded
          resource={people}
          emptyWhen={(data) => data.people.length === 0}
          empty={<Empty>Nobody has sent a session to this fortress yet.</Empty>}
        >
          {(data) => (
            <div className="rowlist ops">
              {data.people.map((person) => (
                <div
                  className="row linkrow"
                  key={person.userExternalId}
                  onClick={() => {
                    app.navigate({ view: "person-detail", personId: person.userExternalId });
                    window.scrollTo(0, 0);
                  }}
                >
                  <span className={person.sessions > 0 ? "dot" : "dot offd"}></span>
                  <div className="who">
                    <b>{person.displayName ?? person.userExternalId}</b>
                    <div className="sub">
                      <span className="mono">{person.userExternalId}</span> ·{" "}
                      {fmt.plural(person.devices, "device")}
                    </div>
                  </div>
                  <div className="m">{fmt.plural(person.sessions, "session")}</div>
                  <div className="m">{fmt.ago(person.lastActivityAt)}</div>
                </div>
              ))}
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Devices"
        sub="Device metadata reported by the hx client — names, platforms and liveness. Nothing on the device itself is readable from here."
      >
        <Loaded
          resource={devices}
          emptyWhen={(data) => data.devices.length === 0}
          empty={<Empty>No device has registered with this fortress.</Empty>}
        >
          {(data) => (
            <div className="rowlist ops">
              {data.devices.map((device) => (
                <DeviceLine key={`${device.userExternalId}/${device.deviceId}`} device={device} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>
    </section>
  );
}

function DeviceLine({ device }: { device: DeviceRow }): React.ReactElement {
  // A device that has never reported is a different fact from one reporting
  // zero, so the two are never collapsed: nulls stay dashes.
  const backlog =
    device.syncTotal === null || device.syncDone === null
      ? null
      : Math.max(0, device.syncTotal - device.syncDone);
  return (
    <div className="row">
      <span className={device.lastSeenAt ? "dot" : "dot offd"}></span>
      <div className="who">
        <b>{device.name ?? device.deviceId}</b>
        <div className="sub">
          {device.userExternalId}
          {device.os ? ` · ${device.os}` : ""}
          {device.arch ? ` ${device.arch}` : ""}
        </div>
      </div>
      <div className="m">
        {backlog === null ? "—" : backlog === 0 ? "in sync" : `${fmt.int(backlog)} queued`}
      </div>
      <div className="m">{fmt.ago(device.lastSeenAt)}</div>
    </div>
  );
}

export function PersonDetail(): React.ReactElement {
  const app = useApp();
  const active = app.view === "person-detail";
  const personId = app.route.personId ?? "";

  const people = useResource(() => api.people(), [], { active: active && personId !== "" });
  const devices = useResource(() => api.devices(), [], { active: active && personId !== "" });
  const sessions = useResource(
    () => api.sessions({ limit: "10", userExternalId: personId }),
    [personId],
    { active: active && personId !== "" },
  );

  const person = people.data?.people.find((p) => p.userExternalId === personId) ?? null;
  const mine = devices.data?.devices.filter((d) => d.userExternalId === personId) ?? [];

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">
        <a
          href="/people"
          onClick={(e) => {
            e.preventDefault();
            app.goto("people");
          }}
        >
          ← People
        </a>
      </div>
      <h1>{person?.displayName ?? personId}</h1>
      <p className="lede">
        {person
          ? `${fmt.plural(person.sessions, "session")} on this fortress · ${fmt.bytes(person.bytes)}`
          : people.loading
            ? "Reading the fortress…"
            : "Nobody with that id has sent a session to this fortress."}
      </p>

      {person ? (
        <>
          <div className="grid2">
            <Panel title="Footprint on this fortress">
              <div className="facts">
                <FactRow k="External id" v={<span className="mono">{person.userExternalId}</span>} />
                <FactRow k="Sessions" v={fmt.int(person.sessions)} />
                <FactRow k="Uploaded" v={fmt.bytes(person.bytes)} />
                <FactRow
                  k="Last activity"
                  v={fmt.when(person.lastActivityAt)}
                  vs={fmt.ago(person.lastActivityAt)}
                />
                <FactRow
                  k="Last upload"
                  v={fmt.when(person.lastUploadAt)}
                  vs={
                    person.lastUploadAt === null
                      ? "no device of theirs has reported an upload"
                      : fmt.ago(person.lastUploadAt)
                  }
                />
              </div>
            </Panel>

            <Panel title="Devices">
              {mine.length === 0 ? (
                <Empty>No device is registered to this person.</Empty>
              ) : (
                <div className="facts">
                  {mine.map((device) => (
                    <FactRow
                      key={device.deviceId}
                      k={device.name ?? device.deviceId}
                      v={device.os ? `${device.os} ${device.arch ?? ""}`.trim() : "platform not reported"}
                      vs={`last seen ${fmt.ago(device.lastSeenAt)}`}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Recent sessions here" sub={DISCLOSURE_PEOPLE_NOTE}>
            <Loaded
              resource={sessions}
              emptyWhen={(data) => data.rows.length === 0}
              empty={<Empty>Nothing of theirs is on this fortress.</Empty>}
            >
              {(data) => (
                <div className="rowlist ops">
                  {data.rows.map((row) => (
                    <div
                      className="row linkrow"
                      key={row.id}
                      onClick={() => {
                        app.navigate({ view: "session-detail", family: row.family, sid: row.sessionId });
                        window.scrollTo(0, 0);
                      }}
                    >
                      <span className="dot"></span>
                      <div className="who">
                        <b>{row.title ?? "untitled"}</b>
                        <div className="sub">
                          {row.family}
                          {row.repoSlug ? ` · ${row.repoSlug}` : ""}
                        </div>
                      </div>
                      <div className="m">{fmt.bytes(row.bytesUploaded)}</div>
                      <div className="m">{fmt.ago(row.lastActivityAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Loaded>
          </Panel>
        </>
      ) : null}
    </section>
  );
}
