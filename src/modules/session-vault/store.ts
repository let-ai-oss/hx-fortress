// Build the concrete SessionStore the vault serves, from credentials.json. The
// store reads/writes the ORGANIZATION's bucket with the ORGANIZATION's
// credentials — inline in credentials.json, or (when a block is absent) the
// host's own ADC / instance role. let.ai never sees either.

import { GcsStore, type GcsStoreConfig } from "./store/gcs-store.js";
import { GuardedStore, type GuardedStoreOptions } from "./store/guarded-store.js";
import { S3Store } from "./store/s3-store.js";
import { assertS3EndpointSafe } from "./store/endpoint-safety.js";
import type { SessionStore } from "./store/types.js";
import type { VaultCredentials } from "./credentials.js";
import type { ScopedLogger } from "../../host/types.js";

/** Per-call deadline override for the guarded store (ms). */
function deadlineEnvOverrides(): Pick<GuardedStoreOptions, "opTimeoutMs"> {
  const n = Number(process.env.FORTRESS_STORE_OP_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n > 0 ? { opTimeoutMs: n } : {};
}

/** The concrete backend, wrapped in GuardedStore: every call gets a hard
 *  deadline and the SDK client is rebuilt after consecutive breaches — a hung
 *  keep-alive pool wedged prod ingest for three hours on 2026-07-30. The
 *  factory hands GuardedStore a way to rebuild the inner store fresh. */
export function buildStore(c: VaultCredentials, logger?: ScopedLogger): SessionStore {
  return new GuardedStore(() => buildInnerStore(c), { logger, ...deadlineEnvOverrides() });
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
