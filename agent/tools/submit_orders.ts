import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute } from "../lib/orders.ts";
import { resolveLimits, fxRateFromEnv, isDryRun } from "../lib/state.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { resolveRiskState, tradingEnv } from "../lib/risk-runtime.ts";
import { finnhubFromEnv } from "../lib/data.ts";
import { t212TickerToFinnhubSymbol } from "../lib/execution.ts";
import { buildRecordTradeArgs } from "../lib/order-bookkeeping.ts";

const proposalSchema = z.object({
  ticker: z.string().min(1).describe("Trading 212 instrument ticker, e.g. AAPL_US_EQ"),
  side: z.enum(["BUY", "SELL"]),
  notional: z
    .number()
    .positive()
    .describe("Positive amount to trade, in account currency (GBP)"),
  price: z.number().positive().describe("Current share price in USD (from get_prices)"),
  thesis: z
    .string()
    .min(1)
    .describe("One-line reason for the trade (recorded to memory with the trade)"),
  redTeamVerdict: z
    .string()
    .optional()
    .describe("The red_team subagent's verdict on this thesis, if reviewed"),
  // Exit plan, set on BUYs. Stop-loss/take-profit are fractions of entry price
  // (e.g. 0.1 = 10%). The exit engine clamps to sane bounds and applies defaults if omitted.
  stopLossPct: z
    .number()
    .positive()
    .optional()
    .describe("Stop-loss as a fraction of entry price (e.g. 0.1 = sell if down 10%)"),
  takeProfitPct: z
    .number()
    .positive()
    .optional()
    .describe("Take-profit as a fraction of entry price (e.g. 0.2 = sell if up 20%)"),
  maxHoldDays: z
    .number()
    .positive()
    .optional()
    .describe("Exit the position after this many days regardless of price"),
});

export default defineTool({
  description:
    "Validate proposed trades against the hard risk limits on the LIVE account, then place the accepted ones as market orders. The risk gate runs INSIDE this tool and is authoritative — it cannot be bypassed. Honors DRY_RUN (default on: orders are simulated, not sent). On BUYs, set stopLossPct/takeProfitPct (and optionally maxHoldDays) — the exit engine enforces them automatically on later cycles. Returns `placed` (with share quantity; `dryRun`/`skipped` flags) and `rejected` (with reasons). Always report both back to the user.",
  inputSchema: z.object({
    proposals: z.array(proposalSchema).min(1).max(10),
  }),
  // Require human approval (Slack) before REAL orders. Only meaningful when actually
  // executing — dry-run/simulated orders never need approval. (eve `approval`: returning
  // true = require user approval, false = not applicable.)
  approval: () =>
    process.env.REQUIRE_APPROVAL === "true" && process.env.DRY_RUN === "false",
  async execute({ proposals }) {
    const client = t212FromEnv();
    const finnhub = finnhubFromEnv();
    const memory = memoryFromEnv();
    const result = await evaluateAndExecute(proposals, {
      client,
      fxRate: fxRateFromEnv(),
      dryRun: isDryRun(),
      resolveRiskState,
      resolvePrice: async (ticker) => {
        const symbol = t212TickerToFinnhubSymbol(ticker);
        if (!symbol) {
          throw new Error(`cannot map ticker ${ticker} to a Finnhub symbol`);
        }
        return (await finnhub.getQuote(symbol)).price;
      },
      limits: resolveLimits(),
      hasOrderIntent: (key) => memory.hasOrderIntent(tradingEnv(), key),
      recordOrderIntent: async (key) => {
        await memory.recordOrderIntent(tradingEnv(), key);
      },
    });

    // Record every placed/simulated trade to durable memory. Best-effort:
    // a memory failure must never break trading.
    try {
      const args = buildRecordTradeArgs(result.placed, tradingEnv());
      await Promise.all(args.map((a) => memory.recordTrade(a)));
    } catch (err) {
      console.warn("[memory] recordTrade failed (non-fatal):", err);
    }

    return result;
  },
});
