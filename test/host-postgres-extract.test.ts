import { describe, expect, test } from "bun:test";

import { makeExtractor } from "../src/host/postgres/extract";
import type { Spawner } from "../src/host/postgres/spawn";

describe("extractor", () => {
  test("unzips the inner txz then untars it into destDir", async () => {
    const calls: string[][] = [];
    const spawner: Spawner = {
      run: async (cmd) => {
        calls.push(cmd);
        return { code: 0, stderr: "" };
      },
    };
    await makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0");
    expect(calls[0][0]).toBe("unzip");
    expect(calls.some((c) => c[0] === "tar" && c.includes("-xJf"))).toBe(true);
    expect(calls.some((c) => c.includes("/pg/18.4.0"))).toBe(true);
  });

  test("throws when a command fails", async () => {
    const spawner: Spawner = {
      run: async () => ({ code: 1, stderr: "boom" }),
    };
    await expect(makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0")).rejects.toThrow(/boom/);
  });
});
