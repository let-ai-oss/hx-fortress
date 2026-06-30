import { z } from "zod";
import type { HxDb } from "../host/postgres/db";

export interface HxToolContext {
  db: HxDb | null;
  /** Acting user's external id (hx_users.external_id). */
  userId: string;
}

export interface HxToolResult {
  content: string;
  isError?: boolean;
}

export interface HxTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(rawArgs: unknown, ctx: HxToolContext): Promise<HxToolResult>;
}

export function defineTool<A>(spec: {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  execute: (args: A, ctx: HxToolContext) => Promise<HxToolResult>;
}): HxTool {
  // zod v4: z.toJSONSchema. Concrete-type cast at the SDK boundary is allowed.
  const inputSchema = z.toJSONSchema(spec.schema) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    async run(rawArgs, ctx) {
      const parsed = spec.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { content: `Invalid arguments: ${detail}`, isError: true };
      }
      return spec.execute(parsed.data, ctx);
    },
  };
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class HxToolRegistry {
  private readonly byName = new Map<string, HxTool>();

  constructor(tools: HxTool[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) {
        throw new Error(`Duplicate hx tool name: ${tool.name}`);
      }
      this.byName.set(tool.name, tool);
    }
  }

  list(): McpToolDef[] {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  get(name: string): HxTool | undefined {
    return this.byName.get(name);
  }
}
