import { startFortress, statusFortress, stopFortress } from "./cli-lifecycle";
import {
  createProductionLogsDeps,
  logsCommand,
  type LogsOptions,
} from "./cli-logs";
import { runFortressHost } from "./host/main";
import { fortressPaths } from "./host/paths";
import {
  runEnrollWizard,
  type WizardOpts,
} from "./modules/session-vault/wizard";
import { FileStatusReader } from "./status-reader";
import { getServiceManager } from "./service";

type RunLogs = (options: Omit<LogsOptions, "follow" | "signal">) => Promise<void>;
type RunEnrollWizard = (options: WizardOpts) => Promise<void>;

interface CliDependencies {
  getServiceManager?: typeof getServiceManager;
  runEnrollWizard?: RunEnrollWizard;
  runFortressHost?: typeof runFortressHost;
  runLogs?: RunLogs;
  writeLine?: (line: string) => void;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeLine = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const command = args[0];

  try {
    switch (command) {
      case "enroll": {
        const token = args[1];
        const cloudIdx = args.indexOf("--cloud");
        const cloudUrl = cloudIdx >= 0 ? args[cloudIdx + 1] : undefined;
        if (!token || token.startsWith("--") || !cloudUrl) {
          throw new Error("usage: hx-fortress enroll <token> --cloud <url>");
        }
        await (dependencies.runEnrollWizard ?? runEnrollWizard)({
          token,
          cloudUrl,
          log: writeLine,
        });
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
      case undefined:
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
  writeLine("commands: enroll start stop status logs update");
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
