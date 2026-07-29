/**
 * THE READ PATH for poof's online evals: what the last window of production cycles actually
 * proved, in words a human will read once a week.
 *
 * WHY THIS EXISTS. Violations already alert immediately (agent/hooks/trace-cycle.ts), but
 * nothing surfaced the AGGREGATE, so the most dangerous state was invisible: a guard that has
 * quietly stopped being reached. An online eval nobody reads is not an online eval. Silence
 * from an alert channel is not evidence, it is the absence of evidence, and those two look
 * identical unless something says so out loud.
 *
 * SO THE VACUITY RATE IS THE HEADLINE, not a footnote. The submit-gated invariants are
 * CONDITIONAL ("if the agent bought, it must have checked earnings first"), and on a no-trade
 * cycle they hold vacuously. If `earnings-before-buy` was not-applicable in 5 of 5 cycles, the
 * guarded path was NEVER EXERCISED and the guard is UNVERIFIED. Reporting that as "the guard is
 * fine" is the exact confusion the 3-state design in agent/lib/invariants.ts exists to prevent,
 * so the wording here is deliberately blunt about it.
 *
 * Also called out rather than silently dropped: truncated traces (tools past the recording cap
 * are missing, so absence proves nothing), cycles that never finished, and cycles the judge
 * could not grade. And poof's standing small-sample honesty rule applies: with only a handful
 * of cycles in the window, say the sample is too small instead of narrating a trend.
 *
 * Pure: no I/O, no clock, no environment. The caller supplies the window. This module is an
 * OBSERVER, its output is prose for a human, and nothing here is ever an input to the risk
 * gate, position sizing, or order placement (see the isolation tests in observers.test.ts).
 */

import { INVARIANT_NAMES } from "./invariants.ts";
import { DEFAULT_JUDGE_THRESHOLDS, JUDGE_DIMENSIONS } from "./report-judge.ts";

/**
 * Below this many completed cycles in the window, the sample is too small to read as a trend.
 * The cycle runs once per weekday, so a healthy week is about 5.
 */
export const SMALL_SAMPLE_CYCLES = 5;

/** Below this many judged cycles, the report-quality trend is not claimed at all. */
export const MIN_TREND_CYCLES = 4;

/** The reporting window: the scorecard is weekly, so it covers the week just ended. */
export const EVAL_WINDOW_DAYS = 7;

/** A half-over-half move in mean `overall` smaller than this is flat, not a direction. */
export const TREND_DELTA = 0.5;

/** A stored judge verdict, as it comes back from the cycleTraces row. */
export interface StoredReportScore {
  status: string; // "judged" | "unjudged"
  grounding?: number;
  consistency?: number;
  calibration?: number;
  completeness?: number;
  overall?: number;
  findings?: string[];
  warning?: string;
}

/** The subset of a stored cycle trace this aggregation reads. */
export interface EvalHealthTrace {
  sessionId: string;
  turnId: string;
  /** Absent means the turn never reached its terminal boundary: the cycle did not finish. */
  completedAt?: number;
  /** Only used to place an UNFINISHED trace in the window, since it has no `completedAt`. */
  startedAt?: number;
  truncated?: boolean;
  toolSequence: readonly string[];
  invariants: readonly { name: string; status: string; detail?: string }[];
  reportScore?: StoredReportScore;
  judgedAt?: number;
}

export interface InvariantHealth {
  name: string;
  pass: number;
  fail: number;
  notApplicable: number;
  /** A status this build does not recognise. Never folded into `pass`. */
  unknown: number;
  /** Cycles in the window that recorded a verdict for this guard at all. */
  recorded: number;
  /** Fraction of recorded cycles in which the guard held vacuously, 0 when nothing recorded. */
  vacuityPct: number;
  /** Recorded, but not once reached: UNVERIFIED, not passing. */
  neverExercised: boolean;
  /** The unambiguous one-line wording for this guard. */
  note: string;
}

export interface ViolationEntry {
  sessionId: string;
  turnId: string;
  completedAt?: number;
  invariant: string;
  detail: string;
  /** The ordered tool sequence, joined, so a human can see what the cycle actually did. */
  toolSequence: string;
}

export interface CycleRef {
  sessionId: string;
  turnId: string;
  completedAt?: number;
}

export interface TruncatedEntry extends CycleRef {
  toolCount: number;
}

export interface UnjudgedEntry extends CycleRef {
  warning: string;
}

export interface LowGroundingEntry extends CycleRef {
  grounding: number;
  overall: number;
  findings: string[];
}

export type ReportQualityTrend = "improving" | "declining" | "flat" | "insufficient-data";

export interface ReportQualityHealth {
  /** Cycles with a usable verdict. */
  judged: number;
  /** Cycles the judge pass has not reached yet. */
  notJudged: number;
  /** Cycles the judge answered unusably. Recorded as unjudged, never as a passing score. */
  unjudged: UnjudgedEntry[];
  averages: Record<string, number> | null;
  trend: ReportQualityTrend;
  lowGrounding: LowGroundingEntry[];
}

/**
 * How much of the REQUESTED window the data actually reaches.
 *
 * The caller reads a BOUNDED number of traces (Convex caps `recentCycleTraces`), so a wide
 * window can ask for more history than the scan can return. Silently reporting the aggregate as
 * if it covered the whole window would change a conclusion: a violation 40 days ago would simply
 * be invisible, and "no violations in 90 days" would be a false statement rather than a missing
 * one. So the shortfall is measured and stated.
 */
export interface WindowCoverage {
  requestedDays: number;
  /** The scan cap, not the window, decided how far back the data reaches. */
  truncatedByScanLimit: boolean;
  /** How many days the returned data actually spans, when the cap bit. */
  coveredDays?: number;
}

export interface EvalHealth {
  /** Completed cycles in the window. Unfinished traces are not counted here. */
  cycles: number;
  smallSample: boolean;
  invariants: InvariantHealth[];
  violations: ViolationEntry[];
  truncated: TruncatedEntry[];
  unfinished: CycleRef[];
  reportQuality: ReportQualityHealth;
  /** Absent when the caller did not measure coverage. */
  coverage?: WindowCoverage;
}

function ref(trace: EvalHealthTrace): CycleRef {
  return {
    sessionId: trace.sessionId,
    turnId: trace.turnId,
    completedAt: trace.completedAt,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every guard the window could speak about: the canonical list first, then any name a trace
 * carries that this build does not know (an older deploy's invariant). Reporting the canonical
 * list even when NO trace mentions it is the point: a guard that vanished from the pipeline
 * would otherwise disappear from the report entirely rather than showing up as unknown.
 */
function guardNames(traces: readonly EvalHealthTrace[]): string[] {
  const canonical = INVARIANT_NAMES as readonly string[];
  const extra: string[] = [];
  for (const trace of traces) {
    for (const result of trace.invariants) {
      if (!canonical.includes(result.name) && !extra.includes(result.name)) {
        extra.push(result.name);
      }
    }
  }
  return [...canonical, ...extra.sort()];
}

function invariantNote(health: Omit<InvariantHealth, "note">, cycles: number): string {
  const { name, pass, fail, notApplicable, unknown, recorded } = health;
  if (recorded === 0) {
    return cycles === 0
      ? `${name}: not recorded, because no completed cycle exists in this window. NOTHING is ` +
          "known about this guard."
      : `${name}: not recorded in any of the ${cycles} completed cycle(s) in this window, so ` +
          "NOTHING is known about this guard. It may have been removed from the pipeline.";
  }
  if (health.neverExercised) {
    return (
      `${name}: NEVER EXERCISED (not-applicable in ${notApplicable} of ${recorded} cycles). ` +
      "The guarded path was never reached, so this guard is UNVERIFIED. That is not the same " +
      "as passing, and it is not evidence the guard works."
    );
  }
  const suffix = fail > 0 ? " VIOLATED at least once, see below." : "";
  const unknownNote = unknown > 0 ? `, ${unknown} unrecognised status` : "";
  return (
    `${name}: ${pass} passed, ${fail} failed, ${notApplicable} not-applicable ` +
    `(guard not reached)${unknownNote} out of ${recorded} cycles ` +
    `(${health.vacuityPct}% vacuous).${suffix}`
  );
}

function aggregateInvariants(
  completed: readonly EvalHealthTrace[],
  names: readonly string[],
): InvariantHealth[] {
  return names.map((name) => {
    let pass = 0;
    let fail = 0;
    let notApplicable = 0;
    let unknown = 0;
    for (const trace of completed) {
      const result = trace.invariants.find((entry) => entry.name === name);
      if (!result) continue;
      if (result.status === "pass") pass += 1;
      else if (result.status === "fail") fail += 1;
      else if (result.status === "not-applicable") notApplicable += 1;
      else unknown += 1;
    }
    const recorded = pass + fail + notApplicable + unknown;
    const partial = {
      name,
      pass,
      fail,
      notApplicable,
      unknown,
      recorded,
      vacuityPct: recorded === 0 ? 0 : round2((notApplicable / recorded) * 100),
      // Recorded, reached by nothing: the vacuity case this whole module exists for.
      neverExercised: recorded > 0 && pass === 0 && fail === 0 && notApplicable > 0,
    };
    return { ...partial, note: invariantNote(partial, completed.length) };
  });
}

function aggregateReportQuality(
  completed: readonly EvalHealthTrace[],
): ReportQualityHealth {
  const judged: { trace: EvalHealthTrace; score: StoredReportScore }[] = [];
  const unjudged: UnjudgedEntry[] = [];
  let notJudged = 0;

  for (const trace of completed) {
    const score = trace.reportScore;
    if (!score) {
      notJudged += 1;
      continue;
    }
    if (score.status === "judged" && typeof score.overall === "number") {
      judged.push({ trace, score });
      continue;
    }
    // Anything else is an absence of a verdict, and is reported as one.
    unjudged.push({
      ...ref(trace),
      warning: score.warning ?? "the judge returned no usable verdict",
    });
  }

  const averages =
    judged.length === 0
      ? null
      : Object.fromEntries(
          JUDGE_DIMENSIONS.map((dimension) => [
            dimension,
            round2(
              mean(
                judged
                  .map(({ score }) => score[dimension])
                  .filter((value): value is number => typeof value === "number"),
              ),
            ),
          ]),
        );

  // Recover chronological order from completedAt: the caller's window comes back newest first.
  const overalls = [...judged]
    .sort((a, b) => (a.trace.completedAt ?? 0) - (b.trace.completedAt ?? 0))
    .map(({ score }) => score.overall as number);
  let trend: ReportQualityTrend = "insufficient-data";
  if (overalls.length >= MIN_TREND_CYCLES) {
    const split = Math.floor(overalls.length / 2);
    const delta = mean(overalls.slice(split)) - mean(overalls.slice(0, split));
    trend =
      delta >= TREND_DELTA ? "improving" : delta <= -TREND_DELTA ? "declining" : "flat";
  }

  const lowGrounding = judged
    .filter(
      ({ score }) =>
        typeof score.grounding === "number" &&
        score.grounding < DEFAULT_JUDGE_THRESHOLDS.groundingBelow,
    )
    .map(({ trace, score }) => ({
      ...ref(trace),
      grounding: score.grounding as number,
      overall: score.overall as number,
      findings: score.findings ?? [],
    }));

  return { judged: judged.length, notJudged, unjudged, averages, trend, lowGrounding };
}

/**
 * The traces that fall inside the reporting window, newest-first order preserved.
 *
 * An UNFINISHED trace has no `completedAt`, so it is placed by `startedAt` instead. Dropping it
 * for lack of a completion timestamp would silently hide the most interesting failure of all:
 * a cycle that died part-way through.
 */
export function withinWindow<T extends { completedAt?: number; startedAt?: number }>(
  traces: readonly T[],
  nowMs: number,
  windowDays: number = EVAL_WINDOW_DAYS,
): T[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  return traces.filter((trace) => (trace.completedAt ?? trace.startedAt ?? 0) >= cutoff);
}

/**
 * Did the SCAN CAP, rather than the requested window, decide how far back the data reaches?
 *
 * True only when the scan came back full AND its oldest row is still newer than the window
 * start: that is the case where more history exists but was not read. A full scan whose oldest
 * row already predates the window start covers the window completely, so there is nothing to
 * caveat. A scan that came back short read everything there is.
 *
 * A scan that is exactly full cannot distinguish "exactly this many rows exist" from "more
 * exist", so the wording it drives is deliberately about what IS covered rather than claiming a
 * precise count of what is missing.
 */
export function windowCoverage(
  fetchedCount: number,
  scanLimit: number,
  oldestFetchedMs: number | undefined,
  nowMs: number,
  requestedDays: number,
): WindowCoverage {
  const windowStart = nowMs - requestedDays * 86_400_000;
  const capped =
    fetchedCount >= scanLimit && oldestFetchedMs !== undefined && oldestFetchedMs > windowStart;
  if (!capped) return { requestedDays, truncatedByScanLimit: false };
  return {
    requestedDays,
    truncatedByScanLimit: true,
    coveredDays: Math.floor((nowMs - (oldestFetchedMs as number)) / 86_400_000),
  };
}

/** Aggregate one window of cycle traces. The caller decides what the window is. */
export function aggregateEvalHealth(
  traces: readonly EvalHealthTrace[],
  opts: { coverage?: WindowCoverage } = {},
): EvalHealth {
  const completed = traces.filter((trace) => trace.completedAt !== undefined);
  const unfinished = traces
    .filter((trace) => trace.completedAt === undefined)
    .map((trace) => ref(trace));

  return {
    cycles: completed.length,
    smallSample: completed.length < SMALL_SAMPLE_CYCLES,
    invariants: aggregateInvariants(completed, guardNames(traces)),
    violations: completed.flatMap((trace) =>
      trace.invariants
        .filter((result) => result.status === "fail")
        .map((result) => ({
          ...ref(trace),
          invariant: result.name,
          detail: result.detail ?? "no detail recorded",
          toolSequence: trace.toolSequence.join(" -> "),
        })),
    ),
    truncated: completed
      .filter((trace) => trace.truncated === true)
      .map((trace) => ({ ...ref(trace), toolCount: trace.toolSequence.length })),
    unfinished,
    reportQuality: aggregateReportQuality(completed),
    coverage: opts.coverage,
  };
}

/** Look one guard up by name. */
export function invariantHealthByName(
  health: EvalHealth,
  name: string,
): InvariantHealth | undefined {
  return health.invariants.find((entry) => entry.name === name);
}

function cycleLabel(entry: CycleRef): string {
  return `${entry.sessionId}/${entry.turnId}`;
}

/**
 * The eval-health section as ready-to-post lines.
 *
 * The wording lives HERE, in a tested pure function, rather than in the schedule prompt, so the
 * vacuity sentence cannot be softened by a model paraphrasing it. The scorecard prompt asks for
 * these lines verbatim.
 */
export function formatEvalHealth(health: EvalHealth): string[] {
  const lines: string[] = ["EVAL HEALTH (online evals, observe only)"];

  if (health.cycles === 0) {
    lines.push(
      "- No completed cycles were recorded in this window. Nothing was verified, and that " +
        "may itself be the problem: either no cycle ran, or the trace hook is not recording.",
    );
  } else {
    // Says what the number MEANS: these are cycles that finished and were checked against the
    // invariants. How many of them the judge reached is a separate figure, reported under report
    // quality below, and conflating the two would overstate what has been graded.
    lines.push(
      `- Window: ${health.cycles} completed cycle(s), each checked against the invariants. ` +
        "How many were judged for report quality is reported separately below.",
    );
    if (health.smallSample) {
      lines.push(
        `- The sample is too small to read as a trend: only ${health.cycles} completed ` +
          `cycle(s), fewer than ${SMALL_SAMPLE_CYCLES}. Treat what follows as individual ` +
          "cycles, not a rate.",
      );
    }
  }

  // Stated even on an otherwise clean window: "no violations" over a window the data does not
  // reach is a false reassurance, not a quiet omission.
  const coverage = health.coverage;
  if (coverage?.truncatedByScanLimit === true) {
    lines.push(
      `- COVERAGE WARNING: this does NOT cover the full ${coverage.requestedDays} days asked ` +
        `for. The trace scan cap was reached first, so only the last ${coverage.coveredDays} ` +
        "day(s) are covered. Anything older is invisible here, so read every count below as " +
        "covering that shorter period and nothing more.",
    );
  }

  lines.push("Guards (per invariant, over this window):");
  for (const entry of health.invariants) lines.push(`- ${entry.note}`);

  const neverExercised = health.invariants.filter((entry) => entry.neverExercised);
  if (neverExercised.length > 0) {
    lines.push(
      `- ${neverExercised.length} guard(s) were NEVER EXERCISED this window ` +
        `(${neverExercised.map((entry) => entry.name).join(", ")}). No cycle reached them, ` +
        "so nothing about them was verified.",
    );
  }

  lines.push("Violations:");
  if (health.violations.length === 0) {
    lines.push(
      "- No invariant violations in this window. Read that alongside the guard lines above: " +
        "a guard marked NEVER EXERCISED proves nothing either way.",
    );
  } else {
    for (const violation of health.violations) {
      lines.push(
        `- VIOLATION ${violation.invariant} in cycle ${cycleLabel(violation)}: ` +
          `${violation.detail}. Tool sequence: ${violation.toolSequence}`,
      );
    }
  }

  const quality = health.reportQuality;
  lines.push("Report quality (LLM-as-judge, 1 to 5):");
  if (quality.averages) {
    lines.push(
      `- Averages over ${quality.judged} judged cycle(s): ` +
        JUDGE_DIMENSIONS.map((dimension) => `${dimension} ${quality.averages?.[dimension]}`).join(
          ", ",
        ) +
        ".",
    );
    lines.push(
      quality.trend === "insufficient-data"
        ? `- Trend: not claimed, too few judged cycles (${quality.judged}, fewer than ` +
            `${MIN_TREND_CYCLES}).`
        : `- Trend in overall score: ${quality.trend}.`,
    );
  } else {
    lines.push("- No cycle in this window has a usable judge verdict, so quality is UNKNOWN.");
  }
  if (quality.notJudged > 0) {
    lines.push(
      `- ${quality.notJudged} completed cycle(s) are not yet judged, so their report quality ` +
        "is unknown rather than good.",
    );
  }
  for (const entry of quality.unjudged) {
    lines.push(
      `- UNJUDGED cycle ${cycleLabel(entry)}: ${entry.warning}. Recorded as unjudged, not as ` +
        "a passing score.",
    );
  }
  for (const entry of quality.lowGrounding) {
    const findings = entry.findings.length > 0 ? ` Judge findings: ${entry.findings.join(" | ")}` : "";
    lines.push(
      `- LOW GROUNDING (${entry.grounding}/5) in cycle ${cycleLabel(entry)}, overall ` +
        `${entry.overall}/5. An unsupported claim or an invented number is the worst failure ` +
        `mode for this report.${findings}`,
    );
  }

  if (health.truncated.length > 0 || health.unfinished.length > 0) {
    lines.push("Data quality:");
    for (const entry of health.truncated) {
      lines.push(
        `- Cycle ${cycleLabel(entry)} was TRUNCATED at ${entry.toolCount} recorded tools, so ` +
          "absence-based guards there were downgraded to not-applicable and prove nothing.",
      );
    }
    for (const entry of health.unfinished) {
      lines.push(
        `- Cycle ${cycleLabel(entry)} DID NOT FINISH (no terminal verdict recorded), so it was ` +
          "excluded from the counts above. A cycle that dies mid-way is worth investigating.",
      );
    }
  }

  return lines;
}
