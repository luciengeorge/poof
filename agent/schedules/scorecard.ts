import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Weekly performance scorecard. Fires Fridays at 21:00 UTC (after the US close: 16:00 EST /
// 17:00 EDT). Once/week satisfies Hobby's once-per-day cron limit. The agent assembles the
// scorecard from existing tools (review_performance, recall_memory): read-only, no trading.
//
// This one schedule also runs the ONLINE-EVAL read path, in two steps and in this order:
//   1. the REPORT-QUALITY JUDGE pass over cycles that have already completed, and
//   2. the EVAL HEALTH section built from the aggregate, including the verdicts from step 1.
//
// WHY THE JUDGE RUNS HERE AND NOT IN THE HOOK. eve hooks execute INLINE in the event pipeline
// (that is why a thrown hook escalates to turn.failed, and why the online evals needed
// agent/lib/fetch-timeout.ts to stop a hanging HTTP call from stalling a cycle). A model call
// from a hook would block a LIVE TRADING CYCLE for tens of seconds on the very turn that is
// placing orders. The deterministic numeric check therefore stays immediate in the hook, and
// the slower, subtler judge runs here, batched, over stored data. See agent/lib/report-judge.ts.
// The cycle runs once per weekday, so this is roughly 5 judge calls a week.

const JUDGE_PASS = [
  "FIRST, run the weekly ONLINE-EVAL JUDGE PASS over cycles that have already finished. This is grading of past work, not trading, and it can change nothing: those reports were sent days ago.",
  "1. Call list_unjudged_cycles.",
  "2. For EACH entry in `cycles`, delegate to the `report_judge` subagent. Put the report text and the whole `groundTruth` object in `message`, and state in the message that the tool outputs are the ONLY source of truth and that it is grading, not rewriting. Set `outputSchema` to {\"type\":\"object\",\"properties\":{\"grounding\":{\"type\":\"integer\"},\"consistency\":{\"type\":\"integer\"},\"calibration\":{\"type\":\"integer\"},\"completeness\":{\"type\":\"integer\"},\"overall\":{\"type\":\"integer\"},\"findings\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"grounding\",\"consistency\",\"calibration\",\"completeness\",\"overall\"]}.",
  "3. Call save_report_score once per cycle, passing the subagent's output straight through as `verdict`. Do NOT tidy it up, fill in a missing score, or re-run the judge to get a cleaner answer: a malformed verdict is meant to be recorded as unjudged.",
  "4. For each entry in `notJudgeable`, call save_report_score with its `unjudgedReason` and no `verdict`.",
  "Then say nothing about this pass in the report beyond what the eval-health section below contains.",
  "If any part of this pass fails, note it in one line and CARRY ON to the scorecard anyway: grading is observation, and failing to grade must never cost the user their weekly report.",
].join(" ");

const SCORECARD = [
  "SECOND, post this week's PERFORMANCE SCORECARD to Slack (do NOT trade).",
  "Call review_performance and recall_memory, then post a skimmable summary: current equity and P&L since inception, alpha vs buy-and-hold SPY, realized win-rate (wins/losses), a short per-strategy-type breakdown from realizedByTag (which strategy types are winning or losing, with a small-sample caveat for types with fewer than ~10 closed trades), open positions with unrealized P&L and age, how many cycles ran and trades were placed this week, and your current standing lessons.",
  "Then call review_eval_health (AFTER the judge pass, so this week's verdicts are included) and include its `lines` as a final section, VERBATIM, in the order given. Do not paraphrase, summarise, soften, or reorder them, and do not add a reassuring gloss: the wording is deliberate, and a guard reported as NEVER EXERCISED must not be presented as one that is working.",
  "End with one line on what you're focused on improving.",
].join(" ");

const JUDGE_PASS_AND_SCORECARD = `${JUDGE_PASS}\n\n${SCORECARD}`;

export default defineSchedule({
  cron: "0 21 * * 5",
  async run({ receive, waitUntil, appAuth }) {
    const firedAt = Date.now();
    const channelId = process.env.SLACK_CHANNEL_ID;
    const dispatched = !!channelId;
    console.log(
      `[scorecard] cron fired at ${new Date(firedAt).toISOString()} dispatched=${dispatched}`,
    );
    try {
      await memoryFromEnv().recordCronRun({ schedule: "scorecard", firedAt, dispatched });
    } catch (err) {
      console.warn("[scorecard] cron heartbeat failed (non-fatal):", err);
    }

    if (!channelId) {
      console.warn("[scorecard] SLACK_CHANNEL_ID not set: skipping (no report target).");
      return;
    }

    waitUntil(
      receive(slack, {
        message: JUDGE_PASS_AND_SCORECARD,
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
