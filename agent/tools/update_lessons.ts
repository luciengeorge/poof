import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

export default defineTool({
  description:
    "Replace your standing 'lessons' note: your durable, self-maintained record of what keeps working and what keeps losing. Call this at the END of each cycle with the FULL rewritten note (not a diff): merge any new insight from this cycle's exits + review_performance, drop stale entries, keep it concise and specific (≤10 bullets). You read this note back at the start of every cycle via recall_memory, so it is how you learn over time. Keep it sharp and actionable, not a diary.",
  inputSchema: z.object({
    lessons: z
      .string()
      .min(1)
      .max(4000)
      .describe("The full, rewritten lessons note (markdown bullets)."),
  }),
  async execute({ lessons }) {
    try {
      await memoryFromEnv().saveLessons(tradingEnv(), lessons);
      return { saved: true };
    } catch (err) {
      console.warn("[memory] saveLessons failed (non-fatal):", err);
      return { saved: false, note: "memory unavailable" };
    }
  },
});
