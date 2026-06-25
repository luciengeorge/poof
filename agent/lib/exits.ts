/**
 * Deterministic exit rules. Entries set a stop-loss / take-profit (as fractions of
 * entry price) plus an optional max-hold; this module decides, from live prices, which
 * open positions must be closed. Pure and unit-tested — the actual SELLs still go
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
}

export const DEFAULT_EXITS: ExitDefaults = {
  defaultStopLossPct: 0.1,
  defaultTakeProfitPct: 0.2,
  defaultMaxHoldDays: 10,
  minStopLossPct: 0.03,
  maxStopLossPct: 0.25,
  minTakeProfitPct: 0.05,
  maxTakeProfitPct: 0.6,
};

/** An open long position, joined from the live broker read + the entry's stored levels. */
export interface OpenPosition {
  ticker: string;
  entryPrice: number; // average cost, instrument ccy (USD)
  currentPrice: number; // instrument ccy (USD)
  /** Current market value in ACCOUNT ccy (GBP); used as the SELL notional to close fully. */
  marketValue: number;
  openedAt: number; // ms epoch of entry
  stopLossPct?: number;
  takeProfitPct?: number;
  maxHoldDays?: number;
}

export type ExitReason = "stop-loss" | "take-profit" | "max-hold";

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
): { stopLossPct: number; takeProfitPct: number; maxHoldDays: number } {
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
    maxHoldDays: p.maxHoldDays ?? d.defaultMaxHoldDays,
  };
}

/**
 * Decide which positions must exit. Stop-loss takes priority over take-profit (both
 * shouldn't trigger at once), and a hard price stop takes priority over the time stop.
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
    const { stopLossPct, takeProfitPct, maxHoldDays } = effectiveLevels(p, defaults);

    let reason: ExitReason | null = null;
    if (pnlPct <= -stopLossPct) reason = "stop-loss";
    else if (pnlPct >= takeProfitPct) reason = "take-profit";
    else {
      const ageDays = (now - p.openedAt) / 86_400_000;
      if (ageDays >= maxHoldDays) reason = "max-hold";
    }
    if (!reason) continue;

    const pct = (pnlPct * 100).toFixed(1);
    const detail =
      reason === "stop-loss"
        ? `stop-loss hit: ${pct}% <= -${(stopLossPct * 100).toFixed(0)}%`
        : reason === "take-profit"
          ? `take-profit hit: ${pct}% >= ${(takeProfitPct * 100).toFixed(0)}%`
          : `max hold reached (>= ${maxHoldDays}d), pnl ${pct}%`;
    signals.push({ ticker: p.ticker, reason, pnlPct, marketValue: p.marketValue, detail });
  }
  return signals;
}
