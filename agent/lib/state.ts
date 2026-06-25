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
