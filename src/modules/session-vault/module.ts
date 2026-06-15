// session-vault Fortress module — implements the Module interface so the
// Fortress host routes MsgData payloads here. The store (S3/GCS) is built
// from credentials.json on init. Transport is owned by Fortress (T6).

import { handleVaultRpc, type VaultRpcRequest } from "./store/rpc.js";
import type { SessionStore } from "./store/types.js";
import { readVaultCredentials } from "./credentials.js";
import { buildStore } from "./store.js";
import type { Module, ModuleContext } from "../../host/types.js";

export default function createModule(): Module {
  let store: SessionStore | null = null;

  return {
    id: "session-vault",

    async init(context: ModuleContext): Promise<void> {
      const creds = await readVaultCredentials();
      if (!creds) {
        throw new Error("session-vault: no credentials.json — run the enroll wizard first");
      }
      store = buildStore(creds);
      context.logger.info("store initialized", { kind: creds.store, bucket: creds.bucket });
    },

    async onMessage(data) {
      if (!store) {
        return { ok: false, error: "session-vault: store not initialized" };
      }
      const req = data.payload as VaultRpcRequest;
      try {
        const result = await handleVaultRpc(store, req);
        return { ok: true, payload: result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}
