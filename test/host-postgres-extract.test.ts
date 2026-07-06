import { describe, expect, test } from "bun:test";
import path from "node:path";

import { makeExtractor, makeTarGzExtractor } from "../src/host/postgres/extract";
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
        // The audit passes (outer-jar unzip -Z1/-Z, inner tar -tv…/-t…) must return a
        // benign NON-EMPTY member listing, or the fail-closed empty-listing guard
        // rejects the archive. Extraction (unzip -o, tar -xJf) returns no stdout.
        if (base(cmd) === "unzip" && cmd.includes("-Z1")) {
          return { code: 0, stdout: "postgres/pg.txz\n", stderr: "" };
        }
        if (base(cmd) === "unzip" && cmd.includes("-Z")) {
          return { code: 0, stdout: "-rw-r--r--  2.0 unx 100 tx defN 26-Jan-01 12:00 postgres/pg.txz\n", stderr: "" };
        }
        if (base(cmd) === "tar" && cmd.some((a) => a.startsWith("-tv"))) {
          return { code: 0, stdout: "-rw-r--r-- 0/0 100 2026-01-01 12:00 lib/vector.so\n", stderr: "" };
        }
        if (base(cmd) === "tar" && cmd.some((a) => a.startsWith("-t"))) {
          return { code: 0, stdout: "lib/vector.so\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0");
    // The outer-jar audit (unzip -Z1) runs first, before the unzip extraction.
    expect(base(calls[0])).toBe("unzip");
    expect(calls.some((c) => base(c) === "unzip" && c.includes("-Z1"))).toBe(true);
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

  test("rejects an outer jar with a path-escape member (before unzip runs)", async () => {
    const calls: string[][] = [];
    const spawner: Spawner = {
      run: async (cmd) => {
        calls.push(cmd);
        if (base(cmd) === "unzip" && cmd.includes("-Z1")) {
          return { code: 0, stdout: "../../etc/evil\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0")).rejects.toThrow(
      /parent-dir escape|absolute path/,
    );
    // The audit fired before any extraction (unzip -o never ran).
    expect(calls.some((c) => c.includes("-o"))).toBe(false);
  });

  test("rejects an outer jar with a symlink member", async () => {
    const spawner: Spawner = {
      run: async (cmd) => {
        if (base(cmd) === "unzip" && cmd.includes("-Z1")) {
          return { code: 0, stdout: "postgres/link\n", stderr: "" };
        }
        if (base(cmd) === "unzip" && cmd.includes("-Z")) {
          return { code: 0, stdout: "lrwxrwxrwx 2.0 unx 8 tx 26-Jan-01 12:00 postgres/link -> /etc/passwd\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(makeExtractor(spawner)("/cache/pg.jar", "/pg/18.4.0")).rejects.toThrow(/symlink/);
  });

  // Fail-closed archive audit (security caps): an empty listing means the audit
  // inspected nothing, and a device/FIFO member is never part of a code artifact.
  test("rejects an archive whose listing is empty (fail-closed, unaudited)", async () => {
    const spawner: Spawner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    await expect(makeTarGzExtractor(spawner)("/cache/pgvector.tar.gz", "/pg/ext")).rejects.toThrow(
      /listing is empty/,
    );
  });

  test("rejects a device/FIFO member in the archive", async () => {
    const spawner: Spawner = {
      run: async (cmd) => {
        if (cmd.some((a) => a.startsWith("-tv"))) {
          return { code: 0, stdout: "crw-r--r-- 0/0 1,3 2026-01-01 12:00 dev/null\n", stderr: "" };
        }
        if (cmd.some((a) => a.startsWith("-t"))) {
          return { code: 0, stdout: "dev/null\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(makeTarGzExtractor(spawner)("/cache/pgvector.tar.gz", "/pg/ext")).rejects.toThrow(
      /device|fifo|symlink/i,
    );
  });
});
