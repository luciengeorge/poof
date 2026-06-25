/**
 * Runtime config + cross-cycle risk-state derivation.
 *
 * The durable risk state (peak equity, day-start equity, consecutive loss days) lives in
 * Convex memory; `submit_orders` loads it, derives the live snapshot fields with
 * `deriveRiskState`, runs the gate, and persists the update. `loadRiskState()` below is a
 * neutral default for display-only reads (e.g. `get_account`) that don't gate trades.
 */
export interface RiskState {
  peakEquity: number;
  dayPnl: number;
  newPositionsToday: number;
  consecutiveLossDays: number;
}

/** Durable risk state persisted across cycles (in Convex). */
export interface StoredRiskState {
  peakEquity: number;
  dayStartEquity: number;
  dayStartDate: string; // YYYY-MM-DD (ET)
  consecutiveLossDays: number;
}

export interface DerivedRiskState {
  /** Fields fed into the risk-engine snapshot for this cycle. */
  fields: RiskState;
  /** Updated durable state to persist back. */
  persist: StoredRiskState;
}

/**
 * Derive the live risk state for a cycle from the stored state + current equity.
 * Handles per-ET-day rollover: on a new day, the prior day counts as a loss if equity
 * sits below where the prior day started, incrementing the consecutive-loss-day counter
 * (else it resets). Peak equity is the running max. `newPositionsToday` is not tracked
 * across cycles in Phase 1 (the within-cycle cap in the risk engine still applies).
 */
export function deriveRiskState(
  stored: StoredRiskState | null,
  currentEquity: number,
  todayET: string,
): DerivedRiskState {
  if (!stored) {
    return {
      fields: {
        peakEquity: currentEquity,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      },
      persist: {
        peakEquity: currentEquity,
        dayStartEquity: currentEquity,
        dayStartDate: todayET,
        consecutiveLossDays: 0,
      },
    };
  }

  const peakEquity = Math.max(stored.peakEquity, currentEquity);
  let dayStartEquity = stored.dayStartEquity;
  let dayStartDate = stored.dayStartDate;
  let consecutiveLossDays = stored.consecutiveLossDays;

  if (stored.dayStartDate !== todayET) {
    const priorDayWasLoss = currentEquity < stored.dayStartEquity;
    consecutiveLossDays = priorDayWasLoss ? stored.consecutiveLossDays + 1 : 0;
    dayStartEquity = currentEquity;
    dayStartDate = todayET;
  }

  const dayPnl = currentEquity - dayStartEquity;

  return {
    fields: { peakEquity, dayPnl, newPositionsToday: 0, consecutiveLossDays },
    persist: { peakEquity, dayStartEquity, dayStartDate, consecutiveLossDays },
  };
}

import { DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";

type EnvLike = Record<string, string | undefined>;

function numFromEnv(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Active risk limits = DEFAULT_LIMITS overlaid with optional `TRADING_*` env overrides,
 * so aggression can be tuned per-deployment (e.g. on Vercel) without a code change.
 * An unset/blank/non-numeric var falls back to the shipped default.
 */
export function resolveLimits(env: EnvLike = process.env): RiskLimits {
  return {
    maxPerNamePct: numFromEnv(env, "TRADING_MAX_PER_NAME_PCT", DEFAULT_LIMITS.maxPerNamePct),
    maxDeployedPct: numFromEnv(env, "TRADING_MAX_DEPLOYED_PCT", DEFAULT_LIMITS.maxDeployedPct),
    maxNewPositionsPerDay: numFromEnv(env, "TRADING_MAX_NEW_POSITIONS_PER_DAY", DEFAULT_LIMITS.maxNewPositionsPerDay),
    minTradePct: numFromEnv(env, "TRADING_MIN_TRADE_PCT", DEFAULT_LIMITS.minTradePct),
    maxTradePct: numFromEnv(env, "TRADING_MAX_TRADE_PCT", DEFAULT_LIMITS.maxTradePct),
    dailyLossHaltPct: numFromEnv(env, "TRADING_DAILY_LOSS_HALT_PCT", DEFAULT_LIMITS.dailyLossHaltPct),
    maxConcurrentPositions: numFromEnv(env, "TRADING_MAX_CONCURRENT_POSITIONS", DEFAULT_LIMITS.maxConcurrentPositions),
    minPrice: numFromEnv(env, "TRADING_MIN_PRICE", DEFAULT_LIMITS.minPrice),
    maxDrawdownPct: numFromEnv(env, "TRADING_MAX_DRAWDOWN_PCT", DEFAULT_LIMITS.maxDrawdownPct),
    maxConsecutiveLossDays: numFromEnv(env, "TRADING_MAX_CONSECUTIVE_LOSS_DAYS", DEFAULT_LIMITS.maxConsecutiveLossDays),
  };
}

/** Neutral risk state for display-only reads that don't gate trades (e.g. get_account). */
export function loadRiskState(): RiskState {
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
