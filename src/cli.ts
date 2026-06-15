import { startFortress, statusFortress, stopFortress } from "./cli-lifecycle";
import { runFortressHost } from "./host/main";
import { fortressPaths } from "./host/paths";
import { FileStatusReader } from "./status-reader";
import { getServiceManager } from "./service";

interface CliDependencies {
  getServiceManager?: typeof getServiceManager;
  runFortressHost?: typeof runFortressHost;
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
  writeLine("commands: start stop status logs update");
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
