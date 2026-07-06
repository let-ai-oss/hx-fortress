import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { KeyProof } from "../protocol";
import { verifyKeyProof } from "../host/trust/signing-keys";

/** The persisted signing-key record (H-2). `key` is the org Ed25519 public key
 *  (base64url) the hub pushes; `pinnedAt` is when it was first pinned; `rootVerified`
 *  records whether the pin (or its last accepted rotation) carried a valid root proof. */
export interface PinnedSigningKey {
  key: string;
  pinnedAt: string | null;
  rootVerified: boolean;
}

/** Persists the org Ed25519 public key (base64url) the hub pushes over the
 *  tunnel, so the gateway can verify capability tokens offline across restarts.
 *  H-2: the record is pinned on first sight; a LATER push that changes the key is
 *  rejected unless it carries a valid root proof (see resolveSigningKeyPin). */
export class FileSigningKeyStore {
  constructor(private readonly keyPath: string) {}

  /** The pinned key material (base64url), or null when none is pinned. Reads both
   *  the JSON record and a legacy bare-string file (pre-H-2 installs). */
  async load(): Promise<string | null> {
    return (await this.loadRecord())?.key ?? null;
  }

  /** Alias of load() for call sites that specifically want THE PINNED key (the
   *  verifyGrant closure) — clearer intent at the read site. */
  async pinnedKey(): Promise<string | null> {
    return this.load();
  }

  /** The full pinned record, or null when absent. A legacy bare-string file loads
   *  as an unverified pin (`pinnedAt:null, rootVerified:false`). */
  async loadRecord(): Promise<PinnedSigningKey | null> {
    let raw: string;
    try {
      raw = (await readFile(this.keyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (raw.length === 0) return null;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Partial<PinnedSigningKey>;
        if (typeof parsed.key === "string" && parsed.key.length > 0) {
          return {
            key: parsed.key,
            pinnedAt: typeof parsed.pinnedAt === "string" ? parsed.pinnedAt : null,
            rootVerified: parsed.rootVerified === true,
          };
        }
        return null;
      } catch {
        return null;
      }
    }
    // Legacy bare-string key (pre-H-2): treat as an unverified pin.
    return { key: raw, pinnedAt: null, rootVerified: false };
  }

  /** Atomically persist the pinned record as JSON with 0600 perms. */
  async saveRecord(record: PinnedSigningKey): Promise<void> {
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.keyPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.keyPath);
  }
}

export type KeyPinDecision =
  | { action: "pin"; rootVerified: boolean }
  | { action: "noop" }
  | { action: "replace" }
  | { action: "reject" };

/** Pure pin-floor decision (H-2). `proofValid` is the pre-computed result of
 *  verifying the incoming key's root proof (false when no proof is supplied):
 *   • no pin yet         → PIN it (rootVerified = proofValid; TOFU on upgrade);
 *   • incoming === pin   → NO-OP (a benign re-push of the same key);
 *   • incoming ≠ pin,
 *       proof valid      → REPLACE (an authorized, root-signed rotation);
 *       proof invalid    → REJECT (a silent overwrite — keep the pin). */
export function resolveSigningKeyPin(
  current: PinnedSigningKey | null,
  incomingKey: string,
  proofValid: boolean,
): KeyPinDecision {
  if (!current) return { action: "pin", rootVerified: proofValid };
  if (current.key === incomingKey) return { action: "noop" };
  return proofValid ? { action: "replace" } : { action: "reject" };
}

export interface PersistSigningKeyPinArgs {
  store: Pick<FileSigningKeyStore, "loadRecord" | "saveRecord">;
  orgId: string;
  incomingKey: string;
  keyProof?: KeyProof;
  /** Injectable root-proof verifier (defaults to the baked-anchor verifyKeyProof). */
  verifyProof?: (orgId: string, key: string, proof: KeyProof) => Promise<boolean>;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Apply the H-2 pin-floor to a pushed org signing key and persist the outcome.
 *  Returns the decision taken so callers/tests can assert on it. A rejected key
 *  change leaves the existing pin untouched and logs `signing_key_rotation_rejected`. */
export async function persistSigningKeyPin(args: PersistSigningKeyPinArgs): Promise<KeyPinDecision["action"]> {
  const current = await args.store.loadRecord();
  const verify = args.verifyProof ?? verifyKeyProof;
  const proofValid = args.keyProof ? await verify(args.orgId, args.incomingKey, args.keyProof) : false;
  const decision = resolveSigningKeyPin(current, args.incomingKey, proofValid);
  const now = args.now ?? (() => new Date());
  switch (decision.action) {
    case "pin":
      await args.store.saveRecord({
        key: args.incomingKey,
        pinnedAt: now().toISOString(),
        rootVerified: decision.rootVerified,
      });
      break;
    case "replace":
      await args.store.saveRecord({
        key: args.incomingKey,
        pinnedAt: now().toISOString(),
        rootVerified: true,
      });
      break;
    case "noop":
      break;
    case "reject":
      args.log?.("signing_key_rotation_rejected", { orgId: args.orgId });
      break;
  }
  return decision.action;
}
