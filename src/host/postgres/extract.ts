import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Spawner } from "./spawn";

export function makeExtractor(
  spawner: Spawner,
): (jarPath: string, destDir: string) => Promise<void> {
  return async (jarPath, destDir) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hx-pg-extract-"));
    try {
      await run(spawner, ["unzip", "-o", jarPath, "-d", tmp]);
      const inner = (await readdir(tmp)).find((f) => f.endsWith(".txz"))
        ?? path.basename(jarPath).replace(/\.jar$/, ".txz");
      await run(spawner, ["tar", "-xJf", path.join(tmp, inner), "-C", destDir]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}

async function run(spawner: Spawner, cmd: string[]): Promise<void> {
  const { code, stderr } = await spawner.run(cmd);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
}
