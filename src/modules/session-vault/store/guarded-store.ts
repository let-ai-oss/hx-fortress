// GuardedStore — a SessionStore decorator that gives every storage call a hard
// deadline and rebuilds the inner store (fresh SDK client + HTTP agent pool)
// after consecutive breaches.
//
// Exists because of the 2026-07-30 prod incident: one GCS 500 left the
// client's keep-alive pool holding hung requests; with no per-call deadline
// every later write waited forever behind them, the cloud's 30 s tunnel RPC
// timeout abandoned each call unanswered, and ingest sat at zero for three
// hours while Postgres-backed reads stayed green and this process logged
// nothing. A deadline turns a hung call into a loud, retryable error; the
// rebuild evicts the poisoned pool; together they make the write path
// self-healing instead of restart-dependent.
//
// A losing call cannot be cancelled (the storage SDKs expose no abort seam) —
// it is detached with a swallow-handler and its client discarded by the
// rebuild; its eventual settle is neither observed nor trusted.

import type {
  AppendOptions,
  ComposeResult,
  DeleteSessionOptions,
  DeleteSessionResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
} from "./types.js";
import type { ScopedLogger } from "../../../host/types.js";

export class StoreDeadlineError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`store_deadline_exceeded: ${method} after ${timeoutMs}ms`);
    this.name = "StoreDeadlineError";
  }
}

export interface GuardedStoreOptions {
  /** Deadline for ordinary calls (signing, compose, stat, chunk reads). */
  opTimeoutMs?: number;
  /** Deadline for calls that legitimately move lots of data (whole-canonical
   *  read/write, metadata list, one bounded delete batch). */
  heavyOpTimeoutMs?: number;
  /** Deadline for the whole-bucket key scan — the G reconciler walks every
   *  canonical (12k keys took ~3 minutes on prod). */
  scanTimeoutMs?: number;
  /** Consecutive deadline breaches before the inner store is rebuilt. */
  rebuildAfter?: number;
  logger?: ScopedLogger;
}

export class GuardedStore implements SessionStore {
  private inner: SessionStore;
  private breaches = 0;
  private readonly opTimeoutMs: number;
  private readonly heavyOpTimeoutMs: number;
  private readonly scanTimeoutMs: number;
  private readonly rebuildAfter: number;
  private readonly logger?: ScopedLogger;

  constructor(
    private readonly factory: () => SessionStore,
    opts: GuardedStoreOptions = {},
  ) {
    this.opTimeoutMs = opts.opTimeoutMs ?? 20_000;
    this.heavyOpTimeoutMs = opts.heavyOpTimeoutMs ?? 120_000;
    this.scanTimeoutMs = opts.scanTimeoutMs ?? 600_000;
    this.rebuildAfter = opts.rebuildAfter ?? 3;
    this.logger = opts.logger;
    this.inner = this.factory();
  }

  private async guard<T>(
    method: string,
    timeoutMs: number,
    call: (s: SessionStore) => Promise<T>,
  ): Promise<T> {
    const s = this.inner;
    const attempt = call(s);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StoreDeadlineError(method, timeoutMs)), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      this.breaches = 0;
      return result;
    } catch (err) {
      if (err instanceof StoreDeadlineError) {
        // Detach the hung call: its settle must not become an unhandled
        // rejection, and its result must never be trusted after we gave up.
        attempt.catch(() => {});
        this.breaches += 1;
        this.logger?.error("store call exceeded deadline", {
          method,
          timeoutMs,
          consecutive: this.breaches,
        });
        if (this.breaches >= this.rebuildAfter && this.inner === s) {
          this.inner = this.factory();
          this.breaches = 0;
          this.logger?.error("storage client rebuilt after consecutive deadline breaches", {
            method,
          });
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  signStagingUpload(key: SessionKey, chunkId: string): Promise<SignedUpload> {
    return this.guard("signStagingUpload", this.opTimeoutMs, (s) => s.signStagingUpload(key, chunkId));
  }
  readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    return this.guard("readChunkText", this.heavyOpTimeoutMs, (s) => s.readChunkText(key, chunkId));
  }
  appendChunkToCanonical(key: SessionKey, chunkId: string, opts?: AppendOptions): Promise<ComposeResult> {
    return this.guard("appendChunkToCanonical", this.opTimeoutMs, (s) => s.appendChunkToCanonical(key, chunkId, opts));
  }
  statCanonical(key: SessionKey): Promise<number | null> {
    return this.guard("statCanonical", this.opTimeoutMs, (s) => s.statCanonical(key));
  }
  signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    return this.guard("signCanonicalDownload", this.opTimeoutMs, (s) => s.signCanonicalDownload(key));
  }
  readCanonicalText(key: SessionKey): Promise<string> {
    return this.guard("readCanonicalText", this.heavyOpTimeoutMs, (s) => s.readCanonicalText(key));
  }
  writeCanonicalText(key: SessionKey, text: string): Promise<void> {
    return this.guard("writeCanonicalText", this.heavyOpTimeoutMs, (s) => s.writeCanonicalText(key, text));
  }
  writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    return this.guard("writeArtifact", this.opTimeoutMs, (s) => s.writeArtifact(key, name, text));
  }
  readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    return this.guard("readArtifactText", this.opTimeoutMs, (s) => s.readArtifactText(key, name));
  }
  listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    return this.guard("listSessionMetadata", this.heavyOpTimeoutMs, (s) => s.listSessionMetadata(userId));
  }
  listAllCanonicalKeys(): Promise<SessionKey[]> {
    return this.guard("listAllCanonicalKeys", this.scanTimeoutMs, (s) => s.listAllCanonicalKeys());
  }
  selfTest(): Promise<void> {
    return this.guard("selfTest", this.opTimeoutMs, (s) => s.selfTest());
  }
  deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult> {
    return this.guard("deleteSession", this.heavyOpTimeoutMs, (s) => s.deleteSession(key, opts));
  }
}
