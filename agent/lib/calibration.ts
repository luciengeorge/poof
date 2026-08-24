import { outcomeKind } from "./positions.ts";
/**
 * CALIBRATION: does the confidence the agent claimed at entry match what actually happened?
 *
 * WHY THIS EXISTS. The report judge already grades a dimension called "calibration", but it does so
 * by reading the prose and forming an opinion about how hedged it sounds. That is not a measurement.
 * "The Alpha Illusion" (arXiv 2605.16895) lists epistemic calibration as protocol P4 precisely
 * because language confidence is routinely miscalibrated as trading probability: an agent can sound
 * appropriately uncertain while being systematically wrong, or sound hedged while being reliably
 * right. Neither is visible without scoring predictions against outcomes.
 *
 * So the agent records a numeric confidence when it opens a position, and this module scores those
 * predictions once the trades close. The output is a number and a named verdict, not an impression.
 *
 * WHAT COUNTS AS A HIT. A BUY predicts the position makes money. Realised P&L above zero is a hit,
 * at or below zero a miss. Deliberately crude: on this account the alternative (predicting a
 * magnitude or a horizon) needs far more data before it could be scored at all, and a coarse
 * measurement that is honest beats a precise one that is noise.
 *
 * Pure: no I/O, no clock, no environment. An OBSERVER: nothing here feeds the risk gate, sizing, or
 * order placement. It informs the agent's own self-assessment and the weekly report.
 */

/** The subset of a stored trade this module needs. */
export interface ScoredTradeLike {
  status: string;
  /** What the agent claimed at entry, 0..1. Absent for trades opened before this was recorded. */
  predictedConfidence?: number;
  /** Realised P&L in GBP. Absent means the outcome was never established. */
  pnl?: number;
}

/**
 * How many scored trades before a calibration verdict means anything.
 *
 * Ten is already generous: at n=10 the sampling error on a hit rate is roughly +/-15 percentage
 * points, so only a gross miscalibration is detectable. Below it the verdict is
 * "insufficient-data", which is a real answer rather than a placeholder.
 */
export const MIN_CALIBRATION_SAMPLE = 10;

/** How far claimed confidence may sit from realised hit rate before it is called miscalibrated. */
const CALIBRATION_TOLERANCE = 0.15;

export type CalibrationVerdict =
  | "no-data"
  | "insufficient-data"
  | "calibrated"
  | "overconfident"
  | "underconfident";

export interface CalibrationBucket {
  label: string;
  n: number;
  hitRate: number;
  meanPredicted: number;
}

export interface CalibrationResult {
  /** Closed trades that carried a confidence AND an established outcome. */
  scored: number;
  /** Closed trades that carried a confidence but whose outcome was never established. */
  unknownOutcomes: number;
  hitRate?: number;
  meanPredicted?: number;
  /** meanPredicted - hitRate. Positive means overconfident. */
  gap?: number;
  /** Mean squared error of the forecasts, 0 is perfect and 0.25 is a coin flip claimed at 50%. */
  brierScore?: number;
  buckets: CalibrationBucket[];
  verdict: CalibrationVerdict;
  note: string;
}

const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0.0-0.2", min: 0, max: 0.2 },
  { label: "0.2-0.4", min: 0.2, max: 0.4 },
  { label: "0.4-0.6", min: 0.4, max: 0.6 },
  { label: "0.6-0.8", min: 0.6, max: 0.8 },
  { label: "0.8-1.0", min: 0.8, max: 1.0001 },
];

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function calibrationFrom(trades: readonly ScoredTradeLike[]): CalibrationResult {
  // `closed-estimated` is EXCLUDED here, and that differs from attribution.ts on purpose. This
  // module scores a FORECAST, so it needs an outcome that actually happened at a known price; an
  // outcome reconstructed from the last observed price would make the Brier score look precise
  // while resting on a proxy. Attribution can tolerate that because it only claims correlation.
  // REAL outcomes only, decided by status. Two exclusions with different reasons:
  // `estimated` because scoring a forecast needs a price that actually happened, not a proxy; and
  // `unknown` because its `pnl: 0` is a placeholder, so a presence check would score a forecast
  // against a fabricated break-even and quietly call it a loss.
  // Every CLOSED trade that carried a forecast, whatever became of it. Kept wide on purpose so
  // `unknownOutcomes` below stays a meaningful count rather than silently collapsing to zero: an
  // unscoreable forecast is information, and hiding it would repeat the very failure this module
  // was built to expose.
  const withConfidence = trades.filter(
    (t) => typeof t.predictedConfidence === "number" && t.status.startsWith("closed"),
  );
  const scored = withConfidence.filter((t) => outcomeKind(t) === "real");
  const unknownOutcomes = withConfidence.length - scored.length;

  if (scored.length === 0) {
    return {
      scored: 0,
      unknownOutcomes,
      buckets: [],
      verdict: "no-data",
      note:
        "No closed trade carries both a recorded confidence and an established outcome, so " +
        "calibration is UNMEASURED. It is not good and it is not bad: it is unknown. This " +
        "resolves itself as positions opened with a recorded confidence close.",
    };
  }

  const predictions = scored.map((t) => t.predictedConfidence as number);
  const outcomes = scored.map((t) => ((t.pnl as number) > 0 ? 1 : 0));
  const hitRate = mean(outcomes);
  const meanPredicted = mean(predictions);
  const gap = meanPredicted - hitRate;
  const brierScore = mean(predictions.map((p, i) => (p - (outcomes[i] as number)) ** 2));

  const buckets: CalibrationBucket[] = [];
  for (const b of BUCKETS) {
    const indices = predictions
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p >= b.min && p < b.max)
      .map(({ i }) => i);
    if (indices.length === 0) continue; // an empty bucket is omitted, not shown as a zero
    buckets.push({
      label: b.label,
      n: indices.length,
      hitRate: mean(indices.map((i) => outcomes[i] as number)),
      meanPredicted: mean(indices.map((i) => predictions[i] as number)),
    });
  }

  if (scored.length < MIN_CALIBRATION_SAMPLE) {
    return {
      scored: scored.length,
      unknownOutcomes,
      hitRate,
      meanPredicted,
      gap,
      brierScore,
      buckets,
      verdict: "insufficient-data",
      note:
        `Only ${scored.length} scored prediction(s); at least ${MIN_CALIBRATION_SAMPLE} are ` +
        "needed before a calibration verdict means anything. The figures below are reported for " +
        "transparency, NOT as evidence: at this sample size the sampling error swamps the signal.",
    };
  }

  const verdict: CalibrationVerdict =
    Math.abs(gap) <= CALIBRATION_TOLERANCE
      ? "calibrated"
      : gap > 0
        ? "overconfident"
        : "underconfident";

  return {
    scored: scored.length,
    unknownOutcomes,
    hitRate,
    meanPredicted,
    gap,
    brierScore,
    buckets,
    verdict,
    note: buildNote({ verdict, scored: scored.length, hitRate, meanPredicted, gap, brierScore }),
  };
}

function buildNote(x: {
  verdict: CalibrationVerdict;
  scored: number;
  hitRate: number;
  meanPredicted: number;
  gap: number;
  brierScore: number;
}): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const head =
    `Across ${x.scored} scored predictions you claimed ${pct(x.meanPredicted)} on average and ` +
    `were right ${pct(x.hitRate)} of the time (Brier ${x.brierScore.toFixed(3)}).`;
  if (x.verdict === "calibrated") {
    return `${head} That is CALIBRATED within tolerance: keep stating confidence the way you do.`;
  }
  if (x.verdict === "overconfident") {
    return (
      `${head} That is OVERCONFIDENT by ${pct(x.gap)}. State lower confidence for the same kind ` +
      "of thesis, and size accordingly: the risk gate caps size, but nothing stops you claiming " +
      "more certainty than your record supports."
    );
  }
  return (
    `${head} That is UNDERCONFIDENT by ${pct(-x.gap)}. Your theses work out more often than you ` +
    "say, so excessive hedging is costing you conviction on trades that deserved it."
  );
}
