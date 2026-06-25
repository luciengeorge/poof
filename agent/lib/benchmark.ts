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
