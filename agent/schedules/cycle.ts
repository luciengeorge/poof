import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { isUsMarketOpen } from "../lib/clock.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Cron fires in UTC; the handler gates precisely to US market hours via ET (DST-aware).
// Vercel Hobby plan allows only ONE cron run/day, so this fires once per weekday at
// 15:00 UTC (= 11:00 EDT / 10:00 EST, inside US RTH year-round). On Pro, this can run
// multiple times/day (e.g. "0 14,17,20 * * 1-5").
export default defineSchedule({
  cron: "0 15 * * 1-5",
  async run({ receive, waitUntil, appAuth }) {
    const firedAt = Date.now();
    const marketOpen = isUsMarketOpen(new Date());
    const channelId = process.env.SLACK_CHANNEL_ID;
    const dispatched = marketOpen && !!channelId;
    console.log(
      `[cycle] cron fired at ${new Date(firedAt).toISOString()} marketOpen=${marketOpen} dispatched=${dispatched}`,
    );
    try {
      await memoryFromEnv().recordCronRun({ schedule: "cycle", firedAt, marketOpen, dispatched });
    } catch (err) {
      console.warn("[cycle] cron heartbeat failed (non-fatal):", err);
    }

    if (!marketOpen) {
      console.log("[cycle] US market closed, skipping cycle");
      return;
    }

    if (!channelId) {
      console.warn("[cycle] SLACK_CHANNEL_ID not set: skipping cycle (no report target).");
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
