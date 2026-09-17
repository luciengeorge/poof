import assert from "node:assert/strict";
import test from "node:test";

import { calibrationFrom, MIN_CALIBRATION_SAMPLE } from "./calibration.ts";

/**
 * Mutation testing showed calibrationFrom could ignore its `field` argument and stay green: no
 * test scored the shadow forecaster. Two forecasters that disagree must produce two different
 * scores, or the comparison the shadow exists for is fiction.
 */
test("the shadow forecaster is scored from its own field, not the agent's", () => {
  // Agent claims 0.9 on every trade; Jev says 0.1. Two thirds of the trades win, so the two
  // forecasters are wrong by different amounts (an even split would give equal Brier scores by
  // symmetry and prove nothing).
  const trades = Array.from({ length: MIN_CALIBRATION_SAMPLE + 2 }, (_v, i) => ({
    status: "closed",
    predictedConfidence: 0.9,
    jevConfidence: 0.1,
    pnl: i % 3 === 0 ? -5 : 5,
  }));
  const agent = calibrationFrom(trades);
  const jev = calibrationFrom(trades, "jevConfidence");
  // Means of repeated decimals accumulate float error; compare within a hair, not exactly.
  assert.ok(Math.abs((agent.meanPredicted ?? 0) - 0.9) < 1e-9);
  assert.ok(Math.abs((jev.meanPredicted ?? 0) - 0.1) < 1e-9);
  assert.equal(agent.verdict, "overconfident");
  assert.equal(jev.verdict, "underconfident");
  assert.notEqual(agent.brierScore, jev.brierScore);
});

test("a trade with no shadow forecast is not scored against the shadow", () => {
  const trades = [
    { status: "closed", predictedConfidence: 0.7, pnl: 1 },
    { status: "closed", predictedConfidence: 0.7, jevConfidence: 0.6, pnl: 1 },
  ];
  assert.equal(calibrationFrom(trades).scored, 2);
  assert.equal(calibrationFrom(trades, "jevConfidence").scored, 1);
});
