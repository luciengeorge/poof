/**
 * Benchmark the account against buy-and-hold SPY. A baseline (equity + SPY price) is
 * captured once at inception; alpha is the account's return minus SPY's return over the
 * same window. Pure + unit-tested. If the agent can't beat holding SPY, it should hold SPY.
 */
export interface Benchmark {
  inceptionEquity: number;
  inceptionSpyPrice: number;
  inceptionDate: string; // YYYY-MM-DD (ET)
  /**
   * USD -> GBP at inception, same convention as fx.ts `resolveUsdGbp` and execution.ts
   * `deployedValueGbp`: multiply a USD price by it to get GBP. Optional because baselines
   * captured before this existed have no rate, and there is no honest way to invent one.
   */
  inceptionFxRate?: number;
}

/**
 * Which currency SPY's return is measured in. The account is a GBP ISA, so "GBP" is the only
 * basis that answers "would a UK investor have done better just holding SPY". "USD-unadjusted"
 * ignores the currency move and is reported, never hidden, when a rate is missing.
 */
export type SpyReturnBasis = "GBP" | "USD-unadjusted";

export interface AlphaResult {
  accountReturnPct: number; // since inception, %
  spyReturnPct: number; // since inception, %
  alphaPct: number; // account - spy, percentage points
  spyReturnBasis: SpyReturnBasis;
}

const pctChange = (from: number, to: number): number =>
  from > 0 ? ((to - from) / from) * 100 : 0;

const usableRate = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

const requirePositive = (n: number, label: string): void => {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `rebaseForCashFlow: ${label} must be a positive finite number, got ${n}`,
    );
  }
};

/**
 * Rebase the baseline across a cash flow (deposit or withdrawal) so the return measured so
 * far is unchanged and everything after the flow measures trading rather than funding.
 * Nothing else here distinguishes a deposit from a gain: funding the live account from
 * GBP 50 to about GBP 250 made it report +400% that no trade ever earned.
 *
 * Standard chain-linking. We want the rebased return at the moment of the flow to equal the
 * pre-flow return, so `(after - I') / I' = (before - I) / I`, which gives `I' = I * after/before`.
 *
 * Throws instead of returning a wrong number: this value is written once into the performance
 * record, where a bad baseline is both permanent and invisible.
 */
export function rebaseForCashFlow(
  baseline: Benchmark,
  equityBefore: number,
  equityAfter: number,
): Benchmark {
  requirePositive(baseline.inceptionEquity, "inceptionEquity");
  requirePositive(equityBefore, "equityBefore");
  // A rebase to zero would poison computeAlpha's divide-by-zero guard into reporting 0% forever.
  requirePositive(equityAfter, "equityAfter");
  return {
    ...baseline,
    inceptionEquity: baseline.inceptionEquity * (equityAfter / equityBefore),
  };
}

/**
 * Alpha since inception. The account is GBP and SPY is quoted in USD, so SPY's return is
 * converted to GBP whenever both FX rates are known: a UK investor who held SPY instead would
 * have earned the currency move too. Over 15 Jul to 29 Sep 2026 SPY rose 1.24% in USD but
 * 3.61% in GBP, so the unadjusted comparison overstated alpha by 2.4pp in poof's favour.
 *
 * With either rate missing or unusable we fall back to the raw USD comparison and SAY SO via
 * `spyReturnBasis`, rather than returning a number that looks like the GBP one. Degrade and
 * label; never throw, because a cycle must still report performance when FX is unavailable.
 */
export function computeAlpha(
  baseline: Benchmark,
  currentEquity: number,
  currentSpyPrice: number,
  currentFxRate?: number,
): AlphaResult {
  const accountReturnPct = pctChange(baseline.inceptionEquity, currentEquity);
  const inceptionFx = baseline.inceptionFxRate;
  const gbpBasis = usableRate(inceptionFx) && usableRate(currentFxRate);
  const spyReturnPct = gbpBasis
    ? pctChange(baseline.inceptionSpyPrice * inceptionFx, currentSpyPrice * currentFxRate)
    : pctChange(baseline.inceptionSpyPrice, currentSpyPrice);
  return {
    accountReturnPct,
    spyReturnPct,
    alphaPct: accountReturnPct - spyReturnPct,
    spyReturnBasis: gbpBasis ? "GBP" : "USD-unadjusted",
  };
}
