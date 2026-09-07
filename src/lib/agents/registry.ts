/**
 * Central tool registry. Every capability an agent can invoke is registered
 * here once — name, what it does, what it needs, what it returns, whether it
 * only reads or actually changes something — and nothing else in the runtime
 * hand-rolls tool dispatch or validation. An agent's `allowedTools` lists the
 * `requiredPermission` values it may use; the runtime is the only place that
 * checks that list — never the frontend, never the tool itself.
 *
 * zod (already a dependency, unused until now) validates input/output here —
 * the obvious existing tool for "does this untyped call match this shape",
 * not a hand-rolled parser.
 */
import type { ZodType, ZodTypeDef } from 'zod';

export type ToolContext = { workspaceId: string; agentId: string; taskId: string };

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  // Three type params (not the Output-only shorthand) because a schema with
  // .default()s has a raw input type narrower than its parsed output type —
  // we only care that parsing yields TInput/TOutput, not the raw pre-parse shape.
  inputSchema: ZodType<TInput, ZodTypeDef, unknown>;
  outputSchema: ZodType<TOutput, ZodTypeDef, unknown>;
  /** What this tool needs to be present in an agent's allowedTools — usually just `name`, but lets several tools someday share one grant (e.g. "crm:read"). */
  requiredPermission: string;
  /** What kind of thing this tool touches — for the UI and for future per-category limits. Not enforced yet. */
  category: string;
  /** True if calling it twice with the same input has no additional effect (queries, or a real business no-op). */
  readOnly: boolean;
  /** True if a mutating tool is still safe to retry (e.g. it's keyed so a repeat is a no-op). readOnly implies this. */
  idempotent: boolean;
  handler: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
};

const registry = new Map<string, ToolDefinition<unknown, unknown>>();

export function registerTool<I, O>(tool: ToolDefinition<I, O>): void {
  if (registry.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
  registry.set(tool.name, tool as ToolDefinition<unknown, unknown>);
}

export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition<unknown, unknown>[] {
  return [...registry.values()];
}

/** Test-only: lets scripts/tests reset the registry between runs without restarting the process. */
export function _clearRegistryForTests(): void {
  registry.clear();
}
