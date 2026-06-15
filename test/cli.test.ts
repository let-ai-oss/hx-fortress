import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";

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
});
