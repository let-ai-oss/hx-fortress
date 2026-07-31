import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { rotateKeepFromEnv, rotateSizeFromEnv, segmentPath } from "../log-tail";
import type { LogRecord, LogSink } from "./types";

/**
 * The daemon's JSONL log, rotated by size.
 *
 * Rotation is rename-based (`<log>` → `<log>.1`, shifting the rest down) rather
 * than copy-and-truncate: a rename is atomic, so a concurrent writer's
 * `appendFileSync` lands wholly in the old inode or wholly in the new one and
 * no record is torn or lost. The reader side follows by inode for the same
 * reason — see log-tail.ts.
 */
export class FileLogSink implements LogSink {
  private dirReady = false;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    private readonly logPath: string,
    options: { maxBytes?: number; keep?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? rotateSizeFromEnv();
    this.keep = options.keep ?? rotateKeepFromEnv();
  }

  write(record: LogRecord): void {
    if (!this.dirReady) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.dirReady = true;
    }
    this.rotateIfNeeded();
    appendFileSync(this.logPath, JSON.stringify(record) + "\n");
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.logPath).size;
    } catch {
      return; // no file yet — nothing to rotate
    }
    if (size < this.maxBytes) return;
    try {
      const oldest = segmentPath(this.logPath, this.keep);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.keep - 1; i >= 1; i -= 1) {
        const from = segmentPath(this.logPath, i);
        if (existsSync(from)) renameSync(from, segmentPath(this.logPath, i + 1));
      }
      renameSync(this.logPath, segmentPath(this.logPath, 1));
    } catch {
      // A rotation that cannot happen must never stop the daemon logging;
      // the next write simply appends to the oversized file and retries.
    }
  }
}
