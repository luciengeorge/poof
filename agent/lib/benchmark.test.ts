import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAlpha, rebaseForCashFlow, type Benchmark } from "./benchmark.ts";

const closeTo = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );

const base: Benchmark = {
  inceptionEquity: 50,
  inceptionSpyPrice: 500,
  inceptionDate: "2026-06-25",
};

test("computeAlpha: positive alpha when account beats SPY", () => {
  // account +10% (50 -> 55), SPY +4% (500 -> 520)
  const r = computeAlpha(base, 55, 520);
  assert.equal(Math.round(r.accountReturnPct), 10);
  assert.equal(Math.round(r.spyReturnPct), 4);
  assert.equal(Math.round(r.alphaPct), 6);
});

test("computeAlpha: negative alpha when account lags SPY", () => {
  // account +2%, SPY +8%
  const r = computeAlpha(base, 51, 540);
  assert.equal(Math.round(r.accountReturnPct), 2);
  assert.equal(Math.round(r.spyReturnPct), 8);
  assert.equal(Math.round(r.alphaPct), -6);
});

test("computeAlpha: guards divide-by-zero baseline", () => {
  const r = computeAlpha(
    { inceptionEquity: 0, inceptionSpyPrice: 0, inceptionDate: "x" },
    55,
    520,
  );
  assert.equal(r.accountReturnPct, 0);
  assert.equal(r.spyReturnPct, 0);
  assert.equal(r.alphaPct, 0);
});

test("rebaseForCashFlow: the return measured so far is unchanged by the rebase", () => {
  const b: Benchmark = {
    inceptionEquity: 137.5,
    inceptionSpyPrice: 620,
    inceptionDate: "2026-06-25",
  };
  const equityBefore = 164.3;
  const equityAfter = equityBefore + 500; // deposit
  const rebased = rebaseForCashFlow(b, equityBefore, equityAfter);
  closeTo(
    computeAlpha(rebased, equityAfter, 620).accountReturnPct,
    computeAlpha(b, equityBefore, 620).accountReturnPct,
    1e-9,
  );
  // The deposit says nothing about SPY, so the market side of the baseline must not move.
  assert.equal(rebased.inceptionSpyPrice, b.inceptionSpyPrice);
  assert.equal(rebased.inceptionDate, b.inceptionDate);
});

test("rebaseForCashFlow: a deposit does not count as a gain", () => {
  // 100 -> 110 (+10%), deposit 90 to reach 200, then trading takes it to 220.
  // Two 10% legs compound to +21%, not the +120% a naive baseline would report.
  const b: Benchmark = {
    inceptionEquity: 100,
    inceptionSpyPrice: 500,
    inceptionDate: "2026-06-25",
  };
  assert.equal(computeAlpha(b, 220, 500).accountReturnPct, 120);
  const rebased = rebaseForCashFlow(b, 110, 200);
  closeTo(rebased.inceptionEquity, 181.818181818, 1e-6);
  closeTo(computeAlpha(rebased, 220, 500).accountReturnPct, 21, 1e-9);
});

test("rebaseForCashFlow: a withdrawal is the same arithmetic", () => {
  // 100 -> 150 (+50%), withdraw 50 to leave 100, then it grows to 120 (+20%).
  const b: Benchmark = {
    inceptionEquity: 100,
    inceptionSpyPrice: 500,
    inceptionDate: "2026-06-25",
  };
  const rebased = rebaseForCashFlow(b, 150, 100);
  closeTo(rebased.inceptionEquity, 66.666666666, 1e-6);
  closeTo(computeAlpha(rebased, 100, 500).accountReturnPct, 50, 1e-9);
  closeTo(computeAlpha(rebased, 120, 500).accountReturnPct, 80, 1e-9); // 1.5 * 1.2 - 1
});

test("rebaseForCashFlow: rejects bad numbers instead of returning a wrong baseline", () => {
  const b: Benchmark = {
    inceptionEquity: 100,
    inceptionSpyPrice: 500,
    inceptionDate: "2026-06-25",
  };
  assert.throws(() => rebaseForCashFlow(b, Number.NaN, 200), /equityBefore/);
  assert.throws(() => rebaseForCashFlow(b, 110, Number.NaN), /equityAfter/);
  assert.throws(() => rebaseForCashFlow(b, 110, Number.POSITIVE_INFINITY), /equityAfter/);
  assert.throws(() => rebaseForCashFlow(b, 0, 200), /equityBefore/);
  assert.throws(() => rebaseForCashFlow(b, -110, 200), /equityBefore/);
  assert.throws(() => rebaseForCashFlow(b, 110, 0), /equityAfter/);
  assert.throws(
    () => rebaseForCashFlow({ ...b, inceptionEquity: 0 }, 110, 200),
    /inceptionEquity/,
  );
  assert.throws(
    () => rebaseForCashFlow({ ...b, inceptionEquity: Number.NaN }, 110, 200),
    /inceptionEquity/,
  );
});

test("rebaseForCashFlow: pins the live baseline defect (deposit read as +400%)", () => {
  // The stored live baseline, captured while the account held GBP 50, before it was funded
  // to about GBP 250. Current SPY is a fixture chosen to put SPY at the +3.98% it had run.
  const stored: Benchmark = {
    inceptionEquity: 50,
    inceptionSpyPrice: 734.98,
    inceptionDate: "2026-06-25",
  };
  const currentEquity = 250.77;
  const currentSpy = 764.24;

  const broken = computeAlpha(stored, currentEquity, currentSpy);
  closeTo(broken.accountReturnPct, 401.54, 0.01);
  closeTo(broken.alphaPct, 397.56, 0.01); // the number the Friday scorecard published

  // Total realised P&L across all 52 closed trades was GBP 4.47, so the truth is roughly flat.
  const corrected: Benchmark = {
    inceptionEquity: 252.17,
    inceptionSpyPrice: 754.81,
    inceptionDate: "2026-07-15",
  };
  closeTo(computeAlpha(corrected, currentEquity, currentSpy).accountReturnPct, -0.56, 0.01);
});

// --- SPY's return in the account's currency -------------------------------------------------
// The account is a GBP ISA; SPY is quoted in USD. Subtracting a USD return from a GBP one
// answered the wrong question and flattered poof by the size of the currency move.

// 2026-07-15 inception. GBPUSD 1.35387 at inception, 1.322975 on 2026-09-29, inverted to the
// USD->GBP convention the rest of the codebase uses.
const INCEPTION_FX = 0.7386247; // 1 / 1.35387
const CURRENT_FX = 0.7558725; // 1 / 1.322975

const liveBaseline: Benchmark = {
  inceptionEquity: 252.17,
  inceptionSpyPrice: 754.81,
  inceptionDate: "2026-07-15",
  inceptionFxRate: INCEPTION_FX,
};

test("computeAlpha: the live GBP/USD mismatch, priced in the account's currency", () => {
  const r = computeAlpha(liveBaseline, 250.77, 764.2, CURRENT_FX);
  assert.equal(r.spyReturnBasis, "GBP");
  closeTo(r.accountReturnPct, -0.5552, 0.005);
  // +1.24% in USD, but sterling weakened, so a UK holder of SPY earned +3.61%.
  closeTo(r.spyReturnPct, 3.6082, 0.005);
  closeTo(r.alphaPct, -4.1634, 0.005);
});

test("computeAlpha: without FX it reports the old USD number AND labels it", () => {
  const { inceptionFxRate, ...noFx } = liveBaseline;
  const r = computeAlpha(noFx, 250.77, 764.2);
  assert.equal(r.spyReturnBasis, "USD-unadjusted");
  closeTo(r.spyReturnPct, 1.2440, 0.005);
  closeTo(r.alphaPct, -1.7992, 0.005);
  // 2.36pp of the published alpha was the currency move, not performance.
  closeTo(r.alphaPct - computeAlpha(liveBaseline, 250.77, 764.2, CURRENT_FX).alphaPct, 2.3642, 0.005);
});

test("computeAlpha: a currency move alone moves SPY's return even with SPY flat in USD", () => {
  const flat = computeAlpha(liveBaseline, 252.17, 754.81, CURRENT_FX);
  assert.equal(flat.spyReturnBasis, "GBP");
  // 0.7558725 / 0.7386247 - 1
  closeTo(flat.spyReturnPct, 2.3351, 0.005);
  assert.equal(flat.accountReturnPct, 0);
  closeTo(flat.alphaPct, -2.3351, 0.005);
  // The old comparison saw nothing at all.
  assert.equal(computeAlpha(liveBaseline, 252.17, 754.81).spyReturnPct, 0);
});

test("computeAlpha: only one rate is not enough for a GBP basis", () => {
  assert.equal(
    computeAlpha(liveBaseline, 250.77, 764.2).spyReturnBasis,
    "USD-unadjusted",
  );
  const { inceptionFxRate, ...noFx } = liveBaseline;
  const r = computeAlpha(noFx, 250.77, 764.2, CURRENT_FX);
  assert.equal(r.spyReturnBasis, "USD-unadjusted");
  closeTo(r.spyReturnPct, 1.2440, 0.005);
});

test("computeAlpha: an unusable rate downgrades rather than producing a wrong percentage", () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.75];
  for (const rate of bad) {
    const viaCurrent = computeAlpha(liveBaseline, 250.77, 764.2, rate);
    assert.equal(viaCurrent.spyReturnBasis, "USD-unadjusted", `current rate ${rate}`);
    closeTo(viaCurrent.spyReturnPct, 1.2440, 0.005);

    const viaInception = computeAlpha(
      { ...liveBaseline, inceptionFxRate: rate },
      250.77,
      764.2,
      CURRENT_FX,
    );
    assert.equal(viaInception.spyReturnBasis, "USD-unadjusted", `inception rate ${rate}`);
    closeTo(viaInception.spyReturnPct, 1.2440, 0.005);
  }
});

test("rebaseForCashFlow: a cash flow says nothing about FX, so the inception rate survives", () => {
  const rebased = rebaseForCashFlow(liveBaseline, 250.77, 350.77);
  assert.equal(rebased.inceptionFxRate, INCEPTION_FX);
  assert.equal(
    computeAlpha(rebased, 350.77, 764.2, CURRENT_FX).spyReturnBasis,
    "GBP",
  );
});
