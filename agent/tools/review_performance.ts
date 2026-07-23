import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { finnhubFromEnv } from "../lib/data.ts";
import { fxRateFromEnv } from "../lib/state.ts";
import { etDateString } from "../lib/clock.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import {
  buildManagedPositions,
  realizedStats,
  type OpenBuyTrade,
} from "../lib/positions.ts";
import { computeAlpha, type Benchmark } from "../lib/benchmark.ts";
import { effectiveLevels, DEFAULT_EXITS } from "../lib/exits.ts";

const DAY = 86_400_000;

export default defineTool({
  description:
    "Review how the account is actually doing: open positions with unrealized P&L, their thesis, age, and active exit levels; realized win/loss stats from closed trades; and alpha vs buy-and-hold SPY since inception. Call this EARLY each cycle (after managing exits) so new decisions are informed by what worked and whether you're beating just holding SPY. Read-only.",
  inputSchema: z.object({}),
  async execute() {
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
    const equity = cash.free + deployed;

    const memory = memoryFromEnv();
    const env = tradingEnv();
    const [openBuysRaw, recall] = await Promise.all([
      memory.openBuys(env),
      memory.recallRecent(env, { tradeLimit: 50 }),
    ]);
    const openBuys = (openBuysRaw ?? []) as OpenBuyTrade[];
    const closedTrades =
      ((recall as { trades?: unknown[] })?.trades ?? []) as {
        pnl?: number;
        status?: string;
      }[];

    const now = Date.now();
    const managed = buildManagedPositions(positions, openBuys, fxRate).map((m) => {
      const lv = effectiveLevels(m, DEFAULT_EXITS);
      return {
        ticker: m.ticker,
        thesis: m.thesis,
        entryPrice: m.entryPrice,
        currentPrice: m.currentPrice,
        unrealizedPnl: m.unrealizedPnl,
        unrealizedPnlPct:
          m.entryPrice > 0
            ? ((m.currentPrice - m.entryPrice) / m.entryPrice) * 100
            : 0,
        ageDays: m.openedAt ? Math.floor((now - m.openedAt) / DAY) : null,
        stopLossPct: lv.stopLossPct,
        takeProfitPct: lv.takeProfitPct,
        trailingStopPct: lv.trailingStopPct,
        maxHoldDays: lv.maxHoldDays,
      };
    });

    const realized = realizedStats(closedTrades);

    // Benchmark vs SPY. Seed the baseline once (current equity + SPY price at inception).
    let spyPrice: number | null = null;
    let alpha: ReturnType<typeof computeAlpha> | null = null;
    let benchmark = (recall as { benchmark?: Benchmark | null })?.benchmark ?? null;
    try {
      const quote = await finnhubFromEnv().getQuote("SPY");
      spyPrice = quote.price;
      if (!benchmark && spyPrice > 0) {
        await memory.saveBenchmark({
          env,
          inceptionEquity: equity,
          inceptionSpyPrice: spyPrice,
          inceptionDate: etDateString(new Date()),
        });
        benchmark = {
          inceptionEquity: equity,
          inceptionSpyPrice: spyPrice,
          inceptionDate: etDateString(new Date()),
        };
      }
      if (benchmark && spyPrice > 0) {
        alpha = computeAlpha(benchmark, equity, spyPrice);
      }
    } catch (err) {
      console.warn("[benchmark] SPY quote/seed failed (non-fatal):", err);
    }

    return {
      equity,
      freeCash: cash.free,
      openPositions: managed,
      realized,
      benchmark,
      spyPrice,
      alpha,
    };
  },
});
