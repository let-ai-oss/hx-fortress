// session-vault Fortress module — implements the Module interface so the
// Fortress host routes MsgData payloads here. The store (S3/GCS) is built
// from credentials.json on init. Transport and identity are owned by Fortress.

import { handleVaultRpc, type VaultAuthz, type VaultRpcRequest } from "./store/rpc.js";
import type { SessionStore } from "./store/types.js";
import { readVaultCredentials } from "./credentials.js";
import { buildStore } from "./store.js";
import type { HxDb } from "../../host/postgres/db.js";
import { sanitizeDbError } from "../../host/postgres/sanitize.js";
import type {
  HxIngestNotification,
  Module,
  ModuleContext,
  ScopedLogger,
} from "../../host/types.js";

/** The session_vault module plus a getter for its live store, so the ingest
 *  gateway can presign against the same store the tunnel RPCs already use. */
export interface SessionVaultModule extends Module {
  getStore(): SessionStore | null;
}

export interface SessionVaultDeps {
  /** Resolves the RW (DML) hx-db handle so tunnel-relayed commits can be mirrored
   *  into the fortress Postgres. Null until Postgres is ready. */
  db?: () => HxDb | null;
  /** Resolves the SELECT-only RO hx-db handle for the "my sessions" metadata read
   *  (least-privilege). Falls back to `db` when omitted. Null until Postgres ready. */
  dbRead?: () => HxDb | null;
  /** Push a realtime invalidation to the cloud after a tunnel-relayed ingest
   *  (MC-2415). Best-effort; omitted in tests. */
  notify?: (evt: HxIngestNotification) => void;
  /** Stop the embedded Postgres before a wedge-escalation exit — launchd has
   *  no cgroup kill, so a hard exit would orphan the daemonized postmaster and
   *  the restarted fortress boots Postgres-less. Bounded by the caller. */
  stopEmbeddedPostgres?: () => Promise<void>;
  /** Resolves the RW DSN for deleteSession's DEDICATED purge client (built
   *  param-free per invocation — no statement_timeout / maxLifetime — so an
   *  oversized purge keeps its zombie-convergence). Null until Postgres is
   *  ready ⇒ the RPC fails typed and the cloud PARKS the purge job. */
  purgeDsn?: () => string | null;
}

/** RPC methods that mutate the store — always log completion + duration. The
 *  2026-07-30 wedge was invisible precisely because a hung write handler and a
 *  healthy-but-quiet one produced identical (empty) logs. */
const WRITE_RPC_METHODS = new Set([
  "ingestCommit",
  "ingestAgentCommit",
  "appendChunkToCanonical",
  "writeArtifact",
  "deleteSession",
]);
/** Any RPC slower than this logs its duration, read or write. */
const SLOW_RPC_LOG_MS = 5_000;
/** Write-path self-test cadence (ms); FORTRESS_STORE_PROBE_INTERVAL_MS
 *  overrides, 0 disables. */
const PROBE_INTERVAL_MS = (() => {
  const raw = process.env.FORTRESS_STORE_PROBE_INTERVAL_MS;
  // Set-but-EMPTY means "default", never 0: only an explicit "0" may disable
  // the incident's core detection mechanism.
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

export default function createModule(deps: SessionVaultDeps = {}): SessionVaultModule {
  let store: SessionStore | null = null;
  let logger: ScopedLogger | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probeBusy = false;
  let probeFailing = false;

  return {
    id: "session_vault",

    getStore(): SessionStore | null {
      return store;
    },

    async init(context: ModuleContext): Promise<void> {
      logger = context.logger;
      const creds = await readVaultCredentials();
      if (!creds) {
        throw new Error("session-vault: no credentials.json — run the enroll wizard first");
      }
      store = buildStore(creds, context.logger, { beforeExit: deps.stopEmbeddedPostgres });

      const { fortressIdentity } = context;
      if (fortressIdentity) {
        context.logger.info("store initialized", {
          kind: creds.store,
          bucket: creds.bucket,
          orgId: fortressIdentity.orgId,
          fortressId: fortressIdentity.fortressId,
        });
      } else {
        context.logger.warn("store initialized without Fortress identity — not yet enrolled", {
          kind: creds.store,
          bucket: creds.bucket,
        });
      }

      // Write-path self-test. Process liveness kept a wedged storage pool
      // "healthy" for three hours on 2026-07-30: Postgres-backed reads stayed
      // green while every bucket write hung silently. Probe the real bucket on
      // an interval — a failure is loud here, and a hang counts as a deadline
      // breach inside GuardedStore, feeding its client rebuild.
      if (PROBE_INTERVAL_MS > 0) {
        probeTimer = setInterval(() => {
          if (probeBusy || !store) return;
          probeBusy = true;
          void store
            .selfTest()
            .then(() => {
              if (probeFailing) logger?.info("store write path recovered");
              probeFailing = false;
            })
            .catch((err: unknown) => {
              probeFailing = true;
              logger?.error("store write-path self-test failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              probeBusy = false;
            });
        }, PROBE_INTERVAL_MS);
        (probeTimer as { unref?: () => void }).unref?.();
      }
    },

    async stop(): Promise<void> {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
    },

    async onMessage(data) {
      if (!store) {
        return { ok: false, error: "session-vault: store not initialized" };
      }
      const req = data.payload as VaultRpcRequest;
      // The connection attaches the verified grant's authz alongside the payload
      // (H-4) — fortress-internal, never on the wire MsgData contract.
      const authz = (data as { authz?: VaultAuthz }).authz;
      const startedAt = Date.now();
      try {
        const result = await handleVaultRpc(
          store,
          req,
          deps.db ?? null,
          authz,
          deps.dbRead ?? null,
          logger ?? undefined,
          deps.purgeDsn ?? null,
        );
        const ms = Date.now() - startedAt;
        if (WRITE_RPC_METHODS.has(req.method) || ms >= SLOW_RPC_LOG_MS) {
          logger?.info("vault RPC ok", { method: req.method, ms });
        }
        // A relayed commit just changed this user's sessions — tell the cloud to
        // refresh their live list (MC-2415). Best-effort, after the write landed.
        if (req.method === "ingestCommit" || req.method === "ingestAgentCommit") {
          deps.notify?.({
            userExternalId: req.key.userId,
            orgExternalId: req.attribution.orgExternalId,
          });
        }
        return { ok: true, payload: result };
      } catch (err) {
        // The error string is logged AND returned to the cloud on the wire, so
        // redact any DSN a Postgres/driver error might have echoed (Low).
        const message = sanitizeDbError(err);
        logger?.error("vault RPC failed", {
          method: req.method,
          error: message,
          ms: Date.now() - startedAt,
        });
        return { ok: false, error: message };
      }
    },
  };
}
