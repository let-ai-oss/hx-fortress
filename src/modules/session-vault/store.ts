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

/** True when a supervisor will resurrect this process after exit(1):
 *  systemd (Restart=on-failure in our unit) sets INVOCATION_ID, launchd
 *  (KeepAlive in our plist) sets XPC_SERVICE_NAME, Railway restarts crashed
 *  services by policy. FORTRESS_STORE_EXIT_ON_WEDGE=on|off overrides. */
function supervisedRestartAvailable(): boolean {
  const override = process.env.FORTRESS_STORE_EXIT_ON_WEDGE;
  if (override === "on") return true;
  if (override === "off") return false;
  return Boolean(
    process.env.INVOCATION_ID ?? process.env.XPC_SERVICE_NAME ?? process.env.RAILWAY_ENVIRONMENT,
  );
}

/** The concrete backend, wrapped in GuardedStore: every call gets a hard
 *  deadline and the SDK client is rebuilt after consecutive breaches — a hung
 *  keep-alive pool wedged prod ingest for three hours on 2026-07-30. The
 *  factory hands GuardedStore a way to rebuild the inner store fresh. */
export function buildStore(c: VaultCredentials, logger?: ScopedLogger): SessionStore {
  let lastInner: SessionStore | null = null;
  const factory = (): SessionStore => {
    // Rebuild-time hygiene: shed what THIS layer can actually reach — SDK and
    // auth state, and the S3 client's own handler. Under Bun the HTTP sockets
    // live in the process-global native-fetch pool no JS layer can evict;
    // when rebuilds prove futile, onWedgedBeyondRecovery escalates instead of
    // pretending. Best-effort: a destroy failure must not break the rebuild.
    if (lastInner && c.store !== "gcs") {
      try {
        (lastInner as S3Store).destroyClient();
      } catch (err) {
        logger?.warn("could not destroy previous S3 client on rebuild", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    lastInner = buildInnerStore(c);
    return lastInner;
  };
  return new GuardedStore(factory, {
    logger,
    ...deadlineEnvOverrides(),
    onWedgedBeyondRecovery: () => {
      if (supervisedRestartAvailable()) {
        logger?.error(
          "store write path wedged beyond in-process recovery — exiting for supervisor restart",
        );
        process.exit(1);
      }
      logger?.error(
        "store write path wedged beyond in-process recovery — no supervisor detected, continuing degraded (set FORTRESS_STORE_EXIT_ON_WEDGE=on to opt into exit)",
      );
    },
  });
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
