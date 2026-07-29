import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  EVAL_WINDOW_DAYS,
  aggregateEvalHealth,
  formatEvalHealth,
  withinWindow,
} from "../lib/eval-health.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

/**
 * ONLINE EVALS: the weekly READ PATH. Violations already alert immediately, but nothing
 * surfaced the aggregate, so the most dangerous state was invisible: a guard that has quietly
 * stopped being reached. An online eval nobody reads is not an online eval.
 *
 * The wording lives in the pure, tested `formatEvalHealth` (agent/lib/eval-health.ts) rather
 * than in a prompt, so the vacuity sentence cannot be softened by paraphrase. `lines` is meant
 * to be posted verbatim.
 *
 * Read-only, OBSERVER ONLY: never an input to the risk gate, sizing, or order placement.
 */

/** Bound on the traces scanned: `recentCycleTraces` caps at 50 anyway. */
const SCAN_LIMIT = 50;

export default defineTool({
  description:
    "ONLINE EVALS: the eval-health section for the weekly scorecard. Aggregates the recent " +
    "production cycle traces into per-invariant pass / fail / not-applicable counts (so the " +
    "VACUITY RATE is explicit and a guard that was never exercised is not mistaken for one that " +
    "is working), any invariant violations with their tool sequence, the report-quality judge " +
    "scores and trend, and any truncated, unfinished or unjudged cycles. Call it AFTER the judge " +
    "pass so this week's verdicts are included. Post its `lines` VERBATIM: the wording is " +
    "deliberate. Read-only, observe-only: no effect on trading.",
  inputSchema: z.object({
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe(`how far back to look (default ${EVAL_WINDOW_DAYS})`),
  }),
  async execute({ windowDays }) {
    const env = tradingEnv();
    const days = windowDays ?? EVAL_WINDOW_DAYS;
    const traces = await memoryFromEnv().recentCycleTraces(env, SCAN_LIMIT);
    const health = aggregateEvalHealth(withinWindow(traces, Date.now(), days));
    return { env, windowDays: days, ...health, lines: formatEvalHealth(health) };
  },
});
