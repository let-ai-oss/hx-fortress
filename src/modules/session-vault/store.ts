// Build the concrete SessionStore the vault serves, from credentials.json. The
// store reads/writes the ORGANIZATION's bucket with the ORGANIZATION's
// credentials — inline in credentials.json, or (when a block is absent) the
// host's own ADC / instance role. let.ai never sees either.

import { createRequire } from "node:module";
import { GcsStore, type GcsStoreConfig } from "./store/gcs-store.js";
import { GuardedStore, type GuardedStoreOptions } from "./store/guarded-store.js";
import { S3Store } from "./store/s3-store.js";
import { assertS3EndpointSafe } from "./store/endpoint-safety.js";
import type { SessionStore } from "./store/types.js";
import type { VaultCredentials } from "./credentials.js";
import type { ScopedLogger } from "../../host/types.js";

/** Per-class deadline overrides for the guarded store (ms). A value above the
 *  cloud tunnel's 30s RPC window only helps direct-gateway callers — tunnel
 *  callers are still abandoned at 30s by the cloud. */
function deadlineEnvOverrides(): Pick<
  GuardedStoreOptions,
  "opTimeoutMs" | "heavyOpTimeoutMs" | "scanTimeoutMs"
> {
  const read = (raw: string | undefined): number | undefined => {
    const n = Number(raw ?? "");
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const out: Pick<GuardedStoreOptions, "opTimeoutMs" | "heavyOpTimeoutMs" | "scanTimeoutMs"> = {};
  const op = read(process.env.FORTRESS_STORE_OP_TIMEOUT_MS);
  if (op) out.opTimeoutMs = op;
  const heavy = read(process.env.FORTRESS_STORE_HEAVY_TIMEOUT_MS);
  if (heavy) out.heavyOpTimeoutMs = heavy;
  const scan = read(process.env.FORTRESS_STORE_SCAN_TIMEOUT_MS);
  if (scan) out.scanTimeoutMs = scan;
  return out;
}

// teeny-request (the GCS SDK's transport) keeps its keep-alive agents in a
// MODULE-GLOBAL pool shared by every Storage instance — rebuilding the client
// without evicting the pool hands the fresh client the exact poisoned sockets
// the rebuild exists to shed (the 2026-07-30 wedge). The pool is not exported
// from the package root, so reach into the module the SDK itself loads.
// Best-effort: a future layout change degrades to a warning, never a crash.
function evictGcsAgentPool(logger?: ScopedLogger): void {
  try {
    const require_ = createRequire(import.meta.url);
    const agents = require_("teeny-request/build/src/agents.js") as {
      pool?: Map<string, { destroy?: () => void }>;
    };
    if (!agents.pool) throw new Error("agent pool not found");
    for (const [key, agent] of agents.pool) {
      agent.destroy?.();
      agents.pool.delete(key);
    }
  } catch (err) {
    logger?.warn("could not evict GCS agent pool on store rebuild", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The concrete backend, wrapped in GuardedStore: every call gets a hard
 *  deadline and the SDK client is rebuilt after consecutive breaches — a hung
 *  keep-alive pool wedged prod ingest for three hours on 2026-07-30. The
 *  factory hands GuardedStore a way to rebuild the inner store fresh. */
export function buildStore(c: VaultCredentials, logger?: ScopedLogger): SessionStore {
  let lastInner: SessionStore | null = null;
  const factory = (): SessionStore => {
    // Rebuild-time transport hygiene: the fresh store must not inherit the
    // old client's sockets — GCS shares a process-global agent pool (evict
    // it); an S3 client owns its handler (destroy it).
    if (lastInner) {
      if (c.store === "gcs") evictGcsAgentPool(logger);
      else (lastInner as S3Store).destroyClient();
    }
    lastInner = buildInnerStore(c);
    return lastInner;
  };
  return new GuardedStore(factory, { logger, ...deadlineEnvOverrides() });
}

function buildInnerStore(c: VaultCredentials): SessionStore {
  if (c.store === "gcs") {
    if (!c.projectId) {
      throw new Error("gcs storage requires a projectId in credentials.json");
    }
    return new GcsStore({
      projectId: c.projectId,
      bucketName: c.bucket,
      // Inline service-account key; absent → Application Default Credentials.
      credentials: c.gcs as GcsStoreConfig["credentials"],
    });
  }
  if (!c.region) {
    throw new Error("s3 storage requires a region in credentials.json");
  }
  // M-4 · reject an unsafe custom endpoint (plaintext / SSRF-range) before dialing.
  assertS3EndpointSafe(c.endpoint);
  return new S3Store({
    region: c.region,
    bucketName: c.bucket,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    // Inline access key; absent → AWS default credential chain (env / role).
    credentials: c.s3,
  });
}
