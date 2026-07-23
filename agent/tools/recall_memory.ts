import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv, type Env } from "../lib/memory.ts";

export default defineTool({
  description:
    "Recall the agent's durable memory for this account: your standing `lessons` note (what keeps working / losing, apply it), recent trades (with thesis + outcome), recent cycle decisions, recent conversation messages, and the persisted risk state. Call this FIRST each trading cycle so decisions account for history (what you tried, what worked, what the user told you).",
  inputSchema: z.object({
    tradeLimit: z.number().int().min(1).max(50).optional(),
    messageLimit: z.number().int().min(1).max(50).optional(),
  }),
  async execute({ tradeLimit, messageLimit }) {
    const env = (process.env.TRADING212_ENV ?? "demo") as Env;
    try {
      const memory = memoryFromEnv();
      return await memory.recallRecent(env, { tradeLimit, messageLimit });
    } catch (err) {
      // Memory not configured (no CONVEX_URL) or unreachable: don't break the cycle.
      console.warn("[memory] recallRecent failed (non-fatal):", err);
      return {
        cycles: [],
        trades: [],
        messages: [],
        riskState: null,
        note: "memory unavailable",
      };
    }
  },
});
