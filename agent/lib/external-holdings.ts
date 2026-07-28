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
