// `hx-fortress container-run` — one container, two long-running processes.
//
// A container image has one entrypoint and the fortress has two things to run:
// the daemon, and the console beside it. They are deliberately separate
// processes (a stopped daemon cannot serve its own Start button), which on a
// host is systemd's problem and in a container is nobody's — so this is that
// nobody.
//
// PID 1 ONLY, and it refuses otherwise. Not fussiness: pid 1 is what receives
// the container runtime's SIGTERM, and a supervisor that is not pid 1 leaves the
// daemon to be killed by the runtime's timeout instead of stopped by its own
// shutdown path — which means the last status write, the last audit drain and
// the cluster's clean stop all do not happen. pid 1 is also the parent every
// orphan is re-parented to, so it is the only process that can reap them.
//
// THE CONSOLE'S ENABLEMENT IS RE-READ BEFORE EVERY RESPAWN, never captured at
// boot. `ui enable` and `ui disable` write a file, and in a container there is no
// unit for `ui disable` to stop — the console stops because this loop notices.
// The same read is what stops a disabled console from being respawned after it
// exits, which is the difference between "disabled" and "restarting forever".
//
// SIGNALLING A CHILD IS GUARDED BY IDENTITY, NOT BY LIVENESS. Before this process
// signals a console it believes it started, it re-checks the recorded pid
// against the machine's boot id AND the process's start time. A loopback probe
// would only prove that SOMETHING is listening on the port; a pid check alone
// would only prove that SOMETHING has that number. The kernel recycles pids
// inside one boot, and the most likely recycler in this container is
// `hx-fortress host` — the one process a console shutdown must never SIGTERM.

import { fortressPaths } from "./host/paths";
import { LiveUiConfig, effectiveUiEnabled } from "./ui/config";
import { holderAlive, machineBootId, processStartToken, type InstanceLockRecord } from "./ui/instance";
import { bootstrapRequestPath, writeBootstrapRequest } from "./ui/bootstrap-user";

/** How long to wait after a child exits before starting it again. Long enough
 *  that a binary which exits immediately does not spin, short enough that a
 *  genuine crash is back inside a health check's window. */
export const RESPAWN_DELAY_MS = 2_000;

/** How long the daemon is given to stop on its own after the container runtime
 *  asks. Deliberately under Docker's default 10s grace: a supervisor that used
 *  the whole window would be SIGKILLed alongside the child it was waiting for. */
export const SHUTDOWN_GRACE_MS = 8_000;

/** How often the loop re-reads the enablement predicate while everything is up. */
export const SUPERVISE_TICK_MS = 2_000;

export const NOT_PID_ONE_REFUSAL =
  "hx-fortress container-run must be the container's entrypoint (pid 1). It is what receives the " +
  "runtime's SIGTERM and what orphaned processes are re-parented to; started under a shell or an " +
  "init wrapper it can do neither, and the daemon would be killed rather than stopped. " +
  "Set ENTRYPOINT [\"hx-fortress\", \"container-run\"], or run `hx-fortress host` directly.";

export interface SupervisedChild {
  /** The pid, when the child is running. */
  readonly pid: number;
  kill(signal: NodeJS.Signals | number): void;
  readonly exited: Promise<number>;
}

type Who = "daemon" | "console";
interface Settled {
  who: Who | "tick" | "stop";
  code: number;
}

export interface ContainerRunDeps {
  env: Record<string, string | undefined>;
  writeLine: (line: string) => void;
  /** Start one child by argv tail. The supervisor never builds a shell string. */
  spawn: (args: readonly string[]) => SupervisedChild;
  pid?: number;
  fortressRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; the real loop runs until it is signalled. */
  stopSignal?: Promise<void>;
  /** Proves a recorded child is still the process that was started. */
  alive?: (record: InstanceLockRecord) => boolean;
}

/** What the supervisor remembers about a child it started: enough to prove, later
 *  and from the outside, that the pid it holds is still the process it started. */
export interface ChildIdentity {
  record: InstanceLockRecord;
  child: SupervisedChild;
}

function identify(child: SupervisedChild, port: number): ChildIdentity {
  return {
    child,
    record: {
      pid: child.pid,
      bootId: machineBootId(),
      ...processStartToken(child.pid),
      port,
    },
  };
}

/**
 * Signal a child, but only once it has been proven to still BE that child.
 *
 * Returns false when the identity no longer matches — the process exited and its
 * number was reused, and the thing wearing it now is somebody else's.
 */
export function signalIfStillOurs(
  identity: ChildIdentity,
  signal: NodeJS.Signals = "SIGTERM",
  alive: (record: InstanceLockRecord) => boolean = holderAlive,
): boolean {
  if (!alive(identity.record)) return false;
  try {
    identity.child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the container until it is asked to stop.
 *
 * The daemon is unconditional; the console comes and goes with the enablement
 * predicate. Both are respawned, and neither respawn is decided from a value
 * read at boot.
 */
export async function runContainer(deps: ContainerRunDeps): Promise<number> {
  const pid = deps.pid ?? process.pid;
  if (pid !== 1) throw new Error(NOT_PID_ONE_REFUSAL);

  const paths = fortressPaths(deps.fortressRoot);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = deps.alive ?? holderAlive;
  const config = new LiveUiConfig(paths.uiConfig, (message) => deps.writeLine(message));
  const uiEnabled = async (): Promise<boolean> => {
    try {
      return effectiveUiEnabled(await config.read(), deps.env);
    } catch (error) {
      // A ui.json this process cannot parse is a reason to leave the console
      // alone, never a reason to take the daemon down with it.
      deps.writeLine(`console configuration unreadable: ${errorText(error)}`);
      return false;
    }
  };

  // The bootstrap request is written ONCE, here, before any console starts —
  // the console consumes it as it reads it, so a respawn finds nothing and the
  // link is printed exactly once per container boot.
  const bootstrapLogin = deps.env.FORTRESS_UI_BOOTSTRAP_USER?.trim();
  if (bootstrapLogin) {
    await writeBootstrapRequest(bootstrapRequestPath(paths.uiRoot), bootstrapLogin).catch(
      (error: unknown) => {
        deps.writeLine(`could not stage the console bootstrap account: ${errorText(error)}`);
      },
    );
  }

  let stopping = false;
  const stop = deps.stopSignal ?? signalled(["SIGTERM", "SIGINT"]);
  // Raced alongside the children, not merely polled at the next tick: the
  // runtime's grace period starts the moment it signals, and a supervisor that
  // spent the first seconds of it asleep has that much less to stop with.
  const stopped: Promise<Settled> = stop.then(() => {
    stopping = true;
    return { who: "stop" as const, code: 0 };
  });

  const consolePort = Number(deps.env.FORTRESS_UI_PORT?.trim()) || 0;
  interface Slot {
    identity: ChildIdentity | null;
    exit: Promise<Settled> | null;
  }
  const daemon: Slot = { identity: null, exit: null };
  const ui: Slot = { identity: null, exit: null };

  const start = (slot: Slot, who: Who, args: readonly string[], port: number): void => {
    const identity = identify(deps.spawn(args), port);
    slot.identity = identity;
    slot.exit = identity.child.exited.then((code) => ({ who, code }));
    deps.writeLine(`${who} started (pid ${identity.record.pid})`);
  };
  const startDaemon = (): void => start(daemon, "daemon", ["host"], 0);
  const startConsole = (): void => start(ui, "console", ["ui", "--supervised"], consolePort);

  startDaemon();
  if (await uiEnabled()) startConsole();

  while (!stopping) {
    const races: Promise<Settled>[] = [
      stopped,
      sleep(SUPERVISE_TICK_MS).then(() => ({ who: "tick" as const, code: 0 })),
    ];
    if (daemon.exit) races.push(daemon.exit);
    if (ui.exit) races.push(ui.exit);
    const settled = await Promise.race(races);
    if (stopping || settled.who === "stop") break;

    if (settled.who === "daemon") {
      daemon.identity = null;
      daemon.exit = null;
      deps.writeLine(`daemon exited (${settled.code}); restarting in ${RESPAWN_DELAY_MS}ms`);
      await sleep(RESPAWN_DELAY_MS);
      if (stopping) break;
      startDaemon();
      continue;
    }

    if (settled.who === "console") {
      ui.identity = null;
      ui.exit = null;
      // Re-read BEFORE respawning, not after: a console that exited because the
      // operator disabled it must not be started again by the loop that noticed.
      if (!(await uiEnabled())) {
        deps.writeLine("console exited and is disabled; leaving it stopped");
        continue;
      }
      deps.writeLine(`console exited (${settled.code}); restarting in ${RESPAWN_DELAY_MS}ms`);
      await sleep(RESPAWN_DELAY_MS);
      if (stopping) break;
      startConsole();
      continue;
    }

    // A tick. The only thing it decides is whether the console's enablement
    // FLIPPED under a running process.
    const enabled = await uiEnabled();
    const running = ui.identity;
    if (enabled && !running) {
      startConsole();
    } else if (!enabled && running) {
      deps.writeLine(
        signalIfStillOurs(running, "SIGTERM", alive)
          ? `console disabled; stopping pid ${running.record.pid}`
          : "console disabled; the process it was is already gone",
      );
      ui.identity = null;
      ui.exit = null;
    }
  }

  return await shutdown({
    daemon: daemon.identity,
    console: ui.identity,
    writeLine: deps.writeLine,
    sleep,
    alive,
  });
}

/**
 * Stop both children and wait for them.
 *
 * The console goes first and the daemon last: the console reads the daemon's
 * status and database, and stopping the thing being watched before the watcher
 * turns an ordinary shutdown into a page full of connection errors.
 */
async function shutdown(args: {
  daemon: ChildIdentity | null;
  console: ChildIdentity | null;
  writeLine: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  alive: (record: InstanceLockRecord) => boolean;
}): Promise<number> {
  args.writeLine("stopping");
  const waits: Promise<unknown>[] = [];
  for (const identity of [args.console, args.daemon]) {
    if (!identity) continue;
    if (signalIfStillOurs(identity, "SIGTERM", args.alive)) waits.push(identity.child.exited);
  }
  if (waits.length === 0) return 0;
  // Bounded: the runtime's own grace period is next, and a supervisor still
  // waiting when it expires is SIGKILLed together with everything it was
  // waiting for.
  await Promise.race([Promise.all(waits), args.sleep(SHUTDOWN_GRACE_MS)]);
  return 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves on the first of these signals. */
function signalled(signals: readonly NodeJS.Signals[]): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const signal of signals) process.once(signal, () => resolve());
  });
}

/** The production child factory: this very binary, re-invoked with a verb. Argv
 *  rather than a shell line — nothing here is interpolated into a command. */
export function spawnFortress(argv0: string): (args: readonly string[]) => SupervisedChild {
  return (args) => {
    const child = Bun.spawn([argv0, ...args], {
      // Inherited on purpose: the container's log capture is the only place these
      // two processes are ever read from.
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    return {
      get pid(): number {
        return child.pid;
      },
      kill: (signal) => child.kill(signal as number),
      exited: child.exited,
    };
  };
}

/** The verb. Separated from the loop so the loop takes no process globals. */
export async function runContainerCommand(
  deps: Pick<ContainerRunDeps, "writeLine"> & Partial<ContainerRunDeps>,
): Promise<number> {
  return await runContainer({
    env: deps.env ?? process.env,
    writeLine: deps.writeLine,
    spawn: deps.spawn ?? spawnFortress(process.execPath),
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.fortressRoot ? { fortressRoot: deps.fortressRoot } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.stopSignal ? { stopSignal: deps.stopSignal } : {}),
  });
}
