import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Weekly performance scorecard. Fires Fridays at 21:00 UTC (after the US close: 16:00 EST /
// 17:00 EDT). Once/week satisfies Hobby's once-per-day cron limit. The agent assembles the
// scorecard from existing tools (review_performance, recall_memory): read-only, no trading.
//
// The report-quality JUDGE pass runs two hours earlier in its own schedule (judge.ts), so a
// judge turn that fails can no longer take this report down with it, as it did on 2026-10-16.
// review_eval_health below still picks up that run's verdicts.



const SCORECARD = [
  "Post this week's PERFORMANCE SCORECARD to Slack (do NOT trade).",
  "Call review_performance and recall_memory, then post a skimmable summary: current equity and P&L since inception, alpha vs buy-and-hold SPY, realized win-rate (wins/losses), a short per-strategy-type breakdown from realizedByTag (which strategy types are winning or losing, with a small-sample caveat for types with fewer than ~10 closed trades), open positions with unrealized P&L and age, how many cycles ran and trades were placed this week, and your current memory (directives, lessons, observations). Also report TWO self-assessments verbatim rather than in your own words, because both are deliberately unflattering: `failurePatterns.note` (where the money actually went across the whole closed record, and whether any pattern has recurred often enough to justify changing a rule) and `calibration.note` (whether the confidence you claim at entry matches what actually happens). If either says there is not enough data, SAY THAT plainly rather than dressing it up: an honest unknown is the useful answer at this sample size.",
  "Do NOT grade any report in this run (no list_unjudged_cycles, report_judge or save_report_score): the judge pass is a separate, earlier run. Then call review_eval_health (this week's judge verdicts were saved by that run) and include its `lines` as a final section, VERBATIM, in the order given. Do not paraphrase, summarise, soften, or reorder them, and do not add a reassuring gloss: the wording is deliberate, and a guard reported as NEVER EXERCISED must not be presented as one that is working.",
  "End with one line on what you're focused on improving.",
].join(" ");

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
        message: SCORECARD,
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
