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
