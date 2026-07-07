// Low · redact connection strings (DSNs) from an error message before it reaches
// a log line, an MCP reply, or a tunnel RPC error surface. A Postgres/driver
// error can echo the DSN it failed to connect with — and a DSN routinely embeds
// `user:password@host`. `scheme://…` up to the next whitespace/quote covers
// postgres://, postgresql://, mysql://, redis://, https:// (a signed URL), etc.

const DSN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Redact every `scheme://…` run from a string. */
export function redactDsns(text: string): string {
  return text.replace(DSN, "[REDACTED_URL]");
}

/** DSN-free message for an unknown thrown value. Use anywhere a DB/driver error
 *  could cross into a log, an agent-visible reply, or an RPC error. */
export function sanitizeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactDsns(msg);
}
