// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

import type { ProtocolFrame } from "./frames";

export function encodeFrame(frame: ProtocolFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame<T = ProtocolFrame>(data: string): T {
  return JSON.parse(data) as T;
}
