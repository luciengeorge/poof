import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAlpha, type Benchmark } from "./benchmark.ts";

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
