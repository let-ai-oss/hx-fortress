import { describe, expect, test } from "bun:test";
import path from "node:path";

import { makeExtractor } from "../src/host/postgres/extract";
import type { Spawner } from "../src/host/postgres/spawn";

// tar/unzip are invoked by absolute path (Bun.which) with a bare-name fallback,
// so assert on the basename to stay robust across machines.
const base = (cmd: string[]): string => path.basename(cmd[0] ?? "");

describe("extractor", () => {
  test("audits then unzips the inner txz then untars it into destDir", async () => {
    const calls: string[][] = [];
    const spawner: Spawner = {
      run: async (cmd) => {
        calls.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0");
    expect(base(calls[0])).toBe("unzip");
    // a read-only audit pass (tar -tv…) runs before the extraction
    expect(calls.some((c) => base(c) === "tar" && c.some((a) => a.startsWith("-tv")))).toBe(true);
    expect(calls.some((c) => base(c) === "tar" && c.includes("-xJf"))).toBe(true);
    expect(calls.some((c) => c.includes("/pg/18.4.0"))).toBe(true);
  });

  test("throws when a command fails", async () => {
    const spawner: Spawner = {
      run: async () => ({ code: 1, stderr: "boom" }),
    };
    await expect(makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0")).rejects.toThrow(/boom/);
  });
});
