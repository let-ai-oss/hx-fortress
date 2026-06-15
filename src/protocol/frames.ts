// VENDORED: Temporary local copy of the future @let-ai/hx-protocol package.
// See VENDORED.md before modifying this file.

import type { FortressIdentity } from "./identity";
import type { MsgData, MsgReply } from "./messages";

export type FortressToHubFrame =
  | ({ t: "enroll"; enrollToken: string } & FortressIdentity)
  | ({ t: "hello"; fortressId: string; credential: string } & FortressIdentity)
  | { t: "heartbeat" }
  | { t: "moduleReply"; id: string; reply: MsgReply }
  | { t: "moduleInstallResult"; moduleId: string; version: string; ok: true }
  | { t: "moduleInstallResult"; moduleId: string; version: string; ok: false; error: string }
  | { t: "moduleRemoveResult"; moduleId: string; ok: true }
  | { t: "moduleRemoveResult"; moduleId: string; ok: false; error: string };

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
  | { t: "fatal"; reason: string }
  | {
      t: "moduleAdvertise";
      moduleId: string;
      version: string;
      artifactUrl: string;
      checksum: string;
    }
  | { t: "moduleRemove"; moduleId: string };

export type ProtocolFrame = FortressToHubFrame | HubToFortressFrame;
