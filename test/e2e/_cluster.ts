import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPostgresProvider } from "../../src/host/postgres";
import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { fortressPaths } from "../../src/host/paths";
import type { FortressConfig } from "../../src/host/types";

export { makeMigrationExec };

const config: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://x/tunnel" },
  gateway: { publicUrl: "https://x" },
  modules: { enabled: [] },
};

export interface Cluster {
  /** DSN for the hx-db database on the freshly-booted embedded cluster. */
  dsn: string;
  stop: () => Promise<void>;
}

/** Boot a throwaway embedded Postgres in a temp root and return its hx-db DSN.
 *  Acquires/extracts the zonky binaries on first use (slow); reused by the
 *  schema e2e suites. Caller must `stop()` to shut down and remove the root. */
export async function startCluster(): Promise<Cluster> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-e2e-"));
  const paths = fortressPaths(root);
  // Bind a per-run port (not the fixed 54329 default) so a leaked cluster from
  // an aborted run can't block the next one, and parallel suites don't collide.
  const port = String(49152 + (process.pid % 16000));
  const provider = buildPostgresProvider({ env: { FORTRESS_PG_PORT: port }, config, paths });
  await provider.start();
  const status = provider.status();
  if (status.phase !== "ready") {
    await provider.stop();
    await rm(root, { recursive: true, force: true });
    throw new Error(`cluster not ready: ${status.reason ?? "unknown"}`);
  }
  const dsn = provider.dsn();
  if (!dsn) throw new Error("cluster ready but no dsn");
  return {
    dsn,
    stop: async () => {
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
