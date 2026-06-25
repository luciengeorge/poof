/**
 * Phase-1 runtime config + cross-cycle risk state.
 *
 * NOTE — cross-cycle state limitation: the daily-loss halt, consecutive-loss-day
 * circuit breaker, peak-drawdown breaker, and per-day new-position count all need state
 * that persists ACROSS scheduled cycles (separate eve sessions). eve `defineState` is
 * per-session, so it cannot carry this. Until a small KV store is wired in, these are
 * **best-effort OFF** (returned as zeros), and Phase-1 safety rests on the
 * snapshot-computable pre-trade guards (per-name, cash-floor, trade-size, position-count,
 * price) PLUS the hard £50 account ceiling (the T212 API has no deposit endpoint).
 * Back this with a KV (e.g. Upstash via Vercel Marketplace) before scaling capital.
 */
export interface RiskState {
  peakEquity: number;
  dayPnl: number;
  newPositionsToday: number;
  consecutiveLossDays: number;
}

let warnedOnce = false;

export function loadRiskState(): RiskState {
  if (!warnedOnce) {
    console.warn(
      "[risk-state] Phase 1: cross-cycle risk state is not persisted; daily-loss / " +
        "circuit-breaker / peak-drawdown are best-effort OFF. Back with a KV before scaling.",
    );
    warnedOnce = true;
  }
  return { peakEquity: 0, dayPnl: 0, newPositionsToday: 0, consecutiveLossDays: 0 };
}

/** DRY_RUN defaults ON (safe). Only `DRY_RUN=false` enables real order placement. */
export function isDryRun(): boolean {
  return process.env.DRY_RUN !== "false";
}

/** Instrument→account FX (USD→GBP). Phase 1: from USD_GBP_RATE env, default ~0.79. */
export function fxRateFromEnv(): number {
  const raw = process.env.USD_GBP_RATE;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0.79;
}
