import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.ts";
import { alert } from "../lib/alert.ts";
import { isUsMarketOpen } from "../lib/clock.ts";
import { CYCLE_MESSAGE, shouldCatchUp } from "../lib/cycle-catch-up.ts";
import { memoryFromEnv } from "../lib/memory.ts";

// Runs the trading cycle late when the 15:00 UTC cycle cron left no heartbeat today. On
// 2026-10-28 a prod deploy at 15:33 re-registered every cron mid-hour and that day's cycle never
// fired; the GitHub watchdog only noticed five hours later, after the close. 18:00 UTC is inside
// US market hours all year and well after the cycle's hour has ended.
//
// It records a `cycle` heartbeat before dispatching, so the watchdog is satisfied and a second
// catch-up the same day finds that heartbeat and does nothing.
export default defineSchedule({
  cron: "0 18 * * 1-5",
  async run({ receive, waitUntil, appAuth }) {
    const now = new Date();
    const memory = memoryFromEnv();
    let latest: { firedAt?: unknown } | null | "unreadable";
    try {
      latest = (await memory.latestCronRun("cycle")) as { firedAt?: unknown } | null;
    } catch (err) {
      console.warn("[cycle-catch-up] could not read the cycle heartbeat, not dispatching:", err);
      latest = "unreadable";
    }
    if (!shouldCatchUp(latest, now)) {
      console.log("[cycle-catch-up] today's cycle already fired (or heartbeat unreadable); nothing to do");
      return;
    }

    const marketOpen = isUsMarketOpen(now);
    const channelId = process.env.SLACK_CHANNEL_ID;
    const dispatched = marketOpen && !!channelId;
    console.log(
      `[cycle-catch-up] no cycle heartbeat today; marketOpen=${marketOpen} dispatched=${dispatched}`,
    );
    if (!dispatched) return;

    try {
      await memory.recordCronRun({ schedule: "cycle", firedAt: now.getTime(), marketOpen, dispatched });
    } catch (err) {
      // Without the heartbeat a later catch-up could not see this run, so do not risk a second one.
      console.warn("[cycle-catch-up] heartbeat write failed, not dispatching:", err);
      return;
    }
    await alert(
      ":warning: poof: today's trading cron did not fire, so a catch-up cycle is starting now.",
    );

    waitUntil(
      receive(slack, {
        message: CYCLE_MESSAGE,
        target: { channelId },
        auth: appAuth,
      }),
    );
  },
});
