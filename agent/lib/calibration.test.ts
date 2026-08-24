import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrationFrom,
  MIN_CALIBRATION_SAMPLE,
  type ScoredTradeLike,
} from "./calibration.ts";

function t(predictedConfidence: number | undefined, pnl: number | undefined): ScoredTradeLike {
  return {
    status: "closed",
    ...(predictedConfidence !== undefined ? { predictedConfidence } : {}),
    ...(pnl !== undefined ? { pnl } : {}),
  };
}

/** Means are computed, so compare them with a tolerance rather than for exact equality. */
function closeTo(actual: number | undefined, expected: number, epsilon = 1e-9): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < epsilon,
    `expected ~${expected}, got ${actual}`,
  );
}

/** n trades at one confidence, `wins` of which made money. */
function batch(confidence: number, n: number, wins: number): ScoredTradeLike[] {
  return Array.from({ length: n }, (_, i) => t(confidence, i < wins ? 5 : -5));
}

// --- honesty when there is nothing to say ---

test("no recorded confidence at all reports NO DATA, never a flattering score", () => {
  const result = calibrationFrom([t(undefined, 5), t(undefined, -5)]);
  assert.equal(result.scored, 0);
  assert.equal(result.verdict, "no-data");
  assert.match(result.note, /no closed trade/i);
  assert.equal(result.brierScore, undefined);
});

test("below the sample threshold the verdict is insufficient, not calibrated", () => {
  const result = calibrationFrom(batch(0.7, MIN_CALIBRATION_SAMPLE - 1, 2));
  assert.equal(result.verdict, "insufficient-data");
  assert.match(result.note, new RegExp(`${MIN_CALIBRATION_SAMPLE}`));
});

test("an open trade is not scoreable, however confident the thesis was", () => {
  const result = calibrationFrom([
    { status: "placed", predictedConfidence: 0.9 },
    { status: "placed", predictedConfidence: 0.8 },
  ]);
  assert.equal(result.scored, 0);
  assert.equal(result.verdict, "no-data");
});

test("a closed trade with an unknown outcome cannot score a prediction", () => {
  const result = calibrationFrom([t(0.9, undefined), t(0.8, undefined)]);
  assert.equal(result.scored, 0);
  assert.equal(result.unknownOutcomes, 2);
});

// --- the actual measurement ---

test("consistent overconfidence is detected and named", () => {
  // Claimed 90% and won 30% of the time.
  const result = calibrationFrom(batch(0.9, 10, 3));
  assert.equal(result.scored, 10);
  assert.equal(result.verdict, "overconfident");
  closeTo(result.hitRate, 0.3);
  closeTo(result.meanPredicted, 0.9);
  assert.ok((result.gap ?? 0) > 0, "gap is positive when claimed exceeds realised");
  assert.match(result.note, /overconfident/i);
});

test("underconfidence is detected too, and is also worth knowing", () => {
  const result = calibrationFrom(batch(0.4, 10, 9));
  assert.equal(result.verdict, "underconfident");
  assert.ok((result.gap ?? 0) < 0);
});

test("a well-calibrated record is reported as calibrated", () => {
  const result = calibrationFrom(batch(0.6, 10, 6));
  assert.equal(result.verdict, "calibrated");
  closeTo(result.hitRate, 0.6);
  assert.ok(Math.abs(result.gap ?? 1) < 0.05);
});

test("the Brier score rewards a sharp correct forecast over a hedged one", () => {
  const confident = calibrationFrom(batch(0.9, 10, 9)).brierScore ?? 1;
  const hedged = calibrationFrom(batch(0.5, 10, 9)).brierScore ?? 1;
  assert.ok(confident < hedged, "being right AND confident should score better");
});

test("the Brier score punishes a confident wrong forecast hardest", () => {
  const confidentWrong = calibrationFrom(batch(0.9, 10, 1)).brierScore ?? 0;
  const hedgedWrong = calibrationFrom(batch(0.5, 10, 1)).brierScore ?? 0;
  assert.ok(confidentWrong > hedgedWrong);
});

// --- per-bucket detail, so the shape of the error is visible ---

test("buckets show WHERE the miscalibration is, not just that it exists", () => {
  const result = calibrationFrom([
    ...batch(0.9, 6, 1), // wildly overconfident at the top
    ...batch(0.5, 6, 3), // fine in the middle
  ]);
  const high = result.buckets.find((b) => b.label === "0.8-1.0");
  const mid = result.buckets.find((b) => b.label === "0.4-0.6");
  assert.ok(high && mid);
  assert.equal(high.n, 6);
  closeTo(high.hitRate, 1 / 6);
  closeTo(mid.hitRate, 0.5);
});

test("a bucket with nothing in it is omitted rather than shown as zero", () => {
  const result = calibrationFrom(batch(0.9, 10, 5));
  assert.deepEqual(result.buckets.map((b) => b.label), ["0.8-1.0"]);
});

test("calibration is pure and does not mutate its input", () => {
  const trades = batch(0.7, 3, 2);
  const copy = JSON.parse(JSON.stringify(trades));
  calibrationFrom(trades);
  assert.deepEqual(JSON.parse(JSON.stringify(trades)), copy);
});

// --- the placeholder-zero trap, on the scoring side ---

test("REGRESSION: a closed-unknown placeholder never scores a forecast", () => {
  // Its pnl 0 is a placeholder. Scoring it would mark a confident call WRONG on no evidence.
  const rows = Array.from({ length: 12 }, () => ({
    status: "closed-unknown",
    predictedConfidence: 0.8,
    pnl: 0,
  }));
  const result = calibrationFrom(rows);
  assert.equal(result.scored, 0);
  assert.equal(result.verdict, "no-data");
});

test("closed-estimated is excluded too: a forecast needs a price that actually happened", () => {
  const rows = Array.from({ length: 12 }, () => ({
    status: "closed-estimated",
    predictedConfidence: 0.8,
    pnl: 5,
  }));
  assert.equal(calibrationFrom(rows).scored, 0);
});
