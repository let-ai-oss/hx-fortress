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
  /**
   * Idempotent in-place auth hardening (de-superuser): set the fortress password
   * and rewrite pg_hba.conf to loopback-only scram, converting a legacy
   * `--auth=trust` cluster with zero re-init. Runs after `startServer`, before
   * `ensureDbSchema`. Receives the binDir so it can `pg_ctl reload`.
   */
  ensureAuth?: (binDir: string) => Promise<void>;
  /** Create the hx-db database and hx schema over a live connection. */
  ensureDbSchema: () => Promise<void>;
  /**
   * Best-effort inject of pgvector into the embedded bundle before migrate, so
   * the gated embeddings migrations can apply. Optional + never fatal.
   */
  ensureVector?: () => Promise<void>;
  /** Apply the hx schema migrations over a live connection. */
  migrate: () => Promise<void>;
  /**
   * Idempotently provision the least-privilege login roles (hx_app_ro/hx_app_rw)
   * over a live connection. Runs after `migrate` so the blanket schema grants
   * cover every table this boot created.
   */
  ensureAppRoles?: () => Promise<void>;
  /** Role-aware connection string builder handed to modules once ready. Default
   *  (and `"rw"`) resolves the DML role; `"ro"` the SELECT-only role. */
  dsn: (role?: "ro" | "rw") => string;
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
        // De-superuser hardening: set the fortress password + rewrite pg_hba to
        // scram BEFORE any schema work, converting a legacy trust cluster in
        // place. Must precede ensureDbSchema so every later connection is scram.
        if (deps.ensureAuth) await deps.ensureAuth(binDir);
        await deps.ensureDbSchema();
        // Inject pgvector before migrate so the embeddings migrations can apply
        // this boot. Mandatory: if the inject throws, it propagates and fails
        // the start (phase = "failed") — semantic search is core, so we refuse
        // to boot half-working rather than silently degrade.
        if (deps.ensureVector) await deps.ensureVector();
        await deps.migrate();
        // Provision the least-privilege app roles after migrate, so the blanket
        // GRANT ON ALL TABLES covers everything this boot created.
        if (deps.ensureAppRoles) await deps.ensureAppRoles();
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
    dsn(role) {
      return phase === "ready" ? deps.dsn(role) : null;
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
    // External Postgres: role-split is embedded-only, so both roles resolve to
    // the operator's single URL. Least-privilege there is the operator's job.
    dsn() {
      return phase === "ready" ? url : null;
    },
  };
}
