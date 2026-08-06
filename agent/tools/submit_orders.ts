import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute } from "../lib/orders.ts";
import { resolveLimits, isDryRun } from "../lib/state.ts";
import { fxForCycle } from "../lib/fx.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { resolveRiskState, tradingEnv } from "../lib/risk-runtime.ts";
import { finnhubFromEnv } from "../lib/data.ts";
import { t212TickerToFinnhubSymbol } from "../lib/execution.ts";
import { buildRecordTradeArgs } from "../lib/order-bookkeeping.ts";
import { STRATEGY_TAGS } from "../lib/positions.ts";
import {
  externalHoldingSymbols,
  partitionExternalHoldingBuys,
  EXTERNAL_HOLDING_SKIP_REASON,
} from "../lib/external-holdings.ts";

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
  strategyTag: z
    .enum(STRATEGY_TAGS)
    .optional()
    .describe(
      "Strategy type for this trade, from the fixed taxonomy. REQUIRED on every BUY so per-type performance can be tracked. Choose the closest fit: news-catalyst, earnings-play, momentum, mean-reversion, index-event, or other.",
    ),
  confidence: z
    .number()
    .min(0.01)
    .max(0.99)
    .optional()
    .describe(
      "Your honest probability that this BUY makes money, 0.01 to 0.99. REQUIRED on every BUY. It is SCORED against the actual outcome once the position closes, and the measured gap between what you claim and what happens is reported back to you, so inflating it only makes you look miscalibrated later. A genuine 0.55 is more useful than a reflexive 0.8.",
    ),
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
  trailingStopPct: z
    .number()
    .positive()
    .optional()
    .describe(
      "Trailing stop as a fraction below the high-water mark (e.g. 0.08 = sell if it drops 8% from its peak). The primary exit for winners; take-profit is a far backstop.",
    ),
  maxHoldDays: z
    .number()
    .positive()
    .optional()
    .describe("Exit the position after this many days regardless of price"),
});

export default defineTool({
  description:
    "Validate proposed trades against the hard risk limits on the LIVE account, then place the accepted ones as market orders. The risk gate runs INSIDE this tool and is authoritative and cannot be bypassed. BUYs for any ticker held in the user's external advisory account are blocked in code before the gate and reported as skipped: that account is not tradable here, so do not propose those names. Honors DRY_RUN (default on: orders are simulated, not sent). On BUYs, set stopLossPct + trailingStopPct (the trailing stop is the primary exit for winners; leave takeProfitPct as a far backstop, plus maxHoldDays if time-bound). The exit engine enforces them automatically on later cycles. Returns `placed` (with share quantity; `dryRun`/`skipped` flags) and `rejected` (with reasons). Always report both back to the user.",
  inputSchema: z.object({
    proposals: z.array(proposalSchema).min(1).max(10),
  }),
  // Require human approval (Slack) before REAL orders. Only meaningful when actually
  // executing: dry-run/simulated orders never need approval. (eve `approval`: returning
  // true = require user approval, false = not applicable.)
  approval: () =>
    process.env.REQUIRE_APPROVAL === "true" && process.env.DRY_RUN === "false",
  async execute({ proposals }) {
    const client = t212FromEnv();
    const finnhub = finnhubFromEnv();
    const memory = memoryFromEnv();
    const env = tradingEnv();

    // PRE-GATE GUARD: never BUY a name the user holds in the external advisory account.
    // The instructions say so too, but prompts are not a control, so it is enforced here in
    // code. Deliberately OUTSIDE evaluateAndExecute: that function and buildRiskSnapshot are
    // pure functions of broker inputs with no Convex access, which is precisely why an
    // external holding's VALUE can never reach equity or sizing. Only ticker STRINGS cross
    // this boundary; a string cannot be summed into equity.
    let excludedSymbols: ReadonlySet<string> = new Set<string>();
    let blockAllBuys = false;
    try {
      excludedSymbols = externalHoldingSymbols(
        await memory.listExternalHoldings(env),
      );
    } catch (err) {
      // Without the list we cannot tell which names are excluded. On live, open no new
      // exposure (same fail-closed stance resolveRiskState takes on a Convex outage:
      // halt BUYs, allow SELLs). On demo, warn and continue.
      blockAllBuys = env === "live";
      console.warn(
        `[external] holding lookup FAILED${
          blockAllBuys ? " on LIVE; failing closed (skip BUYs, allow SELLs)" : ""
        }:`,
        err,
      );
    }
    const { allowed, blocked } = partitionExternalHoldingBuys(
      proposals,
      excludedSymbols,
      { blockAllBuys },
    );

    const result = await evaluateAndExecute(allowed, {
      client,
      fxRate: (await fxForCycle()).rate,
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

    // Report each blocked BUY as a skip with an explicit reason, mirroring the existing
    // skip-with-reason pattern (precision / pending / duplicate). A skip rather than a throw,
    // so one blocked proposal never aborts the rest of the batch. These are recorded to memory
    // below with status "skipped" (never "placed"), so the guard's activation is auditable and
    // the blocked name never becomes an open position.
    for (const proposal of blocked) {
      result.placed.push({
        proposal,
        quantity: 0,
        dryRun: isDryRun(),
        skipped: EXTERNAL_HOLDING_SKIP_REASON,
      });
    }

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
