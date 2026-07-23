/**
 * OFFLINE, READ-ONLY momentum study. Measures whether a systematic cross-sectional momentum
 * strategy has positive net-of-cost alpha over a fixed US large-cap universe, to inform a
 * human go/no-go decision. It may hit Tiingo for historical candles; it NEVER touches Convex
 * or the broker, and it ships NOTHING to the live trading cycle.
 *
 * What it runs, all through the existing pure runBacktest engine + standard cost model:
 *   Strategy A: every ~21 trading days, rank the universe by trailing 12-1 momentum and enter
 *               the top 5. Positions exit via the existing checkExits.
 *   Strategy B: same as A, but only enter names that also pass the 200-day trend filter.
 *   Baseline  : buy-and-hold SPY over the same window.
 *   Max-hold sweep: Strategy A re-run across maxHoldDays in {5,10,21,42,63}.
 *
 * APPROXIMATION CAVEATS (important when reading the results):
 *   - runBacktest v1 has no "exit on rank-drop". A periodic rebalance is APPROXIMATED by
 *     letting positions time out via checkExits' maxHoldDays. A name that stays top-5 is not
 *     rolled seamlessly; it exits on max-hold and can only re-enter at the next rebalance.
 *   - The rebalance cadence is counted in TRADING days (21), while checkExits' maxHoldDays is
 *     counted in CALENDAR days. So a maxHoldDays of 21 (calendar) empties positions a little
 *     before the next 21-trading-day (~30 calendar day) rebalance, leaving brief cash gaps.
 *   - Exits also include the production stop-loss and trailing-stop from DEFAULT_EXITS, so a
 *     name can leave before max-hold. This mirrors the live exit stack rather than a pure
 *     "hold exactly until rebalance" rule.
 *
 * Env: reads TIINGO_API_KEY from the environment. The key is never printed. On a Tiingo
 * auth/tier/rate error the exact status + body (without the key) is reported and the run stops.
 */
import { subYears, format } from "date-fns";
import type { Candle } from "../agent/lib/data.ts";
import { tiingoFromEnv, TiingoError } from "../agent/lib/tiingo.ts";
import { runBacktest, type Signal, type BacktestConfig } from "../agent/lib/backtest.ts";
import { DEFAULT_EXITS } from "../agent/lib/exits.ts";
import { rankMomentum, aboveTrend, DEFAULT_MOMENTUM_CONFIG } from "../agent/lib/momentum.ts";

// ISA-eligible US single-stock universe (large-cap, liquid, NO ETFs).
const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "JPM", "V", "MA", "UNH",
  "HD", "PG", "JNJ", "XOM", "CVX", "COP", "LLY", "AVGO", "COST", "WMT",
];
const SPY = "SPY";

const STARTING_EQUITY = 100_000;
const TOP_N = 5;
const DEFAULT_NOTIONAL = STARTING_EQUITY * 0.2; // ~equal weight across the 5 slots
const REBALANCE_EVERY_SESSIONS = 21; // trading days between rebalances (see caveats)
const YEARS = 5;
const MAX_HOLD_SWEEP = [5, 10, 21, 42, 63];
const PRIMARY_MAX_HOLD = 21;

interface StrategyMetrics {
  label: string;
  netReturnPct: number;
  realizedPnl: number;
  winRatePct: number;
  maxDrawdownPct: number;
  alphaPct: number;
  closed: number;
  open: number;
}

/** Fetch adjusted daily candles for every symbol we need. */
async function fetchAll(
  from: string,
  to: string,
): Promise<{ byTicker: Record<string, Candle[]>; spy: Candle[] }> {
  const provider = tiingoFromEnv();
  const byTicker: Record<string, Candle[]> = {};
  for (const ticker of UNIVERSE) {
    const series = await provider.getCandles(ticker, from, to);
    if (series.length === 0) {
      throw new Error(`Tiingo returned no candles for ${ticker} over ${from}..${to}`);
    }
    byTicker[ticker] = series;
  }
  const spy = await provider.getCandles(SPY, from, to);
  if (spy.length === 0) {
    throw new Error(`Tiingo returned no candles for the SPY benchmark over ${from}..${to}`);
  }
  return { byTicker, spy };
}

/**
 * Build entry signals by walking SPY's trading calendar. Every REBALANCE_EVERY_SESSIONS
 * sessions (once enough history exists to score momentum), rank the universe as-of that date
 * and emit an entry for the top TOP_N. `trendFilter` gates Strategy B on aboveTrend(200d).
 */
function buildSignals(
  byTicker: Record<string, Candle[]>,
  calendar: string[],
  trendFilter: boolean,
): Signal[] {
  const minHistory = DEFAULT_MOMENTUM_CONFIG.lookbackDays + 1;
  const signals: Signal[] = [];
  for (let i = minHistory; i < calendar.length; i += REBALANCE_EVERY_SESSIONS) {
    const asOfDate = calendar[i];
    const ranked = rankMomentum(byTicker, asOfDate, DEFAULT_MOMENTUM_CONFIG);
    let picks = ranked;
    if (trendFilter) {
      picks = picks.filter((r) => aboveTrend(byTicker[r.ticker], asOfDate, DEFAULT_MOMENTUM_CONFIG.trendWindow));
    }
    for (const pick of picks.slice(0, TOP_N)) {
      signals.push({ ticker: pick.ticker, date: asOfDate });
    }
  }
  return signals;
}

function runStrategy(
  label: string,
  byTicker: Record<string, Candle[]>,
  spy: Candle[],
  signals: Signal[],
  maxHoldDays: number,
): StrategyMetrics {
  const config: BacktestConfig = {
    startingEquity: STARTING_EQUITY,
    spySeries: spy,
    defaultNotional: DEFAULT_NOTIONAL,
    exits: { ...DEFAULT_EXITS, defaultMaxHoldDays: maxHoldDays },
  };
  const result = runBacktest(byTicker, signals, config);
  const finalEquity =
    result.equityCurve.length > 0
      ? result.equityCurve[result.equityCurve.length - 1].equity
      : STARTING_EQUITY;
  const netReturnPct = ((finalEquity - STARTING_EQUITY) / STARTING_EQUITY) * 100;
  const closed = result.trades.filter((t) => t.exitDate !== null).length;
  const open = result.trades.length - closed;
  return {
    label,
    netReturnPct,
    realizedPnl: result.realizedPnl,
    winRatePct: result.winRate * 100,
    maxDrawdownPct: result.maxDrawdown * 100,
    alphaPct: result.alphaVsSpy.alphaPct,
    closed,
    open,
  };
}

/**
 * True buy-and-hold SPY baseline, computed directly rather than through checkExits. Routing
 * SPY through the exit stack would trail-stop it out on the first >8% pullback and leave it in
 * cash, which is NOT buy-and-hold. This fully invests at inception (paying one entry leg of the
 * standard cost) and holds to the end; the position never sells, so realized PnL is 0 and it
 * ends open. Max drawdown is SPY's own peak-to-trough on close.
 */
function buyAndHoldSpy(spy: Candle[]): StrategyMetrics {
  const costFrac = (20 / 2 + 40) / 10_000; // matches the backtest default cost model
  const notional = STARTING_EQUITY / (1 + costFrac);
  const startPrice = spy[0].close;
  const endPrice = spy[spy.length - 1].close;
  const finalEquity = notional * (endPrice / startPrice);
  const netReturnPct = ((finalEquity - STARTING_EQUITY) / STARTING_EQUITY) * 100;
  const spyReturnPct = ((endPrice - startPrice) / startPrice) * 100;
  let peak = -Infinity;
  let maxDd = 0;
  for (const c of spy) {
    if (c.close > peak) peak = c.close;
    if (peak > 0) {
      const dd = (peak - c.close) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return {
    label: "SPY buy-and-hold",
    netReturnPct,
    realizedPnl: 0,
    winRatePct: 0,
    maxDrawdownPct: maxDd * 100,
    alphaPct: netReturnPct - spyReturnPct,
    closed: 0,
    open: 1,
  };
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printTable(title: string, rows: StrategyMetrics[]): void {
  console.log(`\n${title}`);
  console.log("=".repeat(96));
  const head = [
    "strategy".padEnd(24),
    "net ret".padStart(10),
    "realized pnl".padStart(16),
    "win%".padStart(8),
    "max dd".padStart(9),
    "alpha".padStart(10),
    "trades".padStart(12),
  ].join(" ");
  console.log(head);
  console.log("-".repeat(96));
  for (const r of rows) {
    console.log(
      [
        r.label.padEnd(24),
        pct(r.netReturnPct).padStart(10),
        money(r.realizedPnl).padStart(16),
        `${r.winRatePct.toFixed(1)}%`.padStart(8),
        `${r.maxDrawdownPct.toFixed(2)}%`.padStart(9),
        pct(r.alphaPct).padStart(10),
        `${r.closed}c/${r.open}o`.padStart(12),
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subYears(new Date(), YEARS), "yyyy-MM-dd");

  console.log(`Momentum study (OFFLINE, READ-ONLY) over ${from}..${to}`);
  console.log(`Universe (${UNIVERSE.length} names): ${UNIVERSE.join(", ")}`);
  console.log(
    `Config: 12-1 momentum lookback=${DEFAULT_MOMENTUM_CONFIG.lookbackDays}d skip=${DEFAULT_MOMENTUM_CONFIG.skipDays}d trend=${DEFAULT_MOMENTUM_CONFIG.trendWindow}d | ` +
      `top ${TOP_N}, rebalance every ${REBALANCE_EVERY_SESSIONS} sessions, notional ${money(DEFAULT_NOTIONAL)}/slot`,
  );
  console.log(
    `Cost model: spread 20bps + fx 40bps (backtest defaults), starting equity ${money(STARTING_EQUITY)}`,
  );

  const { byTicker, spy } = await fetchAll(from, to);
  const calendar = spy.map((c) => c.date);

  const signalsA = buildSignals(byTicker, calendar, false);
  const signalsB = buildSignals(byTicker, calendar, true);
  console.log(
    `\nSignals generated: Strategy A ${signalsA.length} entries, Strategy B (trend-filtered) ${signalsB.length} entries.`,
  );

  const spyBaseline = buyAndHoldSpy(spy);

  const stratA = runStrategy(
    `A momentum (maxHold ${PRIMARY_MAX_HOLD})`,
    byTicker,
    spy,
    signalsA,
    PRIMARY_MAX_HOLD,
  );
  const stratB = runStrategy(
    `B momentum+trend (maxHold ${PRIMARY_MAX_HOLD})`,
    byTicker,
    spy,
    signalsB,
    PRIMARY_MAX_HOLD,
  );

  printTable("Core comparison", [stratA, stratB, spyBaseline]);

  const sweep = MAX_HOLD_SWEEP.map((mh) =>
    runStrategy(`A maxHold=${mh}`, byTicker, spy, signalsA, mh),
  );
  printTable("Strategy A max-hold sweep", sweep);

  const spyReturnPct =
    ((spy[spy.length - 1].close - spy[0].close) / spy[0].close) * 100;
  console.log(`\nSPY buy-and-hold return over the window: ${pct(spyReturnPct)}`);
  console.log(
    "Note: 'alpha' is each strategy's account return minus SPY's return over the same window (percentage points).",
  );
  console.log(
    "Caveats: rebalance approximated via maxHold (no rank-drop exit); rebalance cadence in trading days vs maxHold in calendar days; exits include production stop-loss + trailing-stop.",
  );
}

main().catch((err) => {
  if (err instanceof TiingoError) {
    console.error(`Tiingo error ${err.status}: ${err.body}`);
  } else {
    console.error(String(err instanceof Error ? err.message : err));
  }
  process.exit(1);
});
