/**
 * Pure, deterministic momentum signals. Two building blocks used by the offline
 * momentum study (scripts/momentum-study.ts):
 *
 *   - rankMomentum: cross-sectional 12-1 momentum ranking. Score is the trailing return
 *     over the last ~252 trading days EXCLUDING the most recent ~21 (the "12 minus 1"
 *     convention that skips the short-term reversal window).
 *   - aboveTrend: a simple trend filter, true when the as-of close is above its N-day SMA.
 *
 * Both are strictly look-ahead safe: they only ever read bars with date <= asOfDate, so a
 * price that prints after asOfDate can never change today's score or trend flag. No live
 * data, no Convex, no broker. This module deliberately ships NOTHING to the live cycle; it
 * exists to produce evidence for a go/no-go decision.
 */
import type { Candle } from "./data.ts";

export type Direction = "long" | "short";

/** A ranked momentum signal for one ticker as of a given date. */
export interface RankedMomentum {
  ticker: string;
  score: number; // trailing 12-1 return as a fraction (0.25 = +25%)
  direction: Direction; // long when score >= 0, else short
}

export interface MomentumConfig {
  /** Total trailing window in trading days (the "12 months" leg). */
  lookbackDays: number;
  /** Most-recent trading days to skip (the "minus 1 month" leg, avoids reversal). */
  skipDays: number;
  /** SMA window for the trend filter, in trading days. */
  trendWindow: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  lookbackDays: 252,
  skipDays: 21,
  trendWindow: 200,
};

/** Bars with date <= asOfDate, sorted ascending. Defends against unsorted input. */
function barsAsOf(candles: Candle[], asOfDate: string): Candle[] {
  return candles
    .filter((c) => c.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Trailing 12-1 momentum score for one ticker as of asOfDate. Measures the return from
 * `lookbackDays` sessions ago to `skipDays` sessions ago (both counted back from the as-of
 * bar), so the most recent `skipDays` sessions are excluded. Returns null when there is not
 * enough history to define the full window, so the caller can drop the ticker.
 */
export function momentumScore(
  candles: Candle[],
  asOfDate: string,
  config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
): number | null {
  const bars = barsAsOf(candles, asOfDate);
  const lastIdx = bars.length - 1;
  if (lastIdx < 0) return null;
  const startIdx = lastIdx - config.lookbackDays;
  const endIdx = lastIdx - config.skipDays;
  if (startIdx < 0 || endIdx <= startIdx) return null;
  const startPrice = bars[startIdx].close;
  const endPrice = bars[endIdx].close;
  if (!(startPrice > 0) || !(endPrice > 0)) return null;
  return endPrice / startPrice - 1;
}

/**
 * Rank a universe by trailing 12-1 momentum, descending. Tickers without enough history to
 * compute a score are excluded. Ties break by ticker symbol for deterministic ordering.
 */
export function rankMomentum(
  candlesByTicker: Record<string, Candle[]>,
  asOfDate: string,
  config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
): RankedMomentum[] {
  const ranked: RankedMomentum[] = [];
  for (const [ticker, candles] of Object.entries(candlesByTicker)) {
    const score = momentumScore(candles, asOfDate, config);
    if (score === null) continue;
    ranked.push({ ticker, score, direction: score >= 0 ? "long" : "short" });
  }
  ranked.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  return ranked;
}

/**
 * Trend filter: true when the as-of close is strictly above its `window`-day simple moving
 * average. Returns false when there is not enough history to fill the SMA window.
 */
export function aboveTrend(
  candles: Candle[],
  asOfDate: string,
  window: number = DEFAULT_MOMENTUM_CONFIG.trendWindow,
): boolean {
  const bars = barsAsOf(candles, asOfDate);
  if (bars.length < window || window <= 0) return false;
  const recent = bars.slice(bars.length - window);
  const sma = recent.reduce((sum, c) => sum + c.close, 0) / window;
  const asOfClose = bars[bars.length - 1].close;
  return asOfClose > sma;
}
