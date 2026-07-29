/**
 * REPORT-QUALITY JUDGE: the slow, subtle half of poof's online evals.
 *
 * The invariants (agent/lib/invariants.ts) grade BEHAVIOUR and the numeric check
 * (agent/lib/report-check.ts) grades ARITHMETIC. Neither can tell whether the prose the agent
 * wrote is actually supported by what its tools returned. A report can quote the right account
 * value and still invent a reason, imply it can predict a price, or omit the exit it took. This
 * module is the parsing, thresholding and alerting half of the LLM-as-judge pass that grades
 * that; the rubric itself lives in agent/subagents/report_judge/instructions.md.
 *
 * WHY THE JUDGE IS SCHEDULED, NOT INLINE IN THE HOOK. DO NOT "optimise" this back into
 * agent/hooks/trace-cycle.ts. eve hooks run INLINE in the event pipeline (that is exactly why a
 * thrown hook escalates to `turn.failed`, and why the online-eval work had to add
 * agent/lib/fetch-timeout.ts to stop a hanging HTTP call from stalling a cycle). A model call
 * from a hook would block a LIVE TRADING CYCLE for tens of seconds while the judge thinks, on
 * the very turn that is placing orders. So the split is deliberate:
 *   - the DETERMINISTIC numeric check stays immediate in the hook: it is microseconds of pure
 *     arithmetic and it catches the GBP 282 class of error while the cycle is still fresh;
 *   - the JUDGE runs later, batched, from the weekly schedule, over cycles that have already
 *     COMPLETED and whose report text and ground truth are already stored on the trace row.
 * Nothing is lost by waiting: the judge reads stored data and can only write a verdict.
 *
 * COST: the cycle runs once per weekday, so this is roughly 5 judge calls a week.
 *
 * Pure: no I/O and no clock (`judgeThresholdsFromEnv` reads the environment and takes it as an
 * argument so it stays testable). This module is an OBSERVER. A verdict is stored and may raise
 * an alert; it can never alter, delay, or block a report, and it is never an input to the risk
 * gate, position sizing, or order placement. See the isolation tests in observers.test.ts.
 */

/** The rubric, in the order the judge is asked to return it. `overall` is its own judgement. */
export const JUDGE_DIMENSIONS = [
  "grounding",
  "consistency",
  "calibration",
  "completeness",
  "overall",
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

/** Bounds on stored findings: a verdict row must stay small and predictable. */
export const MAX_FINDINGS = 10;
export const MAX_FINDING_CHARS = 400;

/** Bound on a stored warning, so a rambling non-answer cannot bloat the trace row. */
const MAX_WARNING_CHARS = 300;

export interface ReportScore {
  /** Does every factual and numeric claim trace to the provided tool outputs? */
  grounding: number;
  /** Do the narrative and the figures agree with each other? */
  consistency: number;
  /** Does it hedge appropriately rather than implying it can predict prices? */
  calibration: number;
  /** Does it cover what actually happened this cycle? */
  completeness: number;
  overall: number;
  findings: string[];
}

/**
 * The outcome of grading one cycle.
 *
 * "unjudged" is a FIRST-CLASS status for the same reason "not-applicable" is one for the
 * invariants: a missing answer must never be recorded as a good one. A judge that returns
 * something unusable is an observability failure, and reporting it as a pass would quietly
 * convert the whole judging layer into decoration.
 */
export type JudgeVerdict =
  | { status: "judged"; score: ReportScore }
  | { status: "unjudged"; warning: string };

export interface JudgeThresholds {
  /** Alert when `overall` is strictly below this. */
  overallBelow: number;
  /**
   * Alert when `grounding` is strictly below this. Stricter than `overall` on purpose:
   * an unsupported number or an invented fact is the failure class that produced the report
   * claiming GBP 282 when the account held GBP 248.
   */
  groundingBelow: number;
}

export const DEFAULT_JUDGE_THRESHOLDS: JudgeThresholds = {
  overallBelow: 3,
  groundingBelow: 4,
};

type EnvLike = Record<string, string | undefined>;

function numFromEnv(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Thresholds overlaid with optional env overrides, mirroring `resolveLimits` in state.ts. */
export function judgeThresholdsFromEnv(env: EnvLike = process.env): JudgeThresholds {
  return {
    overallBelow: numFromEnv(
      env,
      "REPORT_JUDGE_ALERT_OVERALL_BELOW",
      DEFAULT_JUDGE_THRESHOLDS.overallBelow,
    ),
    groundingBelow: numFromEnv(
      env,
      "REPORT_JUDGE_ALERT_GROUNDING_BELOW",
      DEFAULT_JUDGE_THRESHOLDS.groundingBelow,
    ),
  };
}

/** A short, bounded description of an unusable value, for the warning text. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 40 ? `"${trimmed.slice(0, 40)}..."` : `"${trimmed}"`;
  }
  try {
    return String(JSON.stringify(value)).slice(0, 40);
  } catch {
    return typeof value;
  }
}

/** Strip a ```json fence, which a model asked for JSON still occasionally wraps it in. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/**
 * Coax the raw judge response into a plain object, or give up.
 *
 * Deliberately lenient about the ENVELOPE (a JSON string, a fenced block) and strict about the
 * CONTENT: leniency here only ever recovers a verdict the judge really did produce, whereas
 * leniency below could invent one it did not.
 */
function coerceObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    const text = stripFence(raw).trim();
    if (text === "") return null;
    try {
      return coerceObject(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function parseFindings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, MAX_FINDINGS)
    .map((entry) => entry.trim().slice(0, MAX_FINDING_CHARS));
}

/**
 * Turn whatever the judge returned into a verdict.
 *
 * NEVER returns a passing score for an input it could not read: every failure path is
 * "unjudged" with a warning. That is the whole point, because the caller stores this verdict
 * against the cycle and the weekly report reads it back.
 */
export function parseJudgeVerdict(raw: unknown): JudgeVerdict {
  const candidate = coerceObject(raw);
  if (!candidate) {
    return {
      status: "unjudged",
      warning: `the judge returned no usable verdict object (got ${describe(raw)})`.slice(
        0,
        MAX_WARNING_CHARS,
      ),
    };
  }

  const scores: Partial<Record<JudgeDimension, number>> = {};
  const unusable: string[] = [];
  for (const dimension of JUDGE_DIMENSIONS) {
    const value = candidate[dimension];
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(n) || n < MIN_SCORE || n > MAX_SCORE) {
      unusable.push(`${dimension}=${describe(value)}`);
      continue;
    }
    scores[dimension] = n;
  }

  if (unusable.length > 0) {
    return {
      status: "unjudged",
      warning: (
        `the judge returned no usable ${MIN_SCORE}-${MAX_SCORE} score for ` +
        unusable.join(", ")
      ).slice(0, MAX_WARNING_CHARS),
    };
  }

  return {
    status: "judged",
    score: {
      grounding: scores.grounding as number,
      consistency: scores.consistency as number,
      calibration: scores.calibration as number,
      completeness: scores.completeness as number,
      overall: scores.overall as number,
      findings: parseFindings(candidate.findings),
    },
  };
}

/**
 * Why this verdict deserves an alert, if it does. Empty means nothing is known to be wrong.
 *
 * An "unjudged" verdict yields NO reason on purpose: a judge that failed to answer is an
 * observability problem, not a report defect, and paging on a formatting failure is how an
 * alert channel gets trained into noise. It is surfaced in the weekly eval-health section
 * instead (agent/lib/eval-health.ts), which is the read path that exists to catch exactly that.
 */
export function judgeAlertReasons(
  verdict: JudgeVerdict,
  thresholds: JudgeThresholds = DEFAULT_JUDGE_THRESHOLDS,
): string[] {
  if (verdict.status !== "judged") return [];
  const reasons: string[] = [];
  const { grounding, overall } = verdict.score;
  if (overall < thresholds.overallBelow) {
    reasons.push(`overall=${overall} is below the alert threshold ${thresholds.overallBelow}`);
  }
  if (grounding < thresholds.groundingBelow) {
    reasons.push(
      `grounding=${grounding} is below the alert threshold ${thresholds.groundingBelow}: ` +
        "an unsupported claim or an invented number is the worst failure mode for this report",
    );
  }
  return reasons;
}

/** What persisting a verdict did. Mirrors `SaveReportScoreResult` in agent/lib/memory.ts. */
export type SaveOutcome = "stored" | "already-judged" | "no-such-trace";

/**
 * Reasons to alert, given the verdict AND whether it actually reached the database.
 *
 * A verdict that was NOT persisted must never alert. `already-judged` means an earlier pass
 * stored the original and already raised whatever alert it deserved, so alerting again would
 * double-page on one cycle. `no-such-trace` means there is no row at all, so the alert would
 * point a human at a record they cannot go and look at.
 *
 * Extracted as a pure decision, like `decideAppend` in convex/traceAppend.ts, so the rule is
 * unit-testable instead of living only inside a tool that does I/O.
 */
export function alertReasonsForStoredVerdict(
  verdict: JudgeVerdict,
  outcome: SaveOutcome,
  thresholds: JudgeThresholds = DEFAULT_JUDGE_THRESHOLDS,
): string[] {
  if (outcome !== "stored") return [];
  return judgeAlertReasons(verdict, thresholds);
}

/** One-line summary for a log line or a Slack alert. */
export function summarizeJudgeVerdict(verdict: JudgeVerdict): string {
  if (verdict.status !== "judged") return `unjudged (${verdict.warning})`;
  const { score } = verdict;
  return JUDGE_DIMENSIONS.map((dimension) => `${dimension}=${score[dimension]}`).join(" ");
}
