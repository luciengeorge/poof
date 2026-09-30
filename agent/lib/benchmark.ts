/**
 * Benchmark the account against buy-and-hold SPY. A baseline (equity + SPY price) is
 * captured once at inception; alpha is the account's return minus SPY's return over the
 * same window. Pure + unit-tested. If the agent can't beat holding SPY, it should hold SPY.
 */
export interface Benchmark {
  inceptionEquity: number;
  inceptionSpyPrice: number;
  inceptionDate: string; // YYYY-MM-DD (ET)
}

export interface AlphaResult {
  accountReturnPct: number; // since inception, %
  spyReturnPct: number; // since inception, %
  alphaPct: number; // account - spy, percentage points
}

const pctChange = (from: number, to: number): number =>
  from > 0 ? ((to - from) / from) * 100 : 0;

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

export function computeAlpha(
  baseline: Benchmark,
  currentEquity: number,
  currentSpyPrice: number,
): AlphaResult {
  const accountReturnPct = pctChange(baseline.inceptionEquity, currentEquity);
  const spyReturnPct = pctChange(baseline.inceptionSpyPrice, currentSpyPrice);
  return {
    accountReturnPct,
    spyReturnPct,
    alphaPct: accountReturnPct - spyReturnPct,
  };
}
