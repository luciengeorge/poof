/**
 * Valuation maths for ADVISORY-ONLY external holdings: positions the user holds in a
 * SEPARATE brokerage account that the agent has no API access to and can NEVER trade.
 *
 * SAFETY BOUNDARY: nothing in this module feeds the trading account's equity, risk snapshot,
 * position sizing, circuit breakers, exits, or the trades table. An external holding can be
 * many multiples of the Trading 212 account, so letting one into `accountValueGbp` would
 * authorise wildly oversized orders and compute the drawdown / daily-loss breakers against
 * the wrong base. The advisory path is deliberately parallel to, and disjoint from, the
 * trading path (see agent/lib/execution.ts for the one true account-value formula, and the
 * isolation regression test in external-holdings.test.ts).
 *
 * Pure and unit-tested. Currency, exactly: `costBasisGbp`, `valueGbp` and the P&L figures are
 * GBP; `livePriceInstrumentCcy`, `valueInstrumentCcy` and `breakEvenPriceInstrumentCcy` are in
 * the instrument's own currency (USD for US stocks). `fxRate` converts instrument -> GBP.
 */

import { t212TickerToFinnhubSymbol } from "./execution.ts";

export interface ExternalHoldingInput {
  shares: number;
  costBasisGbp: number;
  livePriceInstrumentCcy: number;
  fxRate: number;
}

export interface ExternalHoldingValuation {
  valueInstrumentCcy: number;
  valueGbp: number;
  unrealisedPnlGbp: number;
  unrealisedPnlPct: number;
  /**
   * The instrument-currency share price at which the holding's GBP value equals its GBP cost
   * basis, i.e. what a full recovery actually requires AT THE CURRENT FX RATE. Note this moves
   * with FX as well as with the share price. 0 when there is no cost basis.
   */
  breakEvenPriceInstrumentCcy: number;
}

/** Value one external holding. Throws on inputs that cannot produce a meaningful number. */
export function valueExternalHolding(
  input: ExternalHoldingInput,
): ExternalHoldingValuation {
  const { shares, costBasisGbp, livePriceInstrumentCcy, fxRate } = input;
  if (
    !(shares > 0) ||
    !(livePriceInstrumentCcy > 0) ||
    !(fxRate > 0) ||
    !Number.isFinite(shares) ||
    !Number.isFinite(livePriceInstrumentCcy) ||
    !Number.isFinite(fxRate)
  ) {
    throw new Error("shares, livePriceInstrumentCcy and fxRate must be positive");
  }
  if (!Number.isFinite(costBasisGbp) || costBasisGbp < 0) {
    throw new Error("costBasisGbp must be a non-negative number");
  }

  const valueInstrumentCcy = shares * livePriceInstrumentCcy;
  const valueGbp = valueInstrumentCcy * fxRate;
  const unrealisedPnlGbp = valueGbp - costBasisGbp;
  // A zero cost basis has no meaningful percentage return; report 0 rather than Infinity.
  const unrealisedPnlPct =
    costBasisGbp > 0 ? (unrealisedPnlGbp / costBasisGbp) * 100 : 0;
  const breakEvenPriceInstrumentCcy =
    costBasisGbp > 0 ? costBasisGbp / shares / fxRate : 0;

  return {
    valueInstrumentCcy,
    valueGbp,
    unrealisedPnlGbp,
    unrealisedPnlPct,
    breakEvenPriceInstrumentCcy,
  };
}

/**
 * PRE-GATE TICKER GUARD. The instructions tell the agent never to trade an externally-held
 * name, but in this codebase the gate is authoritative precisely BECAUSE prompts cannot be
 * trusted, so the rule is also enforced in code: `submit_orders` partitions proposals through
 * the helpers below BEFORE calling `evaluateAndExecute`, and skips any BUY for a name held in
 * the external account.
 *
 * Why a filter in the tool layer rather than a rule inside the risk gate: `buildRiskSnapshot`
 * and `evaluateAndExecute` are pure functions of BROKER inputs with no Convex access, which is
 * exactly what makes it impossible for an external holding's value to reach equity or sizing.
 * Teaching them to read external holdings would destroy that property. So the guard sits
 * outside them and moves only TICKER STRINGS across the boundary. Strings cannot be summed
 * into equity, which is what keeps the isolation type-safe.
 *
 * BUYs only: SELLs stay unblocked, because de-risking is always permitted here and the
 * Trading 212 account may legitimately hold the same name from before.
 */

/** Recorded reason when a BUY is skipped because the name is held in the external account. */
export const EXTERNAL_HOLDING_SKIP_REASON =
  "held in an external advisory account, not traded here";

/**
 * Normalise a ticker to its plain symbol for comparison, so `SHOP` and `SHOP_US_EQ` both
 * match the stored `SHOP`. A bare "SHOP" would be rejected by T212 as an unknown instrument
 * anyway, but a deliberately constructed "SHOP_US_EQ" would not, so both sides are normalised.
 */
function normaliseSymbol(ticker: string): string {
  // Upper-case and trim BEFORE stripping the suffix: t212TickerToFinnhubSymbol matches
  // `_US_EQ` case-sensitively, so a lower-case "shop_us_eq" would otherwise slip past the
  // guard as its own distinct symbol.
  const upper = ticker.trim().toUpperCase();
  return t212TickerToFinnhubSymbol(upper) ?? upper;
}

/**
 * The set of plain symbols that must not be BOUGHT in the trading account.
 * STRINGS ONLY by construction: no shares, value, or cost basis is read here.
 */
export function externalHoldingSymbols(
  holdings: readonly { ticker: string }[],
): Set<string> {
  return new Set(holdings.map((h) => normaliseSymbol(h.ticker)));
}

/**
 * Split proposals into those that may proceed to the risk gate and those blocked because the
 * name is held externally. `blockAllBuys` blocks every BUY regardless of the set: used when
 * the holdings lookup itself failed on live, where we cannot know which names are excluded,
 * so no new exposure is opened. Mirrors resolveRiskState's fail-closed stance on a Convex
 * outage (halt BUYs, allow SELLs).
 */
export function partitionExternalHoldingBuys<
  P extends { ticker: string; side: string },
>(
  proposals: readonly P[],
  excludedSymbols: ReadonlySet<string>,
  opts: { blockAllBuys?: boolean } = {},
): { allowed: P[]; blocked: P[] } {
  const allowed: P[] = [];
  const blocked: P[] = [];
  for (const p of proposals) {
    const isBlockedBuy =
      p.side === "BUY" &&
      (opts.blockAllBuys === true || excludedSymbols.has(normaliseSymbol(p.ticker)));
    if (isBlockedBuy) blocked.push(p);
    else allowed.push(p);
  }
  return { allowed, blocked };
}

const DAY_MS = 86_400_000;

/**
 * Whole days from `todayISO` to `dateISO` (both YYYY-MM-DD). Negative if the date has passed,
 * null if there is no date or it does not parse. Used to turn a scheduled earnings date into
 * the hard deadline an exit has to beat: holding through a print is uncontrolled gap risk.
 */
export function daysUntilEarnings(
  dateISO: string | null | undefined,
  todayISO: string,
): number | null {
  if (!dateISO) return null;
  const target = Date.parse(`${dateISO}T00:00:00Z`);
  const today = Date.parse(`${todayISO}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(today)) return null;
  return Math.round((target - today) / DAY_MS);
}
