import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { fortressPaths } from "./paths";
import type { HostStatusSnapshot, StatusStore } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export class FileStatusStore implements StatusStore {
  constructor(private readonly paths: FortressPaths) {}

  async write(snapshot: HostStatusSnapshot): Promise<void> {
    await mkdir(path.dirname(this.paths.status), { recursive: true });
    const temporaryPath = `${this.paths.status}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temporaryPath, this.paths.status);
  }
}
