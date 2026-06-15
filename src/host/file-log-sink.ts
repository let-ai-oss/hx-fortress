import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogRecord, LogSink } from "./types";

export class FileLogSink implements LogSink {
  private dirReady = false;

  constructor(private readonly logPath: string) {}

  write(record: LogRecord): void {
    if (!this.dirReady) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.dirReady = true;
    }
    appendFileSync(this.logPath, JSON.stringify(record) + "\n");
  }
}
