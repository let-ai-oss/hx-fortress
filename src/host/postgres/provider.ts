import type { PostgresPhase, PostgresProvider } from "../types";

export interface EmbeddedDeps {
  /** Download/extract the binaries; resolves to the `bin/` directory. */
  acquire: () => Promise<string>;
  /** Run `initdb` if the data directory is fresh. */
  ensureCluster: (binDir: string) => Promise<void>;
  /** Start the server and block until it accepts connections (`pg_ctl -w`). */
  startServer: (binDir: string) => Promise<void>;
  /** Stop the server (`pg_ctl -m fast stop`). */
  stopServer: (binDir: string) => Promise<void>;
  /** Create the hx-db database and hx schema over a live connection. */
  ensureDbSchema: () => Promise<void>;
  /** Apply the hx schema migrations over a live connection. */
  migrate: () => Promise<void>;
  /** Connection string handed to modules once ready. */
  dsn: string;
}

export function createEmbeddedPostgres(deps: EmbeddedDeps): PostgresProvider {
  let phase: PostgresPhase = "acquiring";
  let reason: string | null = null;
  let binDir: string | null = null;

  return {
    async start() {
      try {
        phase = "acquiring";
        binDir = await deps.acquire();
        phase = "initializing";
        await deps.ensureCluster(binDir);
        await deps.startServer(binDir);
        await deps.ensureDbSchema();
        await deps.migrate();
        phase = "ready";
        reason = null;
      } catch (error) {
        phase = "failed";
        reason = error instanceof Error ? error.message : String(error);
      }
    },
    async stop() {
      if (binDir) {
        try {
          await deps.stopServer(binDir);
        } catch {
          // best-effort shutdown; nothing else to do on the way down
        }
      }
      binDir = null;
    },
    status() {
      return { phase, reason };
    },
    isReady() {
      return phase === "ready";
    },
    dsn() {
      return phase === "ready" ? deps.dsn : null;
    },
  };
}

export function createExternalPostgres(
  url: string,
  probeReady: () => Promise<boolean>,
  migrate?: () => Promise<void>,
): PostgresProvider {
  let phase: PostgresPhase = "initializing";
  let reason: string | null = null;
  return {
    async start() {
      try {
        if (!(await probeReady())) throw new Error("external postgres unreachable");
        if (migrate) await migrate();
        phase = "ready";
        reason = null;
      } catch (error) {
        phase = "failed";
        reason = error instanceof Error ? error.message : String(error);
      }
    },
    async stop() {},
    status() {
      return { phase, reason };
    },
    isReady() {
      return phase === "ready";
    },
    dsn() {
      return phase === "ready" ? url : null;
    },
  };
}
