import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv } from "../lib/data.ts";
import { fxForCycle } from "../lib/fx.ts";
import { etDateString } from "../lib/clock.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import { nextEarnings } from "../lib/earnings.ts";
import {
  valueExternalHolding,
  daysUntilEarnings,
} from "../lib/external-holdings.ts";

const DAY = 86_400_000;

export default defineTool({
  description:
    "READ-ONLY advisory view of holdings the user owns in a SEPARATE, EXTERNAL brokerage account. " +
    "THE AGENT CANNOT TRADE THESE: there is no broker API for that account, so never propose or " +
    "submit an order for one of these tickers and never treat them as sellable by you. " +
    "These holdings MUST NOT be included in account equity, buying power, or position sizing: " +
    "accountValueGbp from get_account/review_performance remains the ONLY account value, and one " +
    "external holding can be many multiples of it. Your job here is advice only: what you would do " +
    "and why, for the user to act on manually. Returns, per holding: shares, accountLabel, GBP " +
    "value/cost/unrealised P&L, the live share price and the break-even price in the instrument's " +
    "own currency (USD for US stocks), the stored intent, whether the account is taxable, any " +
    "target price, the next earnings date and days until it, plus the fx block. " +
    "CURRENCY: valueGbp/costBasisGbp/unrealisedPnlGbp are GBP (write with the GBP sign); " +
    "priceInstrumentCcy/breakEvenPriceInstrumentCcy/targetPriceUsd are share prices in the " +
    "instrument's own currency (write with $). Never places orders.",
  inputSchema: z.object({}),
  async execute() {
    const env = tradingEnv();
    const memory = memoryFromEnv();
    const holdings = await memory.listExternalHoldings(env);
    const today = etDateString(new Date());

    if (holdings.length === 0) {
      return { today, holdings: [], fx: null, tradable: false };
    }

    const fx = await fxForCycle();
    const finnhub = finnhubFromEnv();
    const to = etDateString(new Date(Date.now() + 90 * DAY)); // Finnhub max window

    const priced = await Promise.all(
      holdings.map(async (h) => {
        const base = {
          ticker: h.ticker,
          shares: h.shares,
          accountLabel: h.accountLabel ?? null,
          currency: h.currency,
          costBasisGbp: h.costBasisGbp,
          intent: h.intent,
          taxable: h.taxable,
          targetPriceUsd: h.targetPriceUsd ?? null,
          notes: h.notes ?? null,
          // Restated on every row so it cannot be lost between the tool and the report.
          tradableByAgent: false,
        };

        let quotePrice: number | null = null;
        try {
          const quote = await finnhub.getQuote(h.ticker);
          quotePrice = quote.price > 0 ? quote.price : null;
        } catch (err) {
          console.warn(`[external] ${h.ticker} quote failed (non-fatal):`, err);
        }

        // Earnings is advisory context, never fatal: a failed lookup must not hide the holding.
        let earningsDate: string | null = null;
        let earningsHour: string | null = null;
        try {
          const events = await finnhub.getEarningsCalendar(h.ticker, today, to);
          const next = nextEarnings(events, today);
          earningsDate = next?.date ?? null;
          earningsHour = next?.hour ?? null;
        } catch (err) {
          console.warn(
            `[external] ${h.ticker} earnings lookup failed (non-fatal):`,
            err,
          );
        }

        if (quotePrice === null) {
          return {
            ...base,
            priceInstrumentCcy: null,
            valueInstrumentCcy: null,
            valueGbp: null,
            unrealisedPnlGbp: null,
            unrealisedPnlPct: null,
            breakEvenPriceInstrumentCcy: null,
            nextEarningsDate: earningsDate,
            nextEarningsHour: earningsHour,
            daysUntilEarnings: daysUntilEarnings(earningsDate, today),
            error: "live quote unavailable",
          };
        }

        const v = valueExternalHolding({
          shares: h.shares,
          costBasisGbp: h.costBasisGbp,
          livePriceInstrumentCcy: quotePrice,
          fxRate: fx.rate,
        });

        return {
          ...base,
          priceInstrumentCcy: quotePrice,
          valueInstrumentCcy: v.valueInstrumentCcy,
          valueGbp: v.valueGbp,
          unrealisedPnlGbp: v.unrealisedPnlGbp,
          unrealisedPnlPct: v.unrealisedPnlPct,
          breakEvenPriceInstrumentCcy: v.breakEvenPriceInstrumentCcy,
          nextEarningsDate: earningsDate,
          nextEarningsHour: earningsHour,
          daysUntilEarnings: daysUntilEarnings(earningsDate, today),
        };
      }),
    );

    return {
      today,
      // Advisory only. Not part of the trading account: excluded from equity and sizing.
      tradable: false,
      holdings: priced,
      fx: {
        rate: fx.rate,
        source: fx.source,
        fallbackUsed: fx.source === "fallback",
      },
    };
  },
});
