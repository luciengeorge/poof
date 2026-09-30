/**
 * The index core: every pound not in a stock sits in one S&P 500 fund instead of cash.
 *
 * WHY. Measured on the live record, 15 Jul to 29 Sep 2026, the account held 64% cash on average
 * while the S&P 500 rose 3.61% in GBP, and that idle cash alone cost 2.17pp of a 4.16pp
 * shortfall. The stock picks show no detectable edge over the index (53 trades, t = 0.37), so
 * money the stock sleeve has no use for belongs in the index, not in cash.
 *
 * WHY THIS INSTRUMENT, AND WHY IT IS HARD-CODED. VUAGl_EQ is Vanguard S&P 500 (Acc) on the LSE.
 * It is quoted in GBP, so there is no Trading 212 FX fee and no USD conversion; accumulating, so
 * it is a total-return holding; unhedged, so it tracks the S&P 500 in pounds. Currency handling
 * is deliberately NOT generalised to other LSE instruments: many quote in GBX (pence), and a
 * pence price read as pounds misvalues a holding a hundredfold.
 *
 * PRICE. Nothing outside Trading 212 prices VUAG on this account (Finnhub returns 403, Tiingo
 * does not know the ticker). The only price is Trading 212's own `currentPrice` on a HELD
 * position, which is also the venue that fills the order. So the core must be held before it can
 * be sized, and must never be sold to zero: see CORE_FLOOR_QUANTITY.
 *
 * Constants and arithmetic only. The broker IO lives in core-orders.ts.
 */
import { roundQuantity } from "./execution.ts";

export const CORE_TICKER = "VUAGl_EQ";
/**
 * Enforced once, at bootstrap, by coreCurrencyProblem (scripts/bootstrap-core.ts), not on every
 * cycle: instrument metadata is rate-limited to about one call a minute, and a listing's quote
 * currency does not change. Everything downstream (fxForHolding returning 1) assumes it is GBP.
 */
export const CORE_QUOTE_CURRENCY = "GBP";

/** Cash left free, as a fraction of equity, for FX fees on stock buys, rounding, and drift. */
export const CORE_CASH_BUFFER_PCT = 0.03;

/** GBP. A sweep smaller than this is not worth an order. */
export const CORE_MIN_ORDER_GBP = 2;

/** Shares never sold: Trading 212 only reports the core's price while some of it is held. */
export const CORE_FLOOR_QUANTITY = 0.05;

/**
 * Size against a price this much worse than the last one seen. In summer London is shut by the
 * time the cycle runs, so the order fills at the next open; a fill a touch away must still fit
 * the cash on a buy, and still cover the shortfall on a sale.
 */
export const CORE_PRICE_MARGIN = 0.01;

export function isCore(ticker: string): boolean {
  return ticker === CORE_TICKER;
}

/**
 * The rate that turns a holding's quoted price into GBP. Every holding used to be valued with the
 * USD -> GBP rate, which reads a GBP holding about 25% low.
 */
export function fxForHolding(ticker: string, usdGbpRate: number): number {
  return isCore(ticker) ? 1 : usdGbpRate;
}

/**
 * Shares of the core to buy with free cash above the buffer, or 0 when the excess is under the
 * minimum order. `corePrice` is GBP. `reservedForStocks` is cash already promised to stock buys
 * that have not yet left the account.
 */
export function sweepQuantity(args: {
  freeCash: number;
  equity: number;
  corePrice: number;
  precision: number;
  reservedForStocks: number;
}): number {
  const excess = args.freeCash - args.reservedForStocks - CORE_CASH_BUFFER_PCT * args.equity;
  if (!(excess >= CORE_MIN_ORDER_GBP) || !(args.corePrice > 0)) return 0;
  return roundQuantity(excess / (args.corePrice * (1 + CORE_PRICE_MARGIN)), args.precision);
}

/**
 * Shares of the core to sell to cover a stock buy's cash shortfall plus the buffer, capped so the
 * holding never falls below CORE_FLOOR_QUANTITY. Rounded down, so the cap holds after rounding.
 */
export function fundingSale(args: {
  shortfall: number;
  equity: number;
  coreQuantity: number;
  corePrice: number;
  precision: number;
}): number {
  if (!(args.shortfall > 0) || !(args.corePrice > 0)) return 0;
  const sellable = args.coreQuantity - CORE_FLOOR_QUANTITY;
  if (!(sellable > 0)) return 0;
  const target = args.shortfall + CORE_CASH_BUFFER_PCT * args.equity;
  const wanted = target / (args.corePrice * (1 - CORE_PRICE_MARGIN));
  return roundQuantity(Math.min(wanted, sellable), args.precision);
}

/**
 * Why the core must not be bought, or null when Trading 212 confirms it quotes in pounds. A GBX
 * (pence) quote read as pounds would misvalue the core a hundredfold, which is the single mistake
 * fxForHolding's hard-coded rate of 1 cannot survive. Pure, so the guard is tested, not assumed.
 */
export function coreCurrencyProblem(
  instruments: readonly { ticker: string; currencyCode?: string }[],
): string | null {
  const core = instruments.find((i) => i.ticker === CORE_TICKER);
  if (!core) return `${CORE_TICKER} is not in Trading 212's instrument list`;
  if (core.currencyCode !== CORE_QUOTE_CURRENCY) {
    return `${CORE_TICKER} quotes in ${String(core.currencyCode)}, not ${CORE_QUOTE_CURRENCY}; refusing to value it as pounds`;
  }
  return null;
}
