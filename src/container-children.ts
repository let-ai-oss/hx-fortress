// The children a container supervisor holds, and the one question it has to
// answer before it signals one.
//
// SIGNALLING IS GUARDED BY IDENTITY, NOT BY LIVENESS. A loopback probe would
// only prove that SOMETHING is listening on the port; a bare `kill(pid, 0)`
// would only prove that SOMETHING has that number. The kernel recycles pids
// inside one boot, and the likeliest recycler in this container is
// `hx-fortress host` — the one process a console shutdown must never touch.
//
// The supervisor is also the PARENT, which hands it one fact it does not have to
// infer: it watched the child exit. That observation outranks everything below,
// and it is what carries the case a start token cannot — a slim image with
// neither /proc nor `ps` leaves the record UNPROVEN, and a bare pid check there
// is exactly the guard that is no guard.

import {
  machineBootId,
  processStartToken,
  proveIdentity,
  type IdentityVerdict,
  type InstanceLockRecord,
} from "./ui/instance";

export interface SupervisedChild {
  /** The pid, when the child is running. */
  readonly pid: number;
  kill(signal: NodeJS.Signals | number): void;
  readonly exited: Promise<number>;
}

/** What the supervisor remembers about a child it started: enough to prove, later
 *  and from the outside, that the pid it holds is still the process it started. */
export interface ChildIdentity {
  record: InstanceLockRecord;
  child: SupervisedChild;
  /** Set the moment this process observes the child's own exit. */
  exited: boolean;
}

export function identify(child: SupervisedChild, port: number): ChildIdentity {
  const identity: ChildIdentity = {
    child,
    exited: false,
    record: {
      pid: child.pid,
      bootId: machineBootId(),
      ...processStartToken(child.pid),
      port,
    },
  };
  void child.exited.then(() => {
    identity.exited = true;
  });
  return identity;
}

/**
 * Signal a child, but only once it has been proven to still BE that child.
 *
 * Returns false when it is not: the process exited and its number was reused,
 * and the thing wearing it now is somebody else's.
 */
export function signalIfStillOurs(
  identity: ChildIdentity,
  signal: NodeJS.Signals = "SIGTERM",
  prove: (record: InstanceLockRecord) => IdentityVerdict = proveIdentity,
): boolean {
  // Observed, not inferred. A child this process has already reaped is a pid
  // whose next owner is somebody else.
  if (identity.exited) return false;
  // UNPROVEN passes, and only because of the line above: the parent has seen no
  // exit, so the pid is still its child's. A record alone would not carry it.
  if (prove(identity.record) === "gone") return false;
  try {
    identity.child.kill(signal);
    return true;
  } catch {
    return false;
  }
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
