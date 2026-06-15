import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import type { LogsOptions } from "../src/cli-logs";
import type { WizardOpts } from "../src/modules/session-vault/wizard";

describe("runCli", () => {
  test("shows public help for unknown commands", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["wat"], {
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toContain("commands: enroll start stop status logs update");
  });

  test("dispatches enroll with the token and cloud URL", async () => {
    let captured: WizardOpts | undefined;
    const lines: string[] = [];

    const exitCode = await runCli(
      ["enroll", "vlt_test", "--cloud", "wss://let.ai/_api/hx-gateway/vault-tunnel"],
      {
        runEnrollWizard: async (opts) => {
          captured = opts;
        },
        writeLine: (line) => lines.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(captured?.token).toBe("vlt_test");
    expect(captured?.cloudUrl).toBe("wss://let.ai/_api/hx-gateway/vault-tunnel");
    captured?.log("wizard output");
    expect(lines).toEqual(["wizard output"]);
  });

  test("rejects enroll without a token", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["enroll", "--cloud", "wss://let.ai/tunnel"], {
      runEnrollWizard: async () => {
        throw new Error("wizard should not run");
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toEqual(["error: usage: hx-fortress enroll <token> --cloud <url>"]);
  });

  test("rejects enroll without a cloud URL", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["enroll", "vlt_test"], {
      runEnrollWizard: async () => {
        throw new Error("wizard should not run");
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toEqual(["error: usage: hx-fortress enroll <token> --cloud <url>"]);
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
