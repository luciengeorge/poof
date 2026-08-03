import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv } from "../lib/memory.ts";
import { judgeGroundTruth } from "../lib/report-judge.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

/**
 * ONLINE EVALS, step 1 of the weekly report-quality judge pass.
 *
 * Hands the caller the cycles that still need grading, each with the report text it published
 * and the ground truth the code computed for that cycle. Both were stored on the trace row by
 * agent/hooks/trace-cycle.ts at the time, so nothing here re-reads the broker: observing cannot
 * perturb what is observed, and a week-old cycle can still be graded against what was actually
 * true then.
 *
 * IDEMPOTENCE: a row that already carries `judgedAt` is skipped, so a re-run of the weekly
 * schedule does not spend another model call on a cycle that has already been judged.
 *
 * OBSERVER ONLY, and read-only. It cannot alter a report (the report was sent days ago) and it
 * is never an input to the risk gate, sizing, or order placement.
 */

/** Bound on the traces scanned, and on the cycles handed back in one pass. */
const SCAN_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export default defineTool({
  description:
    "ONLINE EVALS: list completed production trading cycles whose report has NOT yet been " +
    "graded for quality, each with the report text and the ground-truth tool outputs it was " +
    "written from. Used by the weekly judge pass: pass each entry to the report_judge subagent, " +
    "then record the verdict with save_report_score. Already-judged cycles are skipped, so this " +
    "is safe to call twice. Read-only, observe-only: nothing here affects trading.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(SCAN_LIMIT)
      .optional()
      .describe(`how many cycles to return at most (default ${DEFAULT_LIMIT})`),
  }),
  async execute({ limit }) {
    const env = tradingEnv();
    const traces = await memoryFromEnv().recentCycleTraces(env, SCAN_LIMIT);
    const pending = traces.filter(
      (trace) => trace.completedAt !== undefined && trace.judgedAt === undefined,
    );

    // A completed cycle with no stored report cannot be graded. Say so explicitly instead of
    // dropping it: the caller records it as "unjudged" with this reason, which both keeps the
    // gap visible in the weekly report and stops it being re-listed every single week.
    const notJudgeable = pending
      .filter((trace) => trace.reportText === undefined || trace.reportText.trim() === "")
      .map((trace) => ({
        sessionId: trace.sessionId,
        turnId: trace.turnId,
        reason:
          "no report text was recorded for this cycle, so its report quality cannot be graded",
      }));

    const cycles = pending
      .filter((trace) => trace.reportText !== undefined && trace.reportText.trim() !== "")
      // Oldest first, so a backlog is worked through in the order it happened and the trend in
      // the weekly report reads chronologically.
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
      .slice(0, limit ?? DEFAULT_LIMIT)
      .map((trace) => ({
        sessionId: trace.sessionId,
        turnId: trace.turnId,
        completedAt: trace.completedAt,
        reportText: trace.reportText,
        // The ONLY source of truth the judge may use: what the code observed for that cycle, never
        // anything re-derived now. Assembled by a pure, tested function (agent/lib/report-judge.ts)
        // rather than inline here, because WHICH SNAPSHOT each figure is decides whether a correct
        // report looks like a lie: cash is preferred POST-TRADE, and the `coverage` notes say what
        // the ground truth can and cannot adjudicate. The bare `externalGbpValues` allow-list is
        // deliberately NOT included; the judge gets the labelled holdings instead.
        groundTruth: judgeGroundTruth(trace),
      }));

    return { env, cycles, notJudgeable, scanned: traces.length };
  },
});
