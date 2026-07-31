// The read port, over the things that actually hold the answers: the console's
// own Postgres handle, the daemon's 0600 runtime files, the resolved
// configuration and the object store.
//
// It is separated from the handlers so the handlers can be tested without any of
// it, and so the DEGRADED paths live in one place. Every method here answers
// even when its source is missing - a null, an empty list, an honest
// "unavailable" - because the console's whole job on a broken fortress is to say
// what is broken, and an endpoint that throws when Postgres is down is an
// endpoint that renders a blank page at exactly the moment somebody needs it.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { readSpool } from "../console/audit-spool";
import type { MetricsSnapshot } from "../console/metrics";
import {
  postureFreshness,
  postureQualification,
  RoutingPostureCache,
} from "../cloud/fortress-query";
import type { CloudCredential } from "../cloud/credentials";
import { daemonState, DAEMON_STATE_COPY, compareRoots } from "../daemon-state";
import type { HxDb } from "../host/postgres/db";
import type { fortressPaths } from "../host/paths";
import type { HostStatusSnapshot } from "../host/types";
import { readLastLines, rotateKeepFromEnv } from "../log-tail";
import { BUCKET_CONFIG_UNAVAILABLE, type SessionStore } from "../modules/session-vault/store/types";
import {
  auditExportQuery,
  auditPageQuery,
  auditPageLimit,
  AUDIT_EXPORT_MAX,
  commandsQuery,
  drainedOutcomesQuery,
  encodeAuditCursor,
  type AuditRow,
  type CommandRowView,
} from "../query/console/audit";
import {
  consoleDevicesQuery,
  consoleEmbeddingFactsQuery,
  consoleGrowthQuery,
  consolePeopleQuery,
  consolePostgresFactsQuery,
  type ConsoleDeviceRow,
  type ConsoleEmbeddingFacts,
  type ConsoleGrowthRow,
  type ConsolePersonRow,
  type ConsolePostgresFacts,
} from "../query/console/inventory";
import {
  consolePageLimit,
  consoleSessionTotalsQuery,
  consoleSessionsQuery,
  encodeConsoleCursor,
  type ConsoleSessionRow,
  type ConsoleSessionTotals,
} from "../query/console/sessions";
import {
  foreignOrgCountQuery,
  foreignOrgLabel,
  type ConsoleUniverse,
  type ForeignOrgSummary,
} from "../query/console/universe";
import { parseCommandOutcomes, type CommandOutcomeRecord } from "./corroboration";
import { externalContainmentBanner, type ConsoleDbState } from "./console-db";
import { dataPathRows, EGRESS_TITLE, type EgressInputs } from "./egress";
import type { EventStreamRegistry, EventProducer, OpenStreamVerdict } from "./events";
import { readIdentityFacts, type IdentityFacts } from "./identity";
import type {
  ConsoleFactsView,
  ConsoleReadPort,
  ConsoleStatusView,
  ExportRange,
  PostureView,
} from "./read-routes";
import type { ReportPayload } from "./report";
import { fetchRemoteFortressVersion, type RemoteVersion } from "./version-check";
import { FORTRESS_VERSION } from "../version";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** Rows out of a Bun.SQL result, whichever shape the driver hands back. */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface ConsoleReadPortDeps {
  paths: FortressPaths;
  universe: ConsoleUniverse;
  /** Absent when the database is not reachable; every method degrades. */
  db: () => HxDb | null;
  database: () => ConsoleDbState;
  /** The daemon's published snapshot, or null. */
  status: () => Promise<HostStatusSnapshot | null>;
  service: () => Promise<{ loaded: boolean; pid: number | null }>;
  credentials: () => Promise<CloudCredential | null>;
  egress: () => Promise<EgressInputs>;
  /** The vault store, when one is configured. Bucket facts degrade without it. */
  store: () => SessionStore | null;
  bucket: () => { provider: string; name: string; region: string | null } | null;
  streams: EventStreamRegistry;
  /** What an opened stream carries. */
  producer: EventProducer;
  downloadBase: () => string | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** The verifier's last measured clock offset, when it has measured one. Absent
 *  is the common case and renders nothing - a warning that is always on is a
 *  warning nobody reads. */
interface ClockSkewFile {
  offsetSeconds: number;
  allowedSeconds: number;
  measuredAt: string;
}

export function createConsoleReadPort(deps: ConsoleReadPortDeps): ConsoleReadPort {
  const now = deps.now ?? ((): Date => new Date());
  const env = deps.env ?? process.env;
  const postureCache = new RoutingPostureCache(path.join(deps.paths.runtimeRoot, "routing-posture.json"));

  const query = async <T>(build: () => unknown): Promise<T[]> => {
    const db = deps.db();
    if (!db) return [];
    return rows<T>(await db.execute(build() as never));
  };

  const bucketFacts = async (): Promise<{ versioning: string; lifecycle: string }> => {
    const store = deps.store();
    if (!store) {
      return { versioning: BUCKET_CONFIG_UNAVAILABLE, lifecycle: BUCKET_CONFIG_UNAVAILABLE };
    }
    const [versioning, lifecycle] = await Promise.all([
      store.getBucketVersioning().catch(() => BUCKET_CONFIG_UNAVAILABLE),
      store.getLifecycle().catch(() => BUCKET_CONFIG_UNAVAILABLE),
    ]);
    return { versioning, lifecycle };
  };

  const totals = async (): Promise<ConsoleSessionTotals> => {
    const [row] = await query<ConsoleSessionTotals>(() => consoleSessionTotalsQuery(deps.universe));
    return (
      row ?? { sessions: 0, people: 0, bytes: 0, tunnel: 0, gateway: 0, unknownProvenance: 0 }
    );
  };

  const foreign = async (): Promise<ForeignOrgSummary> => {
    const [row] = await query<{ sessions: number }>(() => foreignOrgCountQuery(deps.universe));
    const count = row?.sessions ?? 0;
    return { sessions: count, label: foreignOrgLabel(count) };
  };

  const posture = async (): Promise<PostureView> => {
    const snapshot = await postureCache.read();
    const at = now().getTime();
    const state = postureFreshness(snapshot, at);
    const data = snapshot?.data;
    const view: PostureView = {
      state,
      asOf: snapshot?.fetchedAt ?? null,
      cloudOnlySessions: data?.cloudOnlySessions ?? null,
      routedHere: data?.routedHere ?? null,
      qualification: postureQualification(snapshot, data?.cloudOnlySessions ?? 0, at),
    };
    const skew = await readJsonFile<ClockSkewFile>(path.join(deps.paths.runtimeRoot, "clock-skew.json"));
    if (skew && Math.abs(skew.offsetSeconds) > skew.allowedSeconds) {
      view.clockSkew = {
        offsetSeconds: skew.offsetSeconds,
        allowedSeconds: skew.allowedSeconds,
        remediation:
          "This host's clock is outside the allowed skew, which makes one-click entry from the " +
          "workbench fail with a clock_skew page. Enable NTP on this host (timedatectl set-ntp true), " +
          "then retry.",
      };
    }
    return view;
  };

  const identity = async (): Promise<IdentityFacts> => {
    const snapshot = await deps.status().catch(() => null);
    const database = deps.database();
    return readIdentityFacts({
      paths: deps.paths,
      credentials: await deps.credentials().catch(() => null),
      daemonRoot: snapshot?.host.root ?? null,
      postgresMode: database.kind === "ready" ? database.mode : "unknown",
      env,
    });
  };

  return {
    async status(): Promise<ConsoleStatusView> {
      const [snapshot, service] = await Promise.all([
        deps.status().catch(() => null),
        deps.service().catch(() => ({ loaded: false, pid: null })),
      ]);
      const state = daemonState({ service, snapshot, now: now() });
      const database = deps.database();
      const view: ConsoleStatusView = {
        daemon: state,
        copy: DAEMON_STATE_COPY[state],
        pid: snapshot?.host.pid ?? null,
        writtenAt: snapshot?.host.writtenAt ?? null,
        rootMatch: await compareRoots(deps.paths.root, snapshot?.host.root),
        database,
      };
      if (database.kind === "ready" && database.mode === "external") {
        view.externalBanner = externalContainmentBanner();
      }
      return view;
    },

    async sessions(params) {
      const limit = consolePageLimit(Number(params.get("limit") ?? undefined));
      const input = {
        universe: deps.universe,
        limit,
        ...pick(params, "search", "family", "userExternalId", "from", "to", "cursor"),
      };
      const found = await query<ConsoleSessionRow>(() => consoleSessionsQuery(input));
      const hasMore = found.length > limit;
      const page = hasMore ? found.slice(0, limit) : found;
      const last = page[page.length - 1];
      const [t, f] = await Promise.all([totals(), foreign()]);
      return {
        rows: page,
        ...(hasMore && last
          ? { nextCursor: encodeConsoleCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) }
          : {}),
        totals: t,
        foreign: f,
      };
    },

    people: () => query<ConsolePersonRow>(() => consolePeopleQuery(deps.universe)),
    devices: () => query<ConsoleDeviceRow>(() => consoleDevicesQuery()),
    growth: (days) => query<ConsoleGrowthRow>(() => consoleGrowthQuery(deps.universe, days)),

    async facts(): Promise<ConsoleFactsView> {
      const [pg] = await query<ConsolePostgresFacts>(() => consolePostgresFactsQuery(deps.universe));
      const [embeddings] = await query<ConsoleEmbeddingFacts>(() => consoleEmbeddingFactsQuery());
      const bucket = deps.bucket();
      const facts = await bucketFacts();
      return {
        postgres: pg ?? null,
        embeddings: embeddings ?? null,
        storage: {
          provider: bucket?.provider ?? null,
          bucket: bucket?.name ?? null,
          region: bucket?.region ?? null,
          ...facts,
        },
      };
    },

    identity,

    async metrics(): Promise<MetricsSnapshot | null> {
      return readJsonFile<MetricsSnapshot>(deps.paths.metrics);
    },

    async dataPaths() {
      return { title: EGRESS_TITLE, rows: dataPathRows(await deps.egress()) };
    },

    async version(): Promise<RemoteVersion> {
      const base = deps.downloadBase();
      if (!base) {
        return {
          kind: "unavailable",
          reason: "this fortress is not enrolled, so it has no release origin to ask",
          checkedAt: now().toISOString(),
          cached: false,
        };
      }
      return fetchRemoteFortressVersion(base);
    },

    async commands() {
      const rowsOut = await query<CommandRowView>(() => commandsQuery());
      const ids = rowsOut.map((r) => r.id);
      // Tail FIRST, table second. Both feed one ANY-MATCH predicate, so a
      // command corroborated before the drain still reads confirmed once its
      // spool file has been reclaimed.
      const tail = parseCommandOutcomes(
        (await readSpool(deps.paths.auditSpool).catch(() => [])).map((r) => ({
          action: r.action,
          kind: r.kind,
          sessionRef: r.sessionRef,
          params: r.params,
        })),
      );
      const drained = parseCommandOutcomes(
        await query<{ sessionRef: string | null; action: string; kind: string; params: unknown }>(() =>
          drainedOutcomesQuery(ids),
        ),
      );
      const database = deps.database();
      const records: CommandOutcomeRecord[] = [...tail, ...drained];
      return {
        rows: rowsOut,
        records,
        externalPostgres: database.kind === "ready" && database.mode === "external",
      };
    },

    async audit(range) {
      const limit = auditPageLimit(range.limit);
      const found = await query<AuditRow>(() => auditPageQuery({ ...range, limit }));
      const hasMore = found.length > limit;
      const page = hasMore ? found.slice(0, limit) : found;
      const last = page[page.length - 1];
      return hasMore && last
        ? { rows: page, nextCursor: encodeAuditCursor({ ts: last.ts, id: last.id }) }
        : { rows: page };
    },

    async auditExport(range) {
      const found = await query<AuditRow>(() => auditExportQuery(range));
      return found.length > AUDIT_EXPORT_MAX
        ? { rows: [], truncated: true }
        : { rows: found, truncated: false };
    },

    async spoolTail(limit) {
      const records = await readSpool(deps.paths.auditSpool).catch(() => []);
      return records.slice(-limit);
    },

    posture,

    async logsExport(range: ExportRange & { lines?: number }) {
      const lines = await readLastLines(
        deps.paths.log,
        range.lines ?? 5_000,
        rotateKeepFromEnv(env),
      );
      const kept = filterLogLines(lines, range);
      return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
    },

    async report(): Promise<ReportPayload> {
      const [facts, t, f, p, id] = await Promise.all([
        bucketFacts(),
        totals(),
        foreign(),
        posture(),
        identity(),
      ]);
      const bucket = deps.bucket();
      return {
        generatedAt: now().toISOString(),
        version: FORTRESS_VERSION,
        identity: id,
        totals: t,
        foreign: f,
        storage: {
          provider: bucket?.provider ?? null,
          bucket: bucket?.name ?? null,
          region: bucket?.region ?? null,
          ...facts,
        },
        posture: {
          state: p.state,
          asOf: p.asOf,
          cloudOnlySessions: p.cloudOnlySessions,
          routedHere: p.routedHere,
          qualification: p.qualification,
        },
        dataPaths: dataPathRows(await deps.egress()),
      };
    },

    openEvents(args): OpenStreamVerdict {
      return deps.streams.open({
        sessionId: args.sessionId,
        userLogin: args.userLogin,
        lastEventId: args.lastEventId,
        producer: deps.producer,
      });
    },
  };
}

function pick(params: URLSearchParams, ...keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Range and filter, applied SERVER-side.
 *
 * The client-side download this replaced pulled the whole log into a tab and
 * sliced it there - a memory problem on a large file, and an export nothing
 * recorded. Exported so the filtering can be asserted without a log file, since
 * "the server enforced it" is the property, not "the endpoint returned bytes".
 *
 * A line that does not parse as a record is kept only when no filter was asked
 * for. Dropping it under a filter is the safe direction: an unparseable line
 * cannot be shown to satisfy a module or a range, and including it would let a
 * filtered export carry records the filter excluded.
 */
export function filterLogLines(
  lines: readonly string[],
  range: ExportRange,
): string[] {
  const from = range.from ? Date.parse(range.from) : null;
  const to = range.to ? Date.parse(range.to) : null;
  const unfiltered = !range.module && !range.level && from === null && to === null;
  return lines.filter((line) => {
    const record = parseLine(line);
    if (!record) return unfiltered;
    if (range.module && record.module !== range.module) return false;
    if (range.level && record.level !== range.level) return false;
    const at = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
    if (from !== null && (!Number.isFinite(at) || at < from)) return false;
    if (to !== null && (!Number.isFinite(at) || at > to)) return false;
    return true;
  });
}

function parseLine(line: string): { module?: string; level?: string; ts?: string } | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as { module?: string; level?: string; ts?: string }) : null;
  } catch {
    return null;
  }
}
