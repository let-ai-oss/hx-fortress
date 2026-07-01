// One general cap for every MCP tool result, mirroring agent-kit's
// MAX_OUTPUT_CHARS (packages/agent-kit/src/tools/coding.ts). Tools that can
// return many rows ALSO paginate (limit+offset) so callers navigate instead of
// hitting this blunt cap.

/** Hard cap on the character length of any single tool result body. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function capToolOutput(content: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= limit) return content;
  const omitted = content.length - limit;
  return `${content.slice(0, limit)}\n\n[... output truncated: ${omitted} more characters omitted — narrow your query or page with offset ...]`;
}
