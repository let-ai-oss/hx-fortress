import { PG_DATABASE, PG_ROLE } from "./cluster";
import type { PostgresPhase, PostgresProvider } from "../types";

export interface EmbeddedDeps {
  acquire: () => Promise<string>;
  ensureCluster: (binDir: string) => Promise<void>;
  ensureDbSchema: (binDir: string) => Promise<void>;
  launch: (binDir: string) => { kill: () => void; exited: Promise<number> };
  probeReady: () => Promise<boolean>;
  socketDir: string;
}

export function createEmbeddedPostgres(deps: EmbeddedDeps): PostgresProvider {
  let phase: PostgresPhase = "acquiring";
  let reason: string | null = null;
  let handle: { kill: () => void; exited: Promise<number> } | null = null;

  return {
    async start() {
      try {
        phase = "acquiring";
        const binDir = await deps.acquire();
        phase = "initializing";
        await deps.ensureCluster(binDir);
        handle = deps.launch(binDir);
        await deps.ensureDbSchema(binDir);
        if (!(await deps.probeReady())) throw new Error("postgres did not become ready");
        phase = "ready";
        reason = null;
      } catch (error) {
        phase = "failed";
        reason = error instanceof Error ? error.message : String(error);
      }
    },
    async stop() {
      handle?.kill();
      if (handle) await handle.exited.catch(() => 0);
      handle = null;
    },
    status() {
      return { phase, reason };
    },
    isReady() {
      return phase === "ready";
    },
    dsn() {
      return phase === "ready"
        ? `postgresql://${PG_ROLE}@/${PG_DATABASE}?host=${deps.socketDir}`
        : null;
    },
  };
}

export function createExternalPostgres(
  url: string,
  probeReady: () => Promise<boolean>,
): PostgresProvider {
  let phase: PostgresPhase = "initializing";
  let reason: string | null = null;
  return {
    async start() {
      try {
        if (!(await probeReady())) throw new Error("external postgres unreachable");
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
