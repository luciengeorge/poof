import { defineTool } from "eve/tools";
import { z } from "zod";

import { jevFromEnv } from "../lib/jev.ts";
import { rubricCheck } from "../lib/rubric.ts";
import { STRATEGY_TAGS } from "../lib/positions.ts";

export default defineTool({
  description:
    "Deterministic risk rubric for ONE thesis, run BEFORE red_team. Jev answers three calibrated questions (priced in, catalyst connects to this stock, substance) and the earnings calendar settles the binary-event question in arithmetic; the verdict (keep/shrink/veto) is a fixed rule in code with a numbered reason per trigger. A `veto` drops the thesis. Pass the whole result to red_team, which then rules only on coherence. Does not place trades and cannot bypass the risk gate.",
  inputSchema: z.object({
    ticker: z.string().min(1).describe("Trading 212 ticker, e.g. AAPL_US_EQ"),
    thesis: z.string().min(1),
    strategyTag: z.enum(STRATEGY_TAGS).optional(),
    nextEarningsDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("From get_earnings_calendar, when known"),
    daysUntilEarnings: z.number().int().optional(),
    maxHoldDays: z.number().positive().optional(),
    newsAgeHours: z.number().nonnegative().optional().describe("Age of the underlying story, if known"),
  }),
  async execute(input) {
    const jev = jevFromEnv();
    if (!jev) return { available: false, reason: "TYPESAFE_API_KEY is not set; send the thesis to red_team as before." };
    const nextEarnings =
      input.nextEarningsDate && typeof input.daysUntilEarnings === "number"
        ? { date: input.nextEarningsDate, daysUntil: input.daysUntilEarnings }
        : null;
    const result = await rubricCheck(jev, {
      ticker: input.ticker,
      thesis: input.thesis,
      strategyTag: input.strategyTag,
      nextEarnings,
      maxHoldDays: input.maxHoldDays,
      newsAgeHours: input.newsAgeHours,
    });
    if (!result) return { available: false, reason: "Jev was unavailable; send the thesis to red_team as before." };
    return { available: true, ...result };
  },
});
