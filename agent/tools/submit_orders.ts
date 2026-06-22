import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute } from "../lib/orders.ts";
import { loadRiskState, fxRateFromEnv, isDryRun } from "../lib/state.ts";

const proposalSchema = z.object({
  ticker: z.string().min(1).describe("Trading 212 instrument ticker, e.g. AAPL_US_EQ"),
  side: z.enum(["BUY", "SELL"]),
  notional: z
    .number()
    .positive()
    .describe("Positive amount to trade, in account currency (GBP)"),
  price: z.number().positive().describe("Current share price in USD (from get_prices)"),
});

export default defineTool({
  description:
    "Validate proposed trades against the hard risk limits on the LIVE account, then place the accepted ones as market orders. The risk gate runs INSIDE this tool and is authoritative — it cannot be bypassed. Honors DRY_RUN (default on: orders are simulated, not sent). Returns `placed` (with share quantity; `dryRun`/`skipped` flags) and `rejected` (with reasons). Always report both back to the user.",
  inputSchema: z.object({
    proposals: z.array(proposalSchema).min(1).max(10),
  }),
  async execute({ proposals }) {
    const client = t212FromEnv();
    return evaluateAndExecute(proposals, {
      client,
      fxRate: fxRateFromEnv(),
      dryRun: isDryRun(),
      riskState: loadRiskState(),
    });
  },
});
