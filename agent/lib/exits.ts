/**
 * Deterministic exit rules. Entries set a stop-loss / take-profit (as fractions of
 * entry price) plus an optional max-hold; this module decides, from live prices, which
 * open positions must be closed. Pure and unit-tested: the actual SELLs still go
 * through the authoritative risk gate in submit_orders.
 */

/** Bounds + fallbacks for per-position exit levels. */
export interface ExitDefaults {
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  defaultMaxHoldDays: number;
  minStopLossPct: number;
  maxStopLossPct: number;
  minTakeProfitPct: number;
  maxTakeProfitPct: number;
  // Trailing stop: once a position is up by activateTrailAtPct, a stop that ratchets
  // up with the high-water mark takes over as the primary exit for winners.
  defaultTrailingStopPct: number;
  minTrailingStopPct: number;
  maxTrailingStopPct: number;
  activateTrailAtPct: number;
}

// Defaults rationale: the trailing stop is the primary exit on winners, so take-profit
// is loosened to a far backstop (0.4) that rarely front-runs the trail. Trail defaults to
// 8% (typical swing-trade give-back), clamped to 3%..20% so it's never absurdly tight or
// loose, and only activates once a trade is +5% so early noise can't shake it out while the
// hard stop-loss still protects the downside below that threshold.
export const DEFAULT_EXITS: ExitDefaults = {
  defaultStopLossPct: 0.1,
  defaultTakeProfitPct: 0.4,
  defaultMaxHoldDays: 10,
  minStopLossPct: 0.03,
  maxStopLossPct: 0.25,
  minTakeProfitPct: 0.05,
  maxTakeProfitPct: 0.6,
  defaultTrailingStopPct: 0.08,
  minTrailingStopPct: 0.03,
  maxTrailingStopPct: 0.2,
  activateTrailAtPct: 0.05,
};

/** An open long position, joined from the live broker read + the entry's stored levels. */
export interface OpenPosition {
  ticker: string;
  entryPrice: number; // average cost, instrument ccy (USD)
  currentPrice: number; // instrument ccy (USD)
  /** Current market value in ACCOUNT ccy (GBP); used as the SELL notional to close fully. */
  marketValue: number;
  openedAt: number; // ms epoch of entry
  /** Highest price seen since entry (high-water mark, instrument ccy). Falls back to entryPrice. */
  peakPrice?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxHoldDays?: number;
}

export type ExitReason = "stop-loss" | "trailing-stop" | "take-profit" | "max-hold";

export interface ExitSignal {
  ticker: string;
  reason: ExitReason;
  pnlPct: number; // (current - entry) / entry
  marketValue: number; // SELL notional to fully close (account ccy)
  detail: string;
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** Resolve a position's effective exit levels: use its own, else defaults, clamped to bounds. */
export function effectiveLevels(
  p: OpenPosition,
  d: ExitDefaults,
): {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxHoldDays: number;
} {
  return {
    stopLossPct: clamp(
      p.stopLossPct ?? d.defaultStopLossPct,
      d.minStopLossPct,
      d.maxStopLossPct,
    ),
    takeProfitPct: clamp(
      p.takeProfitPct ?? d.defaultTakeProfitPct,
      d.minTakeProfitPct,
      d.maxTakeProfitPct,
    ),
    trailingStopPct: clamp(
      p.trailingStopPct ?? d.defaultTrailingStopPct,
      d.minTrailingStopPct,
      d.maxTrailingStopPct,
    ),
    maxHoldDays: p.maxHoldDays ?? d.defaultMaxHoldDays,
  };
}

/**
 * Decide which positions must exit. Precedence: hard stop-loss -> trailing-stop ->
 * take-profit -> max-hold. The hard stop-loss is the downside floor; the trailing stop
 * only takes over once a position is up past the activation threshold, and it fires on a
 * pullback from the high-water mark (peak = max(peakPrice ?? entryPrice, currentPrice), so
 * it only ever ratchets up). Take-profit is a far backstop; the time stop is last.
 */
export function checkExits(
  positions: OpenPosition[],
  defaults: ExitDefaults,
  now: number,
): ExitSignal[] {
  const signals: ExitSignal[] = [];
  for (const p of positions) {
    if (!(p.entryPrice > 0)) continue;
    const pnlPct = (p.currentPrice - p.entryPrice) / p.entryPrice;
    const { stopLossPct, takeProfitPct, trailingStopPct, maxHoldDays } =
      effectiveLevels(p, defaults);

    const peak = Math.max(p.peakPrice ?? p.entryPrice, p.currentPrice);
    const trailStopPrice = peak * (1 - trailingStopPct);
    const trailActive = pnlPct >= defaults.activateTrailAtPct;

    let reason: ExitReason | null = null;
    if (pnlPct <= -stopLossPct) reason = "stop-loss";
    else if (trailActive && p.currentPrice <= trailStopPrice) reason = "trailing-stop";
    else if (pnlPct >= takeProfitPct) reason = "take-profit";
    else if (p.openedAt > 0) {
      const ageDays = (now - p.openedAt) / 86_400_000;
      if (ageDays >= maxHoldDays) reason = "max-hold";
    }
    if (!reason) continue;

    const pct = (pnlPct * 100).toFixed(1);
    const detail =
      reason === "stop-loss"
        ? `stop-loss hit: ${pct}% <= -${(stopLossPct * 100).toFixed(0)}%`
        : reason === "trailing-stop"
          ? `trailing-stop hit: ${(trailingStopPct * 100).toFixed(0)}% off peak ${peak.toFixed(2)}, pnl ${pct}%`
          : reason === "take-profit"
            ? `take-profit hit: ${pct}% >= ${(takeProfitPct * 100).toFixed(0)}%`
            : `max hold reached (>= ${maxHoldDays}d), pnl ${pct}%`;
    signals.push({ ticker: p.ticker, reason, pnlPct, marketValue: p.marketValue, detail });
  }
  return signals;
}
