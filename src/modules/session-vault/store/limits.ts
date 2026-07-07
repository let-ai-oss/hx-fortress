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

// A vault-RPC read RESULT rides ONE tunnel frame as base64 (+ a JSON envelope),
// so it must stay under the peer's frame cap (FORTRESS_MAX_FRAME_BYTES / the hub's
// WebSocket maxPayload) — otherwise the WS layer rejects the message (close 1009)
// and tears down the whole tunnel. Bound the RAW object so base64 (×4/3) + envelope
// fits with headroom, failing fast with a typed reason instead of killing the
// socket. The LOCAL read path (read-events) keeps the larger maxCanonicalBytes
// because it never crosses the tunnel.
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024; // keep in sync with cloud/connection.ts

export function maxTunnelResultBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_FRAME_BYTES);
  const frame = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FRAME_BYTES;
  return Math.floor(frame * 0.7); // reserve ~30% for base64 expansion + JSON envelope
}
