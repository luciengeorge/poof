import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { finnhubFromEnv } from "../lib/data.ts";
import { fxForCycle } from "../lib/fx.ts";
import { brokerSnapshotWithFx, reconcileAccountValueGbp } from "../lib/execution.ts";
import { etDateString } from "../lib/clock.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import {
  buildManagedPositions,
  realizedStats,
  realizedStatsByTag,
  type OpenBuyTrade,
} from "../lib/positions.ts";
import { computeAlpha, type Benchmark } from "../lib/benchmark.ts";
import { attributeFailures } from "../lib/attribution.ts";
import { calibrationFrom } from "../lib/calibration.ts";
import { effectiveLevels, DEFAULT_EXITS } from "../lib/exits.ts";

const DAY = 86_400_000;

export default defineTool({
  description:
    "Review how the account is actually doing: open positions with unrealized P&L, their thesis, age, and active exit levels; realized win/loss stats from closed trades; and alpha vs buy-and-hold SPY since inception. Call this EARLY each cycle (after managing exits) so new decisions are informed by what worked and whether you're beating just holding SPY. CURRENCY: accountValueGbp, cashGbp, deployedGbp and each position's marketValue/unrealizedPnl are GBP; each position's entryPrice/currentPrice are share prices in the instrument's own currency (USD for US stocks), NOT GBP. Read-only.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const [account, fx] = await Promise.all([client.getBrokerSnapshot(), fxForCycle()]);
    const brokerSnapshot = brokerSnapshotWithFx(account, fx);
    const fxRate = fx.rate;
    const { cash, positions } = brokerSnapshot;
    const accountValueReconciliation = reconcileAccountValueGbp(brokerSnapshot);
    const equity = accountValueReconciliation.accountValueGbp;

    const memory = memoryFromEnv();
    const env = tradingEnv();
    const [openBuysRaw, recall] = await Promise.all([
      memory.openBuys(env),
      memory.recallRecent(env, { tradeLimit: 50 }),
    ]);
    const openBuys = (openBuysRaw ?? []) as OpenBuyTrade[];
    // Full trade rows, not a narrow projection: attribution needs the entry price, the timestamps
    // and the exit levels to tell a stop-loss exit from a time exit, and calibration needs the
    // confidence claimed at entry. These come straight from Convex, so the fields are present.
    const closedTrades =
      ((recall as { trades?: unknown[] })?.trades ?? []) as {
        ticker: string;
        status: string;
        price: number;
        createdAt: number;
        closedAt?: number;
        pnl?: number;
        strategyTag?: string;
        redTeamVerdict?: string;
        exitPrice?: number;
        stopLossPct?: number;
        maxHoldDays?: number;
        predictedConfidence?: number;
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
    // Per-strategy-type realized stats, so decisions can bias toward tags with positive
    // realized expectancy. Small samples (low closedCount per tag) are noise, not signal.
    const realizedByTag = realizedStatsByTag(closedTrades);

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
      // Authoritative GBP figures. Report these verbatim; never re-sum from stock prices.
      accountValueGbp: equity,
      cashGbp: cash.free,
      deployedGbp: accountValueReconciliation.deployedValueGbp,
      snapshotTakenAt: brokerSnapshot.takenAt,
      fx: { rate: fxRate, source: fx.source, fallbackUsed: fx.source === "fallback" },
      accountValueReconciliation,
      openPositions: managed,
      realized,
      realizedByTag,
      // WHERE the money actually went, across the whole closed record rather than this cycle.
      // A pattern is only reported once it recurs (see agent/lib/attribution.ts): below that
      // threshold nothing is shown, because one or two losses cannot be told apart from variance
      // and inventing a rule from them is how a belief based on noise becomes permanent.
      failurePatterns: attributeFailures(closedTrades),
      // Whether the confidence claimed at entry matches what actually happened. Reported as a
      // number and a named verdict rather than an impression, because language confidence is
      // routinely miscalibrated as probability.
      calibration: calibrationFrom(closedTrades),
      benchmark,
      spyPrice,
      alpha,
    };
  },
});
