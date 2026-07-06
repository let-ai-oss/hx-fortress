// M-9c · a whole-object canonical read materializes the full session transcript
// in memory (base64 over the tunnel, or parsed locally). Cap it so one
// pathological session can't OOM the fortress; a read above the cap fails-fast
// with a typed reason the caller maps to a user-facing "session too large".
// Override via FORTRESS_MAX_CANONICAL_BYTES.

const DEFAULT_MAX_CANONICAL_BYTES = 64 * 1024 * 1024; // 64 MiB

export function maxCanonicalBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_CANONICAL_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CANONICAL_BYTES;
}
