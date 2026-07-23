/**
 * Pure, deterministic backtest / replay harness. Steps day-by-day over historical candles,
 * enters scripted signals with strict look-ahead safety (a signal on day T fills at day T+1's
 * OPEN, never day T's close), evaluates exits on each day's close, marks equity to market, and
 * reports the usual metrics. No live data, no Convex, no broker: given the same inputs it always
 * returns the same output.
 *
 * It REUSES the production pure modules rather than duplicating their logic:
 *   - exits.ts `checkExits` / `OpenPosition` / `DEFAULT_EXITS` decide stop-loss / take-profit / max-hold.
 *   - execution.ts `notionalToShares` sizes each entry.
 *   - benchmark.ts `computeAlpha` computes alpha vs buy-and-hold SPY.
 */
import type { Candle } from "./data.ts";
import {
  checkExits,
  DEFAULT_EXITS,
  type ExitDefaults,
  type ExitReason,
  type OpenPosition,
} from "./exits.ts";
import { notionalToShares } from "./execution.ts";
import { computeAlpha, type AlphaResult, type Benchmark } from "./benchmark.ts";

/** A scripted entry intent. v1 signals are hand-written, NOT LLM output. */
export interface Signal {
  ticker: string;
  date: string; // YYYY-MM-DD the signal is generated (fills at the NEXT session's open)
  notional?: number; // account-ccy notional to deploy; falls back to config.defaultNotional
}

export interface BacktestConfig {
  startingEquity: number;
  /** SPY daily candles over (at least) the backtest window; drives alphaVsSpy. */
  spySeries: Candle[];
  /** Notional per signal when the signal omits its own. Default: 10% of startingEquity. */
  defaultNotional?: number;
  /** Half-spread + fx are charged on BOTH legs, so a round trip pays the full spread + 2x fx. */
  spreadBps?: number; // default 20
  fxBps?: number; // default 40
  /** Exit levels; defaults to the production DEFAULT_EXITS. */
  exits?: ExitDefaults;
}

export interface BacktestTrade {
  ticker: string;
  entryDate: string;
  entryPrice: number; // raw open at fill (T+1 open) — no cost baked in
  shares: number;
  exitDate: string | null; // null while still open at end of run
  exitPrice: number | null;
  exitReason: ExitReason | null;
  realizedPnl: number | null; // net of entry+exit costs; null while open
  costs: number; // total fees paid (entry, plus exit once closed)
}

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  realizedPnl: number;
  winRate: number; // fraction of CLOSED trades with realizedPnl > 0
  maxDrawdown: number; // worst peak-to-trough drop as a fraction (0.15 = 15%)
  alphaVsSpy: AlphaResult;
}

const DEFAULT_SPREAD_BPS = 20;
const DEFAULT_FX_BPS = 40;

/** One open position tracked during the run. */
interface LivePosition {
  ticker: string;
  entryDate: string;
  entryPrice: number; // raw open
  shares: number;
  openedAtMs: number;
  entryCost: number;
}

const dayMs = (date: string): number => Date.parse(date);

/** Sorted ascending union of every date present across the price series. */
function unionDates(priceSeriesByTicker: Record<string, Candle[]>): string[] {
  const set = new Set<string>();
  for (const series of Object.values(priceSeriesByTicker)) {
    for (const c of series) set.add(c.date);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Index a series by date for O(1) lookup. */
function indexByDate(series: Candle[]): Map<string, Candle> {
  return new Map(series.map((c) => [c.date, c]));
}

/**
 * Group signals by their FILL date: a signal on day T fills at the first session strictly
 * after T in that ticker's own series (its T+1 open). This is the look-ahead guard — a signal
 * can never fill on the day it was generated. Signals with no later session are dropped.
 */
function fillsByDate(
  signals: Signal[],
  seriesByTicker: Record<string, Candle[]>,
): Map<string, Signal[]> {
  const byDate = new Map<string, Signal[]>();
  for (const sig of signals) {
    const series = seriesByTicker[sig.ticker];
    if (!series) continue;
    const fill = series.find((c) => c.date > sig.date);
    if (!fill) continue;
    const list = byDate.get(fill.date) ?? [];
    list.push(sig);
    byDate.set(fill.date, list);
  }
  return byDate;
}

/** Alpha vs buy-and-hold SPY over the run window, via the shared computeAlpha. */
function alphaVsSpy(
  spySeries: Candle[],
  startingEquity: number,
  finalEquity: number,
  firstDate: string,
  lastDate: string,
): AlphaResult {
  const spyByDate = indexByDate(spySeries);
  const first = spyByDate.get(firstDate) ?? spySeries[0];
  const last = spyByDate.get(lastDate) ?? spySeries[spySeries.length - 1];
  if (!first || !last) {
    return { accountReturnPct: 0, spyReturnPct: 0, alphaPct: 0 };
  }
  const baseline: Benchmark = {
    inceptionEquity: startingEquity,
    inceptionSpyPrice: first.close,
    inceptionDate: firstDate,
  };
  return computeAlpha(baseline, finalEquity, last.close);
}

/** Worst peak-to-trough drawdown across the equity curve, as a positive fraction. */
function computeMaxDrawdown(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = (peak - point.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export function runBacktest(
  priceSeriesByTicker: Record<string, Candle[]>,
  signals: Signal[],
  config: BacktestConfig,
): BacktestResult {
  const spreadBps = config.spreadBps ?? DEFAULT_SPREAD_BPS;
  const fxBps = config.fxBps ?? DEFAULT_FX_BPS;
  const exits = config.exits ?? DEFAULT_EXITS;
  const defaultNotional = config.defaultNotional ?? config.startingEquity * 0.1;
  // Half the spread is crossed per leg, plus the fx conversion fee on each leg.
  const costFrac = (spreadBps / 2 + fxBps) / 10_000;

  const dates = unionDates(priceSeriesByTicker);
  const seriesIndex: Record<string, Map<string, Candle>> = {};
  for (const [ticker, series] of Object.entries(priceSeriesByTicker)) {
    seriesIndex[ticker] = indexByDate(series);
  }
  const fills = fillsByDate(signals, priceSeriesByTicker);

  let cash = config.startingEquity;
  const open = new Map<string, LivePosition>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (const date of dates) {
    // 1. Fills: scripted signals dated the prior session enter at TODAY'S open.
    for (const sig of fills.get(date) ?? []) {
      if (open.has(sig.ticker)) continue; // one position per ticker at a time (v1)
      const bar = seriesIndex[sig.ticker]?.get(date);
      if (!bar) continue;
      const notional = sig.notional ?? defaultNotional;
      const entryFee = notional * costFrac;
      if (notional + entryFee > cash) continue; // can't afford it
      const shares = notionalToShares(notional, bar.open, 1);
      if (!(shares > 0)) continue;
      const grossCost = shares * bar.open;
      cash -= grossCost + entryFee;
      open.set(sig.ticker, {
        ticker: sig.ticker,
        entryDate: date,
        entryPrice: bar.open,
        shares,
        openedAtMs: dayMs(date),
        entryCost: entryFee,
      });
    }

    // 2. Exits: evaluate every open position against TODAY'S close via the shared checkExits.
    const positions: OpenPosition[] = [];
    for (const pos of open.values()) {
      const bar = seriesIndex[pos.ticker]?.get(date);
      if (!bar) continue;
      positions.push({
        ticker: pos.ticker,
        entryPrice: pos.entryPrice,
        currentPrice: bar.close,
        marketValue: pos.shares * bar.close,
        openedAt: pos.openedAtMs,
        stopLossPct: undefined,
        takeProfitPct: undefined,
        maxHoldDays: undefined,
      });
    }
    const exitSignals = checkExits(positions, exits, dayMs(date));
    for (const ex of exitSignals) {
      const pos = open.get(ex.ticker);
      const bar = seriesIndex[ex.ticker]?.get(date);
      if (!pos || !bar) continue;
      const exitFee = pos.shares * bar.close * costFrac;
      const proceeds = pos.shares * bar.close - exitFee;
      cash += proceeds;
      const totalCost = pos.entryCost + exitFee;
      trades.push({
        ticker: pos.ticker,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        shares: pos.shares,
        exitDate: date,
        exitPrice: bar.close,
        exitReason: ex.reason,
        realizedPnl: proceeds - (pos.shares * pos.entryPrice + pos.entryCost),
        costs: totalCost,
      });
      open.delete(ex.ticker);
    }

    // 3. Mark to market: cash + close-value of everything still open.
    let held = 0;
    for (const pos of open.values()) {
      const bar = seriesIndex[pos.ticker]?.get(date);
      if (bar) held += pos.shares * bar.close;
    }
    equityCurve.push({ date, equity: cash + held });
  }

  // Positions still open at the end are reported as open trades (unrealized, excluded from realizedPnl).
  for (const pos of open.values()) {
    trades.push({
      ticker: pos.ticker,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      shares: pos.shares,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      realizedPnl: null,
      costs: pos.entryCost,
    });
  }

  const closed = trades.filter((t) => t.realizedPnl !== null);
  const realizedPnl = closed.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length : 0;
  const maxDrawdown = computeMaxDrawdown(equityCurve);
  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.startingEquity;
  const alpha = alphaVsSpy(
    config.spySeries,
    config.startingEquity,
    finalEquity,
    dates[0] ?? "",
    dates[dates.length - 1] ?? "",
  );

  return {
    trades,
    equityCurve,
    realizedPnl,
    winRate,
    maxDrawdown,
    alphaVsSpy: alpha,
  };
}
