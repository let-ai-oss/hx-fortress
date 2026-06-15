import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { LogRecord } from "./host/types";

export interface LogsDependencies {
  readLines(path: string, n: number): Promise<LogRecord[]>;
  watchLines(
    path: string,
    onLine: (r: LogRecord) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface LogsOptions {
  logPath: string;
  moduleFilter: string | undefined;
  linesBack: number;
  follow: boolean;
  writeLine: (line: string) => void;
  signal?: AbortSignal;
}

export function formatRecord(record: LogRecord): string {
  let line = `${record.ts} [${record.module}] ${record.level} ${record.msg}`;
  if (record.fields) {
    const pairs = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    if (pairs) line += ` ${pairs}`;
  }
  return line;
}

export async function logsCommand(
  options: LogsOptions,
  deps: LogsDependencies,
): Promise<void> {
  const { logPath, moduleFilter, linesBack, follow, writeLine } = options;

  const records = await deps.readLines(logPath, linesBack);
  for (const record of records) {
    if (moduleFilter === undefined || record.module === moduleFilter) {
      writeLine(formatRecord(record));
    }
  }

  if (!follow) return;

  let signal = options.signal;
  let cleanup: (() => void) | undefined;

  if (!signal) {
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.once("SIGINT", onSig);
    signal = ac.signal;
    cleanup = () => process.removeListener("SIGINT", onSig);
  }

  try {
    await deps.watchLines(
      logPath,
      (r) => {
        if (moduleFilter === undefined || r.module === moduleFilter) {
          writeLine(formatRecord(r));
        }
      },
      signal,
    );
  } finally {
    cleanup?.();
  }
}

function parseRecord(line: string): LogRecord | undefined {
  try {
    return JSON.parse(line) as LogRecord;
  } catch {
    return undefined;
  }
}

export function createProductionLogsDeps(): LogsDependencies {
  return {
    async readLines(path: string, n: number): Promise<LogRecord[]> {
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const lines = content.split("\n").filter(Boolean);
      return lines.slice(-n).flatMap((line) => {
        const record = parseRecord(line);
        return record ? [record] : [];
      });
    },

    async watchLines(
      path: string,
      onLine: (r: LogRecord) => void,
      signal: AbortSignal,
    ): Promise<void> {
      if (signal.aborted) return;

      const proc = spawn("tail", ["-n", "0", "-f", path], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        const record = parseRecord(line);
        if (record) onLine(record);
      });

      await new Promise<void>((resolve) => {
        const abort = () => {
          proc.kill("SIGINT");
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        proc.once("exit", () => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });

      rl.close();
    },
  };
}
