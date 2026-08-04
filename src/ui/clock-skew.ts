// runtime/clock-skew.json — the last measured offset between this host's clock
// and the one that minted a console grant.
//
// It exists because the failure it describes is invisible from here: a fortress
// whose clock has drifted rejects every one-click hand-off with a page the
// OPERATOR never sees, because the person who sees it is in the workbench. The
// console's Posture panel reads this file and says what is wrong with the host.
//
// Written ONLY when the clock is why a grant failed. A file that were always
// present would drive a warning that is always on, which is a warning nobody
// reads.

import path from "node:path";

import { writePrivateJson } from "../host/private-json";
import { CONSOLE_GRANT_SKEW_SECONDS } from "./sso-grant";

export interface ClockSkewRecord {
  offsetSeconds: number;
  allowedSeconds: number;
  measuredAt: string;
}

export function clockSkewPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "clock-skew.json");
}

export async function writeClockSkew(
  runtimeRoot: string,
  offsetSeconds: number,
  now: Date = new Date(),
): Promise<ClockSkewRecord> {
  const record: ClockSkewRecord = {
    offsetSeconds: Math.round(offsetSeconds),
    allowedSeconds: CONSOLE_GRANT_SKEW_SECONDS,
    measuredAt: now.toISOString(),
  };
  await writePrivateJson(clockSkewPath(runtimeRoot), record);
  return record;
}
