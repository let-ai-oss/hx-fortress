import { startFortress, statusFortress, stopFortress } from "./cli-lifecycle";
import { setFortressCredential } from "./cli-credentials";
import {
  createProductionLogsDeps,
  logsCommand,
  type LogsOptions,
} from "./cli-logs";
import { FileConfigStore } from "./host/config";
import { runFortressHost } from "./host/main";
import { fortressPaths } from "./host/paths";
import {
  runEnrollWizard,
  type WizardEntryOpts,
} from "./modules/session-vault/wizard";
import { ProgressBar } from "./progress";
import { FileStatusReader } from "./status-reader";
import { getServiceManager } from "./service";
import type { ServiceInstallOptions } from "./service";
import { runFortressTui } from "./tui";
import {
  downloadBaseFromCloudUrl,
  runFortressUpdate,
  type UpdateProgress,
  type UpdateResult,
} from "./update";

type RunLogs = (options: Omit<LogsOptions, "follow" | "signal">) => Promise<void>;
type RunEnrollWizard = (options: WizardEntryOpts) => Promise<void>;
type RunTui = () => Promise<number>;
type RunUpdate = (opts: { downloadBaseUrl: string; binPath?: string; log?: (msg: string) => void; onProgress?: (ev: UpdateProgress) => void }) => Promise<UpdateResult>;

interface CliDependencies {
  getServiceManager?: typeof getServiceManager;
  runEnrollWizard?: RunEnrollWizard;
  runFortressHost?: typeof runFortressHost;
  runLogs?: RunLogs;
  runTui?: RunTui;
  runUpdate?: RunUpdate;
  writeLine?: (line: string) => void;
  /** Override the Fortress root directory — used in tests to supply a temp config. */
  fortressRoot?: string;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeLine = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const command = args[0];

  try {
    switch (command) {
      case undefined:
        return await (dependencies.runTui ?? runFortressTui)();
      case "enroll": {
        const cloudIdx = args.indexOf("--cloud");
        const cloudUrl = cloudIdx >= 0 ? args[cloudIdx + 1] : undefined;
        const maybeToken = args[1];
        const token = maybeToken && !maybeToken.startsWith("--") ? maybeToken : undefined;
        if (!cloudUrl) {
          throw new Error("usage: hx-fortress enroll [token] --cloud <url>");
        }
        await (dependencies.runEnrollWizard ?? runEnrollWizard)({
          token,
          cloudUrl,
          log: writeLine,
        });
        return 0;
      }
      case "credentials": {
        if (args[1] !== "set" || !args[2] || args[3]) {
          throw new Error("usage: hx-fortress credentials set <key>");
        }
        await setFortressCredential(args[2], { root: dependencies.fortressRoot });
        writeLine("Fortress credential updated.");
        writeLine("Restart Fortress or reconnect it to use the new credential.");
        return 0;
      }
      case "start":
        await startFortress({
          manager: (dependencies.getServiceManager ?? getServiceManager)(),
          executablePath: process.execPath,
          paths: fortressPaths(),
          writeLine,
        });
        return 0;
      case "stop":
        await stopFortress({
          manager: (dependencies.getServiceManager ?? getServiceManager)(),
          writeLine,
        });
        return 0;
      case "status": {
        const paths = fortressPaths();
        await statusFortress({
          manager: (dependencies.getServiceManager ?? getServiceManager)(),
          statusReader: new FileStatusReader(paths.status),
          writeLine,
        });
        return 0;
      }
      case "host":
        await (dependencies.runFortressHost ?? runFortressHost)();
        return 0;
      case "logs": {
        const paths = fortressPaths();
        const rest = args.slice(1);
        const moduleFilter = rest.find((a) => !a.startsWith("--"));
        const linesIdx = rest.indexOf("--lines");
        const linesArg = linesIdx >= 0 ? Number(rest[linesIdx + 1]) : NaN;
        const linesBack = Number.isFinite(linesArg) && linesArg >= 0 ? linesArg : 50;
        const runLogs =
          dependencies.runLogs ??
          ((opts: Omit<LogsOptions, "follow" | "signal">) => {
            const ac = new AbortController();
            const onSig = () => ac.abort();
            process.once("SIGINT", onSig);
            return logsCommand(
              { ...opts, follow: true, signal: ac.signal },
              createProductionLogsDeps(),
            ).finally(() => process.removeListener("SIGINT", onSig));
          });
        await runLogs({ logPath: paths.log, moduleFilter, linesBack, writeLine });
        return 0;
      }
      case "update": {
        const paths = fortressPaths(dependencies.fortressRoot);
        const configStore = new FileConfigStore(paths);
        let downloadBaseUrl: string;
        try {
          const config = await configStore.load();
          downloadBaseUrl = downloadBaseFromCloudUrl(config.cloud.url);
        } catch {
          throw new Error(
            "Fortress is not configured. Run `hx-fortress enroll` first.",
          );
        }

        const bar = new ProgressBar();
        const LABEL: Record<UpdateProgress["phase"], string> = {
          download: "Downloading",
          unpack: "Unpacking",
          verify: "Verifying",
        };
        const CRUMB: Record<UpdateProgress["phase"], string> = {
          download: "Downloading hx-fortress…",
          unpack: "Unpacking…",
          verify: "Verifying…",
        };
        const seen = new Set<UpdateProgress["phase"]>();
        let pulseFrame = 0;
        let barClosed = false;
        const onProgress = (ev: UpdateProgress): void => {
          if (seen.size === 0) bar.hideCursor();
          if (!seen.has(ev.phase)) {
            seen.add(ev.phase);
            bar.status(CRUMB[ev.phase]);
          }
          if (ev.phase === "download" && (!ev.total || ev.total <= 0)) {
            bar.pulse(LABEL[ev.phase], pulseFrame++);
          } else {
            bar.draw(ev.pct, LABEL[ev.phase]);
          }
          if (ev.phase === "verify" && ev.pct >= 100) {
            bar.end();
            bar.showCursor();
            barClosed = true;
          }
        };

        const doUpdate = dependencies.runUpdate ?? runFortressUpdate;
        let result: UpdateResult;
        try {
          result = await doUpdate({ downloadBaseUrl, log: writeLine, onProgress });
        } catch (err) {
          if (seen.size > 0 && !barClosed) bar.clearLine();
          throw err;
        } finally {
          bar.showCursor();
        }

        if (result.alreadyLatest) {
          writeLine(
            `hx-fortress is already on the latest version (v${result.localVersion}). Nothing to do. 🎉`,
          );
          return 0;
        }

        const shaNote = result.sha256 ? `, sha256 ${result.sha256.slice(0, 12)}…` : "";
        writeLine(`hx-fortress updated to latest (${result.asset}${shaNote}).`);

        // Restart the service if it was running so the new binary takes over.
        // A restart failure is fatal: the binary is new but modules are still
        // on the old code. Report the state and a concrete next step.
        const manager = (dependencies.getServiceManager ?? getServiceManager)();
        const before = await manager.state();
        if (before.pid !== null) {
          writeLine(
            `restarting Fortress (${manager.name}, was pid ${before.pid})`,
          );
          try {
            await manager.stop();
            const installOpts: ServiceInstallOptions = {
              executablePath: result.installedPath,
              serviceLogPath: paths.serviceLog,
            };
            await manager.install(installOpts);
          } catch (err) {
            const after = await manager.state().catch(() => ({ loaded: false, pid: null }));
            const next =
              after.pid !== null
                ? `the previous version is still running (pid ${after.pid}); run \`hx-fortress stop && hx-fortress start\` to load the new binary.`
                : `Fortress is not running; run \`hx-fortress start\` to launch the new binary.`;
            throw new Error(
              `binary installed at ${result.installedPath}, but Fortress failed to restart: ` +
                `${(err as Error).message}\n${next}`,
              { cause: err },
            );
          }
          writeLine(`Fortress restarted (${manager.name}).`);
        }

        writeLine(`hx-fortress version: ${result.remoteVersion ?? result.localVersion}`);
        return 0;
      }
      case "help":
      case "--help":
        printHelp(writeLine);
        return 0;
      default:
        printHelp(writeLine);
        return 1;
    }
  } catch (error) {
    writeLine(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printHelp(writeLine: (line: string) => void): void {
  writeLine("hx-fortress");
  writeLine("commands: enroll credentials start stop status logs update");
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
