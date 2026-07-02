// A3 · per-turn secret scrub, applied to user/assistant turn text BEFORE it is
// hashed + sent to OpenAI. Conversational turns can still contain pasted code,
// tokens, or credentials, and embedding is third-party egress (every hosted
// tier, not just sovereign). This is a focused redactor for the high-confidence
// secret shapes — it never blocks the embed, only sanitizes its input. The
// content_hash is taken over the SCRUBBED text so reuse stays consistent.

const REDACTED = "[REDACTED]";

// Each pattern targets a high-signal credential shape; ordered most-specific
// first. Kept deliberately conservative to avoid shredding normal prose.
const PATTERNS: RegExp[] = [
  // PEM private key blocks (multi-line).
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // JWTs (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // OpenAI / Anthropic style keys.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Authorization: Bearer <token>.
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  // key=value assignments for sensitive-looking keys (json or shell style).
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
];

/** Redact high-confidence secret shapes from one turn's text. Returns the text
 *  unchanged when nothing matches (the common case for conversational turns). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
