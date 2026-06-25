import type { PortfolioSnapshot, Position } from "./risk.ts";
import type { CashBalance, T212Position } from "./t212.ts";

/**
 * Convert a target notional in the ACCOUNT currency (e.g. GBP) into a signed share
 * quantity for a T212 order. `priceInstrumentCcy` is the share price in the
 * instrument currency (e.g. USD); `fxRate` converts instrument-ccy -> account-ccy
 * (e.g. USD->GBP ≈ 0.79). The sign of the result follows the sign of the notional
 * (negative notional = SELL). Rounded to 6 dp (T212 supports fractional shares).
 */
export function notionalToShares(
  notionalAccountCcy: number,
  priceInstrumentCcy: number,
  fxRate: number,
): number {
  if (!(priceInstrumentCcy > 0) || !(fxRate > 0)) {
    throw new Error("price and fxRate must be positive");
  }
  const priceAccountCcy = priceInstrumentCcy * fxRate;
  const shares = notionalAccountCcy / priceAccountCcy;
  return Math.round(shares * 1e6) / 1e6;
}

/**
 * Build the risk-engine PortfolioSnapshot from a T212 account-cash + positions read.
 *
 * Currency: T212 position `currentPrice` is in the instrument currency; `fxRate`
 * (instrument -> account) converts a position's market value into account currency.
 * Account cash is already in account currency.
 *
 * ASSUMPTION — verify against a live `/equity/account/cash` + `/equity/portfolio`
 * response before live trading: equity = `cash.free` + Σ(position market value in
 * account ccy); available cash = `cash.free`. `peakEquity` / `dayPnl` /
 * `newPositionsToday` / `consecutiveLossDays` come from the cross-cycle state store
 * (Phase 1: best-effort — see lib/state).
 */
export function buildRiskSnapshot(args: {
  cash: CashBalance;
  positions: T212Position[];
  fxRate: number;
  peakEquity: number;
  dayPnl: number;
  newPositionsToday: number;
  consecutiveLossDays: number;
}): PortfolioSnapshot {
  const positions: Position[] = args.positions.map((p) => ({
    ticker: p.ticker,
    value: p.quantity * p.currentPrice * args.fxRate,
  }));
  const deployed = positions.reduce((sum, p) => sum + p.value, 0);
  const equity = args.cash.free + deployed;
  return {
    equity,
    cash: args.cash.free,
    peakEquity: Math.max(args.peakEquity, equity),
    dayPnl: args.dayPnl,
    positions,
    newPositionsToday: args.newPositionsToday,
    consecutiveLossDays: args.consecutiveLossDays,
  };
}
