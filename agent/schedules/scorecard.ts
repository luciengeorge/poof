import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Weekly performance scorecard. Fires Fridays at 21:00 UTC (after the US close: 16:00 EST /
// 17:00 EDT). Once/week satisfies Hobby's once-per-day cron limit. The agent assembles the
// scorecard from existing tools (review_performance, recall_memory): read-only, no trading.
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
        message:
          "Post this week's PERFORMANCE SCORECARD to Slack (do NOT trade). Call review_performance and recall_memory, then post a skimmable summary: current equity and P&L since inception, alpha vs buy-and-hold SPY, realized win-rate (wins/losses), a short per-strategy-type breakdown from realizedByTag (which strategy types are winning or losing, with a small-sample caveat for types with fewer than ~10 closed trades), open positions with unrealized P&L and age, how many cycles ran and trades were placed this week, and your current standing lessons. End with one line on what you're focused on improving.",
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
