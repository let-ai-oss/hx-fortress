// One general cap for every MCP tool result, mirroring agent-kit's
// MAX_OUTPUT_CHARS (packages/agent-kit/src/tools/coding.ts). Tools that can
// return many rows ALSO paginate (limit+offset) so callers navigate instead of
// hitting this blunt cap.

/** Hard cap on the character length of any single tool result body. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function capToolOutput(content: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= limit) return content;
  // The callers (ok/err) serialize JSON, so a char-truncation would produce
  // UNPARSABLE JSON (a half-object → the client's JSON.parse fails →
  // "fortress_response_unparsable"). Return a VALID JSON error instead, so the
  // caller reads a clear "narrow or page" signal. read_events budget-bounds its
  // own output; this is the safety net for the other tools.
  return JSON.stringify({
    error: "output_too_large",
    bytes: content.length,
    limit,
    hint: "Result exceeds the tool-output limit — narrow the query (smaller k/limit/maxEvents, a filterType, or a date range) or page with fromIndex/cursor.",
  });
}
