import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import type { LogsOptions } from "../src/cli-logs";

describe("runCli", () => {
  test("shows public help for unknown commands", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["wat"], {
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toContain("commands: start stop status logs update");
  });

  test("dispatches the internal host command without listing it in help", async () => {
    let ranHost = false;
    const lines: string[] = [];

    const exitCode = await runCli(["host"], {
      runFortressHost: async () => {
        ranHost = true;
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(ranHost).toBe(true);
    expect(lines).toEqual([]);
  });

  test("dispatches logs with module filter and --lines flag", async () => {
    let captured: Omit<LogsOptions, "follow" | "signal"> | undefined;

    const exitCode = await runCli(["logs", "session_vault", "--lines", "20"], {
      runLogs: async (opts) => {
        captured = opts;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(captured?.moduleFilter).toBe("session_vault");
    expect(captured?.linesBack).toBe(20);
  });

  test("dispatches logs with no module filter when none given", async () => {
    let captured: Omit<LogsOptions, "follow" | "signal"> | undefined;

    const exitCode = await runCli(["logs"], {
      runLogs: async (opts) => {
        captured = opts;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(captured?.moduleFilter).toBeUndefined();
    expect(captured?.linesBack).toBe(50);
  });
});
