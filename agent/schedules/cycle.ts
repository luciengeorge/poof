import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { isUsMarketOpen } from "../lib/clock.ts";

// Cron fires in UTC; the handler gates precisely to US market hours via ET (DST-aware).
// A few times across the UTC window that covers US RTH in both EST and EDT.
// Tune frequency to your Vercel plan (Hobby limits cron frequency).
export default defineSchedule({
  cron: "0 14,17,20 * * 1-5",
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
