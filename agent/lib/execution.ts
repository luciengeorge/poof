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

/** First-attempt quantity precision. T212 enforces a per-instrument max (not in metadata),
 * so we start here and adapt down on an `invalid quantity precision N` error. */
export const DEFAULT_QUANTITY_PRECISION = 6;

/**
 * Round a share magnitude DOWN to `decimals` places, cleanly (no float-noise digits, which
 * themselves trigger "invalid quantity precision"). Always truncates toward zero so a BUY
 * never spends more than intended and a SELL never exceeds the position. `decimals <= 0`
 * means whole shares only. Returns a non-negative magnitude; apply the side's sign at send.
 */
export function roundQuantity(magnitude: number, decimals: number): number {
  const m = Math.abs(magnitude);
  if (!(m > 0)) return 0;
  if (decimals <= 0) return Math.floor(m + 1e-9);
  const f = 10 ** decimals;
  // +epsilon corrects float artifacts (e.g. 0.2234*1e4 = 2233.9999997) before flooring.
  return Math.floor(m * f + 1e-6) / f;
}

/**
 * Extract the allowed decimal precision from a T212 "invalid quantity precision" error.
 * Handles "invalid quantity precision 4" and "must be limited to 0 decimal spaces".
 * Returns the allowed dp, 0 if the error is about precision but carries no number, or
 * null if it isn't a precision error at all.
 */
export function parseQuantityPrecision(message: string): number | null {
  // Anchor to the precision phrase so we don't grab an unrelated number (e.g. the HTTP
  // status in "Trading 212 API error 400: ...").
  const m1 = message.match(/quantity precision[^0-9]*(\d+)/i);
  if (m1) return Number(m1[1]);
  const m2 = message.match(/limited to\s*(\d+)\s*decimal/i);
  if (m2) return Number(m2[1]);
  if (/precision|decimal/i.test(message)) return 0; // precision error, no number → whole shares
  return null;
}

/**
 * Map a T212 US-equity ticker (e.g. "AAPL_US_EQ") to its plain Finnhub symbol ("AAPL").
 * Only the `_US_EQ` suffix is recognized; anything else returns null rather than guessing.
 */
export function t212TickerToFinnhubSymbol(ticker: string): string | null {
  if (!ticker.endsWith("_US_EQ")) return null;
  const symbol = ticker.slice(0, -"_US_EQ".length);
  return symbol.length > 0 ? symbol : null;
}

/**
 * Build the risk-engine PortfolioSnapshot from a T212 account-cash + positions read.
 *
 * Currency: T212 position `currentPrice` is in the instrument currency; `fxRate`
 * (instrument -> account) converts a position's market value into account currency.
 * Account cash is already in account currency.
 *
 * ASSUMPTION: verify against a live `/equity/account/cash` + `/equity/portfolio`
 * response before live trading: equity = `cash.free` + Σ(position market value in
 * account ccy); available cash = `cash.free`. `peakEquity` / `dayPnl` /
 * `newPositionsToday` / `consecutiveLossDays` come from the cross-cycle state store
 * (Phase 1: best-effort, see lib/state).
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
  const bad =
    !Number.isFinite(args.cash.free) ||
    !Number.isFinite(args.fxRate) ||
    args.positions.some((p) => !Number.isFinite(p.quantity) || !Number.isFinite(p.currentPrice));
  if (bad) {
    throw new Error("non-finite account data from broker; refusing to gate orders (fail-closed)");
  }
  const positions: Position[] = args.positions.map((p) => ({
    ticker: p.ticker,
    value: p.quantity * p.currentPrice * args.fxRate,
  }));
  const deployed = positions.reduce((sum, p) => sum + p.value, 0);
  const equity = args.cash.free + deployed;
  if (!Number.isFinite(equity)) {
    throw new Error("non-finite account data from broker; refusing to gate orders (fail-closed)");
  }
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
