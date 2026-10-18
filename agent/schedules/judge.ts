import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Weekly ONLINE-EVAL JUDGE PASS over the week's finished cycles. Fridays at 19:00 UTC, two hours
// before the scorecard (Hobby crons fire somewhere inside their hour, and this pass has taken up
// to 30 minutes), so the scorecard's eval-health section includes this week's verdicts.
//
// SEPARATE FROM THE SCORECARD ON PURPOSE. Both used to run in one turn, and on 2026-10-16 that
// turn died after the judge pass ("turnStep exceeded max retries"), so the weekly scorecard never
// posted. Grading is observation: failing to grade must never cost the user their report.
//
// WHY THE JUDGE RUNS HERE AND NOT IN THE HOOK. eve hooks execute INLINE in the event pipeline
// (that is why a thrown hook escalates to turn.failed, and why the online evals needed
// agent/lib/fetch-timeout.ts to stop a hanging HTTP call from stalling a cycle). A model call
// from a hook would block a LIVE TRADING CYCLE for tens of seconds on the very turn that is
// placing orders. The deterministic numeric check therefore stays immediate in the hook, and
// the slower, subtler judge runs here, batched, over stored data. See agent/lib/report-judge.ts.
// The cycle runs once per weekday, so this is roughly 5 judge calls a week.

const JUDGE_PASS = [
  "Run the weekly ONLINE-EVAL JUDGE PASS over cycles that have already finished. This is grading of past work, not trading, and it can change nothing: those reports were sent days ago.",
  "1. Call list_unjudged_cycles.",
  "2. For EACH entry in `cycles`, delegate to the `report_judge` subagent. Give its message the `cycleId` and `reportText`, and no embedded ground-truth payload. State that it must call its own `get_cycle_ground_truth` tool with that id before grading; its tool returns the facts and complete `coverage` notes. It grades, never rewrites. Set `outputSchema` to {\"oneOf\":[{\"type\":\"object\",\"properties\":{\"status\":{\"const\":\"judged\"},\"grounding\":{\"type\":\"integer\"},\"consistency\":{\"type\":\"integer\"},\"calibration\":{\"type\":\"integer\"},\"completeness\":{\"type\":\"integer\"},\"overall\":{\"type\":\"integer\"},\"findings\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"status\",\"grounding\",\"consistency\",\"calibration\",\"completeness\",\"overall\",\"findings\"]},{\"type\":\"object\",\"properties\":{\"status\":{\"const\":\"unjudgeable\"},\"unjudgeableReason\":{\"type\":\"string\"}},\"required\":[\"status\",\"unjudgeableReason\"]}]}. ",
  "3. For a `status: judged` subagent result, call save_report_score once with that result as `verdict`. For `status: unjudgeable`, call save_report_score once with `unjudgeableReason` and NO `verdict`. Do NOT invent a score, tidy either result, or re-run the judge: unavailable ground truth is UNJUDGEABLE, not grounding=3.",
  "4. For each entry in `notJudgeable`, call save_report_score with its `unjudgedReason` and no `verdict`.",
  "Do NOT trade, and do not post a scorecard: that is a separate run later today.",
  "When done, reply with ONE line only: how many cycles were judged, how many were unjudgeable, and any that failed to grade. Alerts for low scores are sent by save_report_score itself, so do not repeat findings.",
].join(" ");

export default defineSchedule({
  cron: "0 19 * * 5",
  async run({ receive, waitUntil, appAuth }) {
    const firedAt = Date.now();
    const channelId = process.env.SLACK_CHANNEL_ID;
    const dispatched = !!channelId;
    console.log(`[judge] cron fired at ${new Date(firedAt).toISOString()} dispatched=${dispatched}`);
    try {
      await memoryFromEnv().recordCronRun({ schedule: "judge", firedAt, dispatched });
    } catch (err) {
      console.warn("[judge] cron heartbeat failed (non-fatal):", err);
    }

    if (!channelId) {
      console.warn("[judge] SLACK_CHANNEL_ID not set: skipping (no report target).");
      return;
    }

    waitUntil(
      receive(slack, {
        message: JUDGE_PASS,
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
