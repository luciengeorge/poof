import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { fxRateFromEnv } from "../lib/state.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

export default defineTool({
  description:
    "Log this cycle's decision to durable memory. Call this ONCE at the END of every cycle (whether or not you traded), after posting your report. It records what you decided (trade / no-trade), your one-line reasoning, and the candidates/watchlist you considered, alongside a server-fetched equity and free-cash snapshot. This decision log is how the weekly scorecard counts cycles and how you review your own reasoning over time. It never places orders and is safe to call every cycle.",
  inputSchema: z.object({
    decision: z
      .enum(["trade", "no-trade"])
      .describe('"trade" if you placed at least one order this cycle, otherwise "no-trade".'),
    rationale: z
      .string()
      .min(1)
      .max(2000)
      .describe("One or two sentences: why you traded or held off, and the main theme of the cycle."),
    candidates: z
      .array(z.string())
      .optional()
      .describe("Tickers or theses you seriously considered this cycle."),
    watchlist: z
      .array(z.string())
      .optional()
      .describe("Tickers you are watching for a future cycle."),
  }),
  async execute({ decision, rationale, candidates, watchlist }) {
    try {
      const client = t212FromEnv();
      const fxRate = fxRateFromEnv();
      const [cash, positions] = await Promise.all([
        client.getCash(),
        client.getPortfolio(),
      ]);
      const deployed = positions.reduce(
        (s, p) => s + p.quantity * p.currentPrice * fxRate,
        0,
      );
      await memoryFromEnv().recordCycle({
        env: tradingEnv(),
        equity: cash.free + deployed,
        freeCash: cash.free,
        decision,
        rationale,
        candidates,
        watchlist,
      });
      return { recorded: true };
    } catch (err) {
      console.warn("[memory] recordCycle failed (non-fatal):", err);
      return { recorded: false, note: "memory or broker unavailable" };
    }
  },
});
