import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { commandError, NodeCommandRunner } from "./command-runner";
import type {
  CommandRunner,
  ServiceInstallOptions,
  ServiceManager,
  ServiceState,
} from "./types";

const LABEL = "ai.let.hx-fortress";
const MAX_STATE_POLLS = 20;
const TRANSIENT_BOOTSTRAP =
  /Bootstrap failed: (5|37|125)\b|Input\/output error|Operation (already|now) in progress/i;

interface LaunchdDependencies {
  home: string;
  uid: number;
  runner?: CommandRunner;
  mkdir?: typeof mkdir;
  writeFile?: (
    file: string,
    contents: string,
  ) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class LaunchdServiceManager implements ServiceManager {
  readonly name = "launchd";
  private readonly runner: CommandRunner;
  private readonly makeDirectory: typeof mkdir;
  private readonly write: (file: string, contents: string) => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: LaunchdDependencies) {
    this.runner = dependencies.runner ?? new NodeCommandRunner();
    this.makeDirectory = dependencies.mkdir ?? mkdir;
    this.write = dependencies.writeFile ?? ((file, contents) => writeFile(file, contents));
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async state(): Promise<ServiceState> {
    const result = this.runner.run("launchctl", ["list", LABEL]);
    if (result.status !== 0) return { loaded: false, pid: null };
    const match = result.stdout.match(/"PID"\s*=\s*(\d+);/);
    return {
      loaded: true,
      pid: match ? Number(match[1]) : null,
    };
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const plistPath = this.plistPath();
    await this.makeDirectory(path.dirname(plistPath), { recursive: true });
    await this.makeDirectory(path.dirname(options.serviceLogPath), {
      recursive: true,
    });
    await this.write(plistPath, renderLaunchdPlist(options));

    const target = this.target();
    this.runner.run("launchctl", ["bootout", `${target}/${LABEL}`]);
    await this.waitUntilUnloaded();
    this.runOrThrow("launchctl", ["enable", `${target}/${LABEL}`]);
    await this.bootstrapWithRetry(target, plistPath);
  }

  async stop(): Promise<{ wasRunning: boolean }> {
    const target = this.target();
    this.runner.run("launchctl", ["disable", `${target}/${LABEL}`]);
    const before = await this.state();
    if (!before.loaded) return { wasRunning: false };

    const bootout = this.runner.run("launchctl", [
      "bootout",
      `${target}/${LABEL}`,
    ]);
    if (!(await this.waitUntilUnloaded())) {
      throw new Error(
        `launchctl bootout ${target}/${LABEL} failed: unit still loaded${
          bootout.stderr.trim() ? ` (${bootout.stderr.trim()})` : ""
        }`,
      );
    }
    return { wasRunning: before.pid !== null };
  }

  private target(): string {
    return `gui/${this.dependencies.uid}`;
  }

  private plistPath(): string {
    return path.join(
      this.dependencies.home,
      "Library",
      "LaunchAgents",
      `${LABEL}.plist`,
    );
  }

  private async waitUntilUnloaded(): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_STATE_POLLS; attempt++) {
      if (!(await this.state()).loaded) return true;
      await this.sleep(100);
    }
    return false;
  }

  private async bootstrapWithRetry(
    target: string,
    plistPath: string,
  ): Promise<void> {
    const args = ["bootstrap", target, plistPath] as const;
    const delays = [150, 300, 600, 1000];
    let result = this.runner.run("launchctl", args);
    for (const delay of delays) {
      if (result.status === 0) return;
      const detail = result.stderr.trim() || result.stdout.trim();
      if (!TRANSIENT_BOOTSTRAP.test(detail)) break;
      await this.sleep(delay);
      result = this.runner.run("launchctl", args);
    }
    if (result.status !== 0) {
      throw commandError("launchctl", args, result);
    }
  }

  private runOrThrow(command: string, args: readonly string[]): void {
    const result = this.runner.run(command, args);
    if (result.status !== 0) throw commandError(command, args, result);
  }
}

export function renderLaunchdPlist(options: ServiceInstallOptions): string {
  const executablePath = escapeXml(options.executablePath);
  const serviceLogPath = escapeXml(options.serviceLogPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${executablePath}</string>
      <string>host</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>StandardOutPath</key><string>${serviceLogPath}</string>
    <key>StandardErrorPath</key><string>${serviceLogPath}</string>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
