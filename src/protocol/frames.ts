// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

import type { FortressIdentity } from "./identity";
import type { MsgData, MsgReply } from "./messages";

export type FortressToHubFrame =
  | ({ t: "enroll"; enrollToken: string } & FortressIdentity)
  | ({ t: "hello"; fortressId: string; credential: string } & FortressIdentity)
  | { t: "heartbeat" }
  | { t: "moduleReply"; id: string; reply: MsgReply };

export type HubToFortressFrame =
  | { t: "welcome"; orgId: string; protocolVersion: number }
  | {
      t: "enrolled";
      orgId: string;
      fortressId: string;
      credential: string;
      protocolVersion: number;
    }
  | { t: "moduleMessage"; data: MsgData }
  | { t: "heartbeatAck" }
  | { t: "fatal"; reason: string };

export type ProtocolFrame = FortressToHubFrame | HubToFortressFrame;
