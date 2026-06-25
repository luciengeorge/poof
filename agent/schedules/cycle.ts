import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { isUsMarketOpen } from "../lib/clock.ts";

// Cron fires in UTC; the handler gates precisely to US market hours via ET (DST-aware).
// Vercel Hobby plan allows only ONE cron run/day, so this fires once per weekday at
// 15:00 UTC (= 11:00 EDT / 10:00 EST — inside US RTH year-round). On Pro, this can run
// multiple times/day (e.g. "0 14,17,20 * * 1-5").
export default defineSchedule({
  cron: "0 15 * * 1-5",
  async run({ receive, waitUntil, appAuth }) {
    if (!isUsMarketOpen(new Date())) return;

    const channelId = process.env.SLACK_CHANNEL_ID;
    if (!channelId) {
      console.warn("[cycle] SLACK_CHANNEL_ID not set — skipping cycle (no report target).");
      return;
    }

    waitUntil(
      receive(slack, {
        message:
          "Run one trading cycle now, following your instructions, and post the summary here.",
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
