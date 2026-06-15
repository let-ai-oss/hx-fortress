import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { commandError, NodeCommandRunner } from "./command-runner";
import type {
  CommandRunner,
  ServiceInstallOptions,
  ServiceManager,
  ServiceState,
} from "./types";

const UNIT_NAME = "hx-fortress.service";

interface SystemdDependencies {
  home: string;
  runner?: CommandRunner;
  mkdir?: typeof mkdir;
  writeFile?: (
    file: string,
    contents: string,
  ) => Promise<void>;
}

export class SystemdServiceManager implements ServiceManager {
  readonly name = "systemd (user)";
  private readonly runner: CommandRunner;
  private readonly makeDirectory: typeof mkdir;
  private readonly write: (file: string, contents: string) => Promise<void>;

  constructor(private readonly dependencies: SystemdDependencies) {
    this.runner = dependencies.runner ?? new NodeCommandRunner();
    this.makeDirectory = dependencies.mkdir ?? mkdir;
    this.write = dependencies.writeFile ?? ((file, contents) => writeFile(file, contents));
  }

  async state(): Promise<ServiceState> {
    const enabled = this.runner.run("systemctl", [
      "--user",
      "is-enabled",
      UNIT_NAME,
    ]);
    const show = this.runner.run("systemctl", [
      "--user",
      "show",
      UNIT_NAME,
      "--property=MainPID",
    ]);
    const match = show.stdout.match(/MainPID=(\d+)/);
    const pid = match ? Number(match[1]) : 0;
    return {
      loaded: enabled.status === 0,
      pid: show.status === 0 && pid > 0 ? pid : null,
    };
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const unitPath = this.unitPath();
    await this.makeDirectory(path.dirname(unitPath), { recursive: true });
    await this.makeDirectory(path.dirname(options.serviceLogPath), {
      recursive: true,
    });
    await this.write(unitPath, renderSystemdUnit(options));
    this.runOrThrow("systemctl", ["--user", "daemon-reload"]);
    this.runOrThrow("systemctl", [
      "--user",
      "enable",
      "--now",
      UNIT_NAME,
    ]);
  }

  async stop(): Promise<{ wasRunning: boolean }> {
    const before = await this.state();
    this.runner.run("systemctl", [
      "--user",
      "disable",
      "--now",
      UNIT_NAME,
    ]);
    const active = this.runner.run("systemctl", [
      "--user",
      "is-active",
      UNIT_NAME,
    ]);
    if (active.status === 0) {
      throw new Error(
        `systemctl --user disable --now ${UNIT_NAME} failed: unit still active`,
      );
    }
    return { wasRunning: before.pid !== null };
  }

  private unitPath(): string {
    return path.join(
      this.dependencies.home,
      ".config",
      "systemd",
      "user",
      UNIT_NAME,
    );
  }

  private runOrThrow(command: string, args: readonly string[]): void {
    const result = this.runner.run(command, args);
    if (result.status !== 0) throw commandError(command, args, result);
  }
}

export function renderSystemdUnit(options: ServiceInstallOptions): string {
  const executablePath = quoteSystemdArgument(options.executablePath);
  const serviceLogPath = escapeSystemdSpecifier(options.serviceLogPath);
  return `[Unit]
Description=HX Fortress
After=network-online.target

[Service]
Type=simple
ExecStart=${executablePath} host
Restart=on-failure
RestartSec=5
StandardOutput=append:${serviceLogPath}
StandardError=append:${serviceLogPath}

[Install]
WantedBy=default.target
`;
}

function quoteSystemdArgument(value: string): string {
  const escaped = escapeSystemdSpecifier(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function escapeSystemdSpecifier(value: string): string {
  return value.replace(/%/g, "%%");
}
