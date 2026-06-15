// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

export interface MsgData {
  module: string;
  id: string;
  kind: "request" | "event";
  payload: unknown;
}

export type MsgReply =
  | { ok: true; payload: unknown }
  | { ok: false; error: string };
