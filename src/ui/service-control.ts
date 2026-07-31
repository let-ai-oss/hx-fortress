// The console's own service unit — named here, installed by the install-service
// verb, and consulted by `ui disable` and by the SSO precondition.
//
// The names are PINNED. `ui disable` has to stop the same unit the installer
// wrote, and the SSO precondition has to know whether a unit exists at all: when
// one does, the precondition reads ui.json and the unit's own environment and
// NEVER the invoking shell's, because `FORTRESS_UI_PUBLIC_URL=... hx-fortress ui
// sso on` would otherwise pass a check the unit can never satisfy.

import { NodeCommandRunner } from "../service/command-runner";
import type { CommandRunner } from "../service/types";

export const SYSTEMD_UI_UNIT = "hx-fortress-ui.service";
export const LAUNCHD_UI_LABEL = "ai.let.hx-fortress-ui";

export interface UiServiceControl {
  readonly name: string;
  /** True when a console unit exists on this host, running or not. */
  installed(): Promise<boolean>;
  /** Stop it and keep it stopped across a reboot. */
  stopAndDisable(): Promise<void>;
}

export class SystemdUiService implements UiServiceControl {
  readonly name = "systemd (user)";

  constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}

  async installed(): Promise<boolean> {
    const result = this.runner.run("systemctl", ["--user", "cat", SYSTEMD_UI_UNIT]);
    return result.status === 0;
  }

  async stopAndDisable(): Promise<void> {
    this.runner.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UI_UNIT]);
  }
}

export class LaunchdUiService implements UiServiceControl {
  readonly name = "launchd";

  constructor(
    private readonly uid: number,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
  ) {}

  async installed(): Promise<boolean> {
    const result = this.runner.run("launchctl", ["print", `gui/${this.uid}/${LAUNCHD_UI_LABEL}`]);
    return result.status === 0;
  }

  async stopAndDisable(): Promise<void> {
    this.runner.run("launchctl", ["disable", `gui/${this.uid}/${LAUNCHD_UI_LABEL}`]);
    this.runner.run("launchctl", ["bootout", `gui/${this.uid}/${LAUNCHD_UI_LABEL}`]);
  }
}

/** A host whose init system this build does not drive. Reports no unit, which is
 *  the honest answer: the console runs in the foreground there. */
export class NoUiService implements UiServiceControl {
  readonly name = "none";

  async installed(): Promise<boolean> {
    return false;
  }

  async stopAndDisable(): Promise<void> {
    // Nothing to stop.
  }
}

export function getUiServiceControl(options: { platform?: string; uid?: number } = {}): UiServiceControl {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return new SystemdUiService();
  if (platform === "darwin") return new LaunchdUiService(options.uid ?? process.getuid?.() ?? 0);
  return new NoUiService();
}
