// What the daemon actually does when the console asks.
//
// One executor per command kind, and the Record is exhaustive over the FINAL
// allowlist — a kind cannot be added to the plane without something here to run
// it. The executors return the sentence the console renders as the outcome, and
// throw with the sentence it renders as the failure; neither is invented by the
// console, which is what makes a reported outcome comparable against the
// daemon's own audit record.
//
// Nothing here is reached without the row already having been claimed through
// the SECURITY DEFINER state machine, and every kind's parameters have already
// been validated against the per-kind shape.

import { consoleUpdateGate } from "../host/trust/verify";
import { runFortressUpdate } from "../update";
import type { CommandExecutor, CommandExecutors } from "./commands";
import type { SessionStore } from "../modules/session-vault/store/types";
import type { ScopedLogger } from "../host/types";
import type { ServiceManager } from "../service";

export interface ExecutorDeps {
  logger: ScopedLogger;
  /** The live store binding. Lazy: a rotation swaps what this returns. */
  store: () => SessionStore | null;
  /** The update origin, derived from this fortress's cloud URL. */
  downloadBaseUrl: () => Promise<string | null>;
  /** The daemon's own unit — the swap target is read from it. */
  service: ServiceManager;
  /** Called once a new binary is in place. The restart it schedules must happen
   *  AFTER the outcome record is durable, so it is a signal rather than an act:
   *  a daemon that restarted itself here would die before the record it is
   *  about to write, leaving a swap nobody can prove happened. */
  onBinarySwapped: () => void;
}

/** A kind whose executor belongs to work this build does not carry. It is
 *  unreachable from the console, which offers a control only for the kinds it
 *  can run; a row of this kind was minted by something else, and failing it is
 *  the honest answer. */
function notCarried(kind: string): CommandExecutor {
  return async () => {
    throw new Error(`this build does not run ${kind}`);
  };
}

export function createCommandExecutors(deps: ExecutorDeps): CommandExecutors {
  return {
    update_apply: async () => {
      const base = await deps.downloadBaseUrl();
      if (!base) {
        throw new Error("this fortress has no update origin — it is not enrolled");
      }
      // The swap target comes from the UNIT, not from this process: a daemon
      // started by hand from a second copy would otherwise replace the copy
      // nothing starts and leave the unit's binary untouched.
      const unit = await deps.service.unit();
      const binPath = unit.executablePath ?? process.execPath;
      // The console path takes the strictest verification this build can do,
      // and says so in the outcome when that is not a signature.
      const gate = consoleUpdateGate();
      const result = await runFortressUpdate({
        downloadBaseUrl: base,
        binPath,
        enforceSignature: gate.enforce,
        log: (message) => deps.logger.info(message),
      });
      if (result.alreadyLatest) {
        return `already on ${result.localVersion}`;
      }
      deps.onBinarySwapped();
      const version = result.remoteVersion ?? "the newest build";
      return gate.warning
        ? `installed ${version} at ${result.installedPath} — ${gate.warning}`
        : `installed ${version} at ${result.installedPath}`;
    },

    self_test: async () => {
      const store = deps.store();
      if (!store) throw new Error("the object store is not initialized on this fortress");
      await store.selfTest();
      return "storage write path healthy";
    },

    rotate_credentials: notCarried("rotate_credentials"),
    run_migration: notCarried("run_migration"),
    run_checkup: notCarried("run_checkup"),
    run_audit: notCarried("run_audit"),
    witness_toggle: notCarried("witness_toggle"),
    acknowledge_finding: notCarried("acknowledge_finding"),
  };
}
