import { defineTool } from "eve/tools";
import { z } from "zod";
import { alert } from "../lib/alert.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import {
  alertReasonsForStoredVerdict,
  type CaptureState,
  judgeThresholdsFromEnv,
  parseJudgeVerdict,
  summarizeJudgeVerdict,
  unjudgeableVerdict,
} from "../lib/report-judge.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

/**
 * ONLINE EVALS, step 2 of the weekly report-quality judge pass: persist one verdict.
 *
 * WHY THE INPUT IS DELIBERATELY UNVALIDATED. `verdict` is accepted as an arbitrary value and
 * graded by `parseJudgeVerdict` inside `execute`, instead of being validated by the input
 * schema. A strict schema would REJECT an off-shape judge response as a tool-call error, the
 * model would retry it or move on, and the cycle would silently stay unjudged forever. The
 * fail-safe requires the opposite: an unusable response must be RECORDED as "unjudged" with a
 * warning, so the weekly read path can say out loud that this cycle was never graded. An
 * unparseable verdict is never stored as a passing score, here or in the Convex mutation.
 *
 * OBSERVER ONLY. The report was published days ago; this writes a verdict against the stored
 * trace and may raise an alert. It cannot alter or block a report, and it is never an input to
 * the risk gate, position sizing, or order placement.
 */

export default defineTool({
  description:
    "ONLINE EVALS: record the report_judge verdict for ONE already-completed cycle. Pass the " +
    "subagent's structured output through unchanged as `verdict` (grounding, consistency, " +
    "calibration, completeness, overall, findings). Do NOT clean it up, invent a score, or " +
    "retry a malformed one: an unusable verdict is deliberately recorded as 'unjudged' with a " +
    "warning, which is the correct outcome. To record a cycle that cannot be graded at all " +
    "(for example one with no stored report text), omit `verdict` and give `unjudgedReason`. " +
    "When report_judge could not load ground truth for its cycle id, omit `verdict` and give " +
    "`unjudgeableReason` instead. That is recorded and reported as UNJUDGEABLE, never as a low " +
    "score. " +
    "A cycle is judged at most once; calling twice is a no-op. Observe-only: no effect on trading.",
  inputSchema: z.object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    verdict: z
      .unknown()
      .optional()
      .describe(
        "the report_judge structured output, exactly as returned; validated inside the tool " +
          "so a malformed verdict is recorded rather than rejected",
      ),
    unjudgedReason: z
      .string()
      .optional()
      .describe("why this cycle could not be graded, when no verdict is supplied"),
    unjudgeableReason: z
      .string()
      .min(1)
      .optional()
      .describe(
        "why no ground truth could be loaded for the cycle id; stored as UNJUDGEABLE with no score",
      ),
  }),
  async execute({ sessionId, turnId, verdict, unjudgedReason, unjudgeableReason }) {
    const parsed =
      unjudgeableReason !== undefined
        ? unjudgeableVerdict(unjudgeableReason)
        : verdict === undefined && unjudgedReason !== undefined
          ? ({ status: "unjudged", warning: unjudgedReason } as const)
          : parseJudgeVerdict(verdict);
    const summary = summarizeJudgeVerdict(parsed);

    const key = { env: tradingEnv(), sessionId, turnId };
    const result = await memoryFromEnv().saveReportScore(
      key,
      parsed.status === "judged"
        ? { status: "judged", ...parsed.score }
        : {
            status: "unjudged",
            findings: [],
            warning: parsed.warning,
            ...(parsed.status === "unjudgeable" ? { unjudgeable: true } : {}),
          },
    );
    const { outcome } = result;
    if (outcome !== "stored") {
      console.warn(
        `[online-eval] verdict for cycle ${sessionId}/${turnId} was NOT stored (${outcome}); ` +
          (outcome === "already-judged"
            ? "an earlier pass already judged this cycle and already alerted if it needed to"
            : "no trace row exists for this cycle, so there was nowhere to record it"),
      );
    }

    if (parsed.status !== "judged") {
      // A WARNING, not an alert: a judge that failed to answer is an observability problem, not
      // a report defect, and paging on a formatting failure trains the alert channel into noise.
      // The weekly eval-health section calls the cycle out as unjudged, which is the read path
      // that exists to catch precisely this.
      console.warn(
        `[online-eval] report for cycle ${sessionId}/${turnId} recorded as UNJUDGED: ` +
          parsed.warning,
      );
      return { status: "unjudged", summary, alerted: false, outcome };
    }

    // How complete was the ground truth this verdict was formed against? A grounding score on an
    // incompletely captured cycle cannot tell "invented" from "not recorded", so it is recorded but
    // not alerted on. Read here rather than inferred, and non-fatal: if the lookup fails the state
    // is simply unknown and the old (stricter) alerting behaviour applies.
    let capture: CaptureState | undefined;
    try {
      const trace = await memoryFromEnv().getCycleTrace(key);
      if (trace) {
        capture = {
          ordersCaptured: trace.orders !== undefined,
          exitsCaptured: trace.exits !== undefined,
          truncated:
            trace.truncated === true ||
            trace.ordersTruncated === true ||
            trace.exitsTruncated === true,
        };
      }
    } catch (err) {
      console.warn("[online-eval] capture-state lookup failed; alerting strictly:", err);
    }

    // The gate on `outcome` lives inside this pure function, so "never alert on a verdict that
    // was not persisted" is one tested rule rather than a conjunction repeated at each use.
    const reasons = alertReasonsForStoredVerdict(
      parsed,
      outcome,
      judgeThresholdsFromEnv(),
      capture,
    );
    console.log(`[online-eval] report judged for cycle ${sessionId}/${turnId}: ${summary}`);
    if (reasons.length > 0) {
      await alert(
        `🚨 poof ONLINE EVAL: report quality below threshold (cycle ${sessionId}/${turnId}): ` +
          `${reasons.join("; ")}. Scores: ${summary}.` +
          (parsed.score.findings.length > 0
            ? ` Judge findings: ${parsed.score.findings.join(" | ")}`
            : ""),
      );
    }
    return {
      status: "judged",
      summary,
      scores: parsed.score,
      alerted: reasons.length > 0,
      alertReasons: reasons,
      outcome,
    };
  },
});
