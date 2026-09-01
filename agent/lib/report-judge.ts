/**
 * REPORT-QUALITY JUDGE: the slow, subtle half of poof's online evals.
 *
 * The invariants (agent/lib/invariants.ts) grade BEHAVIOUR and the numeric check
 * (agent/lib/report-check.ts) grades ARITHMETIC. Neither can tell whether the prose the agent
 * wrote is actually supported by what its tools returned. A report can quote the right account
 * value and still invent a reason, imply it can predict a price, or omit the exit it took. This
 * module is the ground-truth assembly, parsing, thresholding and alerting half of the
 * LLM-as-judge pass that grades that; the rubric itself lives in
 * agent/subagents/report_judge/instructions.md.
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

import type {
  TracedExit,
  TracedExternalHolding,
  TracedOrder,
} from "./cycle-trace.ts";

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
  | { status: "unjudged"; warning: string }
  | { status: "unjudgeable"; warning: string };

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

// --- THE GROUND TRUTH HANDED TO THE JUDGE ---
//
// The judge may use NOTHING but what this function returns, so what it leaves out decides what
// the judge can honestly grade. It used to return six GBP numbers, and three consecutive live
// cycles were scored grounding=1 on ACCURATE reports because of three defects in it:
//
//  (A) STALENESS. `cashGbp` came from review_performance, which runs EARLY, while the report
//      correctly states the cash left AFTER the day's orders. 129.99 - 15 = 114.99 is the report
//      being right, so every cycle that traded produced a guaranteed false "cash is misstated"
//      finding. Fixed at source: record_cycle runs LAST and does its own fresh broker fetch, and
//      it now returns the equity and cash it recorded, which the trace hook stores as the
//      post-trade snapshot. This function prefers it and falls back to the pre-trade figures.
//      (The DETERMINISTIC check in report-check.ts still reads the PRE-TRADE `accountValueGbp`,
//      deliberately: its account-value-present rule grades the value the report was told to quote
//      verbatim, which review_performance produced before record_cycle existed for that cycle.)
//      ONE ASSUMPTION, worth knowing if this ever starts alerting again: the report computes its
//      post-trade cash ARITHMETICALLY (pre-trade cash minus notional) before record_cycle fetches
//      reality, and the live evidence shows the two agree exactly (14.99, 19.84, 25.19), because a
//      Trading 212 notional order debits exactly its notional. If per-order fees or commissions
//      ever appear, the report's figure would sit slightly above the fetched one and the judge
//      could start flagging pennies. The fix then is a tolerance, not a return to pre-trade cash.
//  (B) INCOMPLETENESS. With no orders, positions, exits or prices in it, every correctly sourced
//      figure in a report was unverifiable from the judge's seat and read as invented.
//  (C) MISREAD ALLOW-LIST. The bare `externalGbpValues` array is the magnitude allow-list for
//      report-check.ts. Handed to the judge, it was read as a checklist of figures the report
//      owed the reader, so the report was penalised for "omitting" a cost basis. The judge gets
//      the LABELLED holdings instead, and the bare array is not passed at all.
//
// CAPTURED-EMPTY vs NOT-CAPTURED is the distinction that keeps this honest, and it is the same
// three-state discipline as `not-applicable` in agent/lib/invariants.ts. An empty list means the
// cycle really did none of that, and a report describing one contradicts the record. An ABSENT
// list means nothing was recorded, and absence of data is not evidence of invention. Collapsing
// the two would either blind the judge to a fabricated order or convict a real one.
//
// THE THIRD CASE, and it is the one that matters most: a NO-TRADE cycle never calls submit_orders,
// so `orders` is ABSENT rather than empty, on the most common kind of cycle there is. Read as
// plain not-captured, a report claiming "I bought GBP 20 of Tesla today" on a quiet cycle would be
// merely unverifiable, and since report-check.ts does not cover orders at all, the judge is the
// ONLY line of defence against a hallucinated trade. So absence is disambiguated against the TOOL
// SEQUENCE, which is recorded independently: when the sequence is COMPLETE and contains no
// submit_orders, the order path was never exercised and a described purchase CONTRADICTS the
// record. Only a truncated sequence, or a sequence that DOES contain the tool (so the tool ran and
// the capture failed), stays unverifiable. Exits work the same way against manage_positions.

/** The subset of a stored cycle trace the judge's ground truth is assembled from. */
export interface JudgeTrace {
  /** From review_performance, early in the cycle: PRE-TRADE. */
  accountValueGbp?: number;
  cashGbp?: number;
  deployedGbp?: number;
  /** From record_cycle's fresh broker fetch at the end of the cycle: POST-TRADE. */
  postTradeAccountValueGbp?: number;
  postTradeCashGbp?: number;
  orders?: readonly TracedOrder[];
  ordersTruncated?: boolean;
  exits?: readonly TracedExit[];
  exitsTruncated?: boolean;
  positionTickers?: readonly string[];
  positionCount?: number;
  positionsTruncated?: boolean;
  quotes?: Readonly<Record<string, number>>;
  quotesTruncated?: boolean;
  externalAdvisoryHoldings?: readonly TracedExternalHolding[];
  externalAdvisoryHoldingsTruncated?: boolean;
  toolSequence: readonly string[];
  /** The TOOL SEQUENCE hit its recording cap. */
  truncated?: boolean;
  invariants: readonly { name: string; status: string; detail?: string }[];
  reportPass?: boolean;
  reportFindings?: readonly { rule: string; detail: string }[];
}

/**
 * Which moment in the cycle one money figure describes. Tracked PER FIGURE, not for the pair:
 * both come from record_cycle's single fetch, so a partial is rare, but labelling a pre-trade
 * fallback figure "post-trade" because the OTHER figure was post-trade would quietly resurrect
 * defect (A) for exactly the figure the defect was about.
 */
export type SnapshotStage = "post-trade" | "pre-trade" | "none";

export interface JudgeGroundTruth {
  /** POST-TRADE where record_cycle recorded it, else the pre-trade figure. See `*Stage` below. */
  accountValueGbp?: number;
  cashGbp?: number;
  /** The stage of `accountValueGbp` and `cashGbp` when they agree, else "mixed". */
  snapshotStage: SnapshotStage | "mixed";
  accountValueStage: SnapshotStage;
  cashStage: SnapshotStage;
  /** Kept and LABELLED when the figure above is post-trade, so a difference reads correctly. */
  preTradeAccountValueGbp?: number;
  preTradeCashGbp?: number;
  /** Pre-trade only: nothing recomputes it after the orders. */
  deployedGbp?: number;
  orders?: readonly TracedOrder[];
  exits?: readonly TracedExit[];
  positionTickers?: readonly string[];
  positionCount?: number;
  /** Ticker to price, in the instrument's own currency (USD for US stocks), never GBP. */
  quotes?: Readonly<Record<string, number>>;
  /** ADVISORY-ONLY, untradable by the agent. Reference context, never a required-content list. */
  externalAdvisoryHoldings?: readonly TracedExternalHolding[];
  toolSequence: readonly string[];
  truncatedToolSequence: boolean;
  invariants: readonly { name: string; status: string; detail?: string }[];
  numericSelfConsistencyPass?: boolean;
  numericSelfConsistencyFindings?: readonly { rule: string; detail: string }[];
  /** What this ground truth can and cannot adjudicate, in plain sentences for the judge. */
  coverage: string[];
}

/**
 * Result of loading the facts for one judge pass.
 *
 * `unjudgeable` is deliberately separate from a low score. A missing trace means the judge has
 * no evidence at all, so assigning grounding=3 would falsely describe the report as deficient.
 */
export type JudgeGroundTruthResult =
  | { status: "available"; groundTruth: JudgeGroundTruth }
  | { status: "unjudgeable"; reason: string };

function categoryLines(
  noun: string,
  captured: boolean,
  empty: boolean,
  truncated: boolean,
  /** Replaces the default not-captured wording when absence is itself evidence. */
  absentNote?: string,
): string[] {
  if (!captured) {
    return [
      absentNote ??
        `${noun}: NOT CAPTURED for this cycle. Nothing here can confirm or refute a claim about ` +
          `${noun}, and absence of data is not evidence of an invented claim: do not mark the ` +
          `report down for grounding on ${noun}.`,
    ];
  }
  const lines: string[] = [];
  if (empty) {
    lines.push(
      `${noun}: none. This cycle recorded no ${noun} at all, so a report that describes one ` +
        "CONTRADICTS the ground truth.",
    );
  }
  if (truncated) {
    lines.push(
      `${noun}: TRUNCATED at the recording cap, so this list is INCOMPLETE. Something missing ` +
        "from it may still have happened; treat a claim it does not cover as unverifiable, not " +
        "as invented.",
    );
  }
  return lines;
}

function stageOf(postTrade: number | undefined, preTrade: number | undefined): SnapshotStage {
  if (postTrade !== undefined) return "post-trade";
  return preTrade !== undefined ? "pre-trade" : "none";
}

/**
 * When a category was not captured, is its ABSENCE itself evidence?
 *
 * Yes, and only when the tool sequence can prove it: the sequence is non-empty (so something was
 * recorded at all), COMPLETE (not capped), and contains no trace of the tool that would have
 * produced the category. Then the path was never exercised, and a report describing one of these
 * events contradicts the record. This is the case that keeps a fabricated trade on a NO-TRADE cycle
 * convictable, which matters because report-check.ts does not grade orders at all.
 *
 * Returns undefined, leaving the default unverifiable wording in place, when the sequence is
 * truncated (a capped record proves nothing) or when it DOES contain the tool (the tool ran and the
 * capture failed, which is an observability problem, not a lie in the prose).
 */
function neverExercisedNote(
  trace: JudgeTrace,
  noun: string,
  tool: string,
  described: string,
): string | undefined {
  if (trace.truncated === true) return undefined;
  if (trace.toolSequence.length === 0) return undefined;
  if (trace.toolSequence.includes(tool)) return undefined;
  return (
    `${noun}: not captured, AND the COMPLETE tool sequence for this cycle contains no ${tool} at ` +
    `all, so the ${noun} path was never exercised. That absence IS evidence: ${described} ` +
    `described in the report CONTRADICTS the record, and must be scored exactly as an invented ` +
    `${noun} would be.`
  );
}

/**
 * Assemble one cycle's ground truth for the judge from its stored trace row.
 *
 * Pure, so the wording of the coverage notes is pinned by tests rather than left to a prompt: the
 * sentence saying post-trade cash is not a contradiction is the entire fix for defect (A), and a
 * model paraphrasing it away would bring the false alerts straight back.
 */
export function judgeGroundTruth(trace: JudgeTrace): JudgeGroundTruth {
  const accountValueGbp = trace.postTradeAccountValueGbp ?? trace.accountValueGbp;
  const cashGbp = trace.postTradeCashGbp ?? trace.cashGbp;
  // PER FIGURE. Labelling a pre-trade fallback "post-trade" because the other half of the pair
  // was post-trade would silently reintroduce defect (A) for that figure.
  const accountValueStage = stageOf(trace.postTradeAccountValueGbp, trace.accountValueGbp);
  const cashStage = stageOf(trace.postTradeCashGbp, trace.cashGbp);
  const snapshotStage = accountValueStage === cashStage ? accountValueStage : "mixed";

  const coverage: string[] = [];
  if (cashStage === "post-trade") {
    coverage.push(
      "cashGbp is the POST-TRADE figure: a fresh broker fetch taken at the END of the cycle, " +
        "after the day's orders. The report describes the cash left after trading, so a figure in " +
        "the report that is lower than the pre-trade cash below is the day's spending and is NOT " +
        "a contradiction.",
    );
  } else if (cashStage === "pre-trade") {
    coverage.push(
      "cashGbp is the PRE-TRADE figure, taken early in the cycle before any order: no post-trade " +
        "cash was recorded. Cash stated in the report as what is left after today will " +
        "legitimately be LOWER than this figure, by roughly what the cycle spent, and that is NOT " +
        "a contradiction.",
    );
  } else {
    coverage.push("no cash figure was recorded for this cycle, so cash cannot be adjudicated.");
  }
  coverage.push(
    accountValueStage === "none"
      ? "no account value was recorded for this cycle, so it cannot be adjudicated."
      : `accountValueGbp is the ${accountValueStage.toUpperCase()} figure. Account value is close ` +
          "to trade-neutral (cash falls, holdings rise), so the two stages of it rarely differ by " +
          "much, and a small difference is market movement rather than a defect.",
  );
  if (snapshotStage === "mixed") {
    coverage.push(
      `the two money figures are from DIFFERENT stages (account value ${accountValueStage}, cash ` +
        `${cashStage}), because only part of the end-of-cycle snapshot was recorded. Read each ` +
        "against its own stage; do not infer one from the other.",
    );
  }
  if (trace.deployedGbp !== undefined) {
    coverage.push(
      "deployedGbp is the value held in positions as of the EARLY review_performance call, so it " +
        "is pre-trade and does not include anything bought this cycle.",
    );
  }

  coverage.push(
    ...categoryLines(
      "orders",
      trace.orders !== undefined,
      (trace.orders?.length ?? 0) === 0,
      trace.ordersTruncated === true,
      neverExercisedNote(trace, "orders", "submit_orders", "a purchase or a sale"),
    ),
    ...categoryLines(
      "exits",
      trace.exits !== undefined,
      (trace.exits?.length ?? 0) === 0,
      trace.exitsTruncated === true,
      neverExercisedNote(trace, "exits", "manage_positions", "an exit or an automatic sale"),
    ),
    ...categoryLines(
      "positions",
      trace.positionTickers !== undefined,
      (trace.positionCount ?? 0) === 0,
      trace.positionsTruncated === true,
    ),
    ...categoryLines(
      "quoted prices",
      trace.quotes !== undefined,
      Object.keys(trace.quotes ?? {}).length === 0,
      trace.quotesTruncated === true,
    ),
    ...categoryLines(
      "external advisory holdings",
      trace.externalAdvisoryHoldings !== undefined,
      (trace.externalAdvisoryHoldings?.length ?? 0) === 0,
      trace.externalAdvisoryHoldingsTruncated === true,
    ),
  );
  if (trace.truncated === true) {
    coverage.push(
      "tool sequence: TRUNCATED at the recording cap, so tools past it are missing and a tool " +
        "the report mentions may simply not appear here.",
    );
  }

  return {
    ...(accountValueGbp !== undefined ? { accountValueGbp } : {}),
    ...(cashGbp !== undefined ? { cashGbp } : {}),
    snapshotStage,
    accountValueStage,
    cashStage,
    ...(accountValueStage === "post-trade" && trace.accountValueGbp !== undefined
      ? { preTradeAccountValueGbp: trace.accountValueGbp }
      : {}),
    ...(cashStage === "post-trade" && trace.cashGbp !== undefined
      ? { preTradeCashGbp: trace.cashGbp }
      : {}),
    ...(trace.deployedGbp !== undefined ? { deployedGbp: trace.deployedGbp } : {}),
    ...(trace.orders !== undefined ? { orders: trace.orders } : {}),
    ...(trace.exits !== undefined ? { exits: trace.exits } : {}),
    ...(trace.positionTickers !== undefined
      ? { positionTickers: trace.positionTickers, positionCount: trace.positionCount }
      : {}),
    ...(trace.quotes !== undefined ? { quotes: trace.quotes } : {}),
    ...(trace.externalAdvisoryHoldings !== undefined
      ? { externalAdvisoryHoldings: trace.externalAdvisoryHoldings }
      : {}),
    toolSequence: trace.toolSequence,
    truncatedToolSequence: trace.truncated === true,
    invariants: trace.invariants,
    ...(trace.reportPass !== undefined ? { numericSelfConsistencyPass: trace.reportPass } : {}),
    ...(trace.reportFindings !== undefined
      ? { numericSelfConsistencyFindings: trace.reportFindings }
      : {}),
    coverage,
  };
}

/** Turn a stored trace lookup into the judge tool's explicit availability result. */
export function judgeGroundTruthResult(trace: JudgeTrace | null): JudgeGroundTruthResult {
  if (trace === null) {
    return {
      status: "unjudgeable",
      reason:
        "ground truth is unavailable for this cycle id, so this report is UNJUDGEABLE and must not receive a score",
    };
  }
  return { status: "available", groundTruth: judgeGroundTruth(trace) };
}

/** Build the non-score verdict used when the judge tool could not load a trace. */
export function unjudgeableVerdict(reason: string): JudgeVerdict {
  return { status: "unjudgeable", warning: reason };
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
/**
 * How complete was the ground truth the judge was actually given?
 *
 * A grounding verdict on an INCOMPLETELY captured cycle is uninformative by construction: the judge
 * cannot tell "invented" from "not recorded", so a low score says nothing about the report. This is
 * the same doctrine the invariants already follow, where absence must never convict.
 */
export interface CaptureState {
  /** The order list was recorded for this cycle. */
  ordersCaptured: boolean;
  /** The exit list was recorded for this cycle. */
  exitsCaptured: boolean;
  /** Any recorded collection hit its cap, so something real may be missing from it. */
  truncated?: boolean;
}

/**
 * Is a grounding score worth alerting on at all?
 *
 * WHY THIS EXISTS. The rubric already tells the judge, in plain words, not to lower the score for a
 * claim it merely cannot verify. It did anyway: grounding came back at the floor on EIGHT
 * consecutive live cycles, its own findings saying "unverifiable rather than confirmed". A score
 * with no variance carries no information, and an alert that fires every time trains its reader to
 * ignore it.
 *
 * The lesson from the rest of this codebase applies to the judge too: prose is a second line of
 * defence, never the only one. So whether a grounding score is ACTIONABLE is decided here, in code,
 * from what was actually captured. The judge's opinion is still recorded in full; only the alert is
 * gated, so nothing is hidden from the weekly read path.
 */
export function groundingIsActionable(capture: CaptureState): boolean {
  return capture.ordersCaptured && capture.exitsCaptured && capture.truncated !== true;
}

export function judgeAlertReasons(
  verdict: JudgeVerdict,
  thresholds: JudgeThresholds = DEFAULT_JUDGE_THRESHOLDS,
  /** When given, a grounding alert is suppressed unless the ground truth was complete. */
  capture?: CaptureState,
): string[] {
  if (verdict.status !== "judged") return [];
  const reasons: string[] = [];
  const { grounding, overall } = verdict.score;
  if (overall < thresholds.overallBelow) {
    reasons.push(`overall=${overall} is below the alert threshold ${thresholds.overallBelow}`);
  }
  if (grounding < thresholds.groundingBelow) {
    if (capture === undefined || groundingIsActionable(capture)) {
      reasons.push(
        `grounding=${grounding} is below the alert threshold ${thresholds.groundingBelow}: ` +
          "an unsupported claim or an invented number is the worst failure mode for this report",
      );
    }
    // Otherwise: recorded, visible in the weekly scorecard, but NOT alerted. The judge could not
    // distinguish an invented number from an unrecorded one, so the score is not evidence.
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
  /** Pass the cycle's capture state so an uninformative grounding score does not alert. */
  capture?: CaptureState,
): string[] {
  if (outcome !== "stored") return [];
  return judgeAlertReasons(verdict, thresholds, capture);
}

/** One-line summary for a log line or a Slack alert. */
export function summarizeJudgeVerdict(verdict: JudgeVerdict): string {
  if (verdict.status !== "judged") return `${verdict.status} (${verdict.warning})`;
  const { score } = verdict;
  return JUDGE_DIMENSIONS.map((dimension) => `${dimension}=${score[dimension]}`).join(" ");
}
