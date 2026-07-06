// session-vault Fortress module — implements the Module interface so the
// Fortress host routes MsgData payloads here. The store (S3/GCS) is built
// from credentials.json on init. Transport and identity are owned by Fortress.

import { handleVaultRpc, type VaultRpcRequest } from "./store/rpc.js";
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
  /** Resolves the hx-db handle so tunnel-relayed commits can be mirrored into
   *  the fortress Postgres. Null until Postgres is ready. */
  db?: () => HxDb | null;
  /** Push a realtime invalidation to the cloud after a tunnel-relayed ingest
   *  (MC-2415). Best-effort; omitted in tests. */
  notify?: (evt: HxIngestNotification) => void;
}

export default function createModule(deps: SessionVaultDeps = {}): SessionVaultModule {
  let store: SessionStore | null = null;
  let logger: ScopedLogger | null = null;

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
      store = buildStore(creds);

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
    },

    async onMessage(data) {
      if (!store) {
        return { ok: false, error: "session-vault: store not initialized" };
      }
      const req = data.payload as VaultRpcRequest;
      try {
        const result = await handleVaultRpc(store, req, deps.db?.() ?? null);
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
        logger?.error("vault RPC failed", { method: req.method, error: message });
        return { ok: false, error: message };
      }
    },
  };
}
