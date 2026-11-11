import type { ToolDefinition } from "eve/tools";

interface CallerContext {
  session?: { auth: { current?: { attributes?: Record<string, unknown> } | null } };
}
export function isAmbient(ctx: CallerContext | undefined): boolean {
  return ctx?.session?.auth.current?.attributes?.poofAmbient === "true";
}
// Deliberately excludes recall_memory (expires memories), review_performance (writes
// account state), execution, grading writes, delegation and arbitrary sandbox access.
export const AMBIENT_TOOLS = new Set(["get_funnel", "get_prices", "get_earnings_calendar", "account_snapshot", "no_reply"]);
export function withAmbientReadOnly<I, O>(name: string, tool: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return { ...tool, execute(input, ctx) {
    if (isAmbient(ctx) && !AMBIENT_TOOLS.has(name)) throw new Error("Ambient conversation cannot use this tool");
    return tool.execute(input, ctx);
  } };
}
