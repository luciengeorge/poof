import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

// Pure day-selection logic lives in agent/lib so the test suite covers it. It is the part
// that was wrong, so it is the part that needs pinning.
import {
  heartbeatUtcDay,
  lastExpectedCycleDay,
} from "../agent/lib/cron-watchdog.ts";

// Dead-man's-switch for the "cycle" cron. Vercel Hobby purges runtime logs in ~1h, so a
// cron that never fires leaves no trace. This runs on a schedule outside Vercel (GitHub
// Actions) and alerts to Slack if today's heartbeat never showed up in Convex.


async function postSlackAlert(webhookUrl, text) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[cron-watchdog] failed to post Slack alert:", err);
  }
}

async function main() {
  const convexUrl = process.env.CONVEX_URL;
  const convexSecret = process.env.CONVEX_APP_SECRET;
  const slackWebhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;

  if (!convexUrl || !convexSecret || !slackWebhookUrl) {
    console.error(
      "[cron-watchdog] missing required env vars (CONVEX_URL, CONVEX_APP_SECRET, SLACK_ALERT_WEBHOOK_URL)",
    );
    process.exit(1);
    return;
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const run = await client.query(anyApi.memory.latestCronRun, {
      token: convexSecret,
      schedule: "cycle",
    });

    // The day whose window has CLOSED, not "today". A delayed run must not ask about a cycle
    // that is not due yet.
    const expectedDay = lastExpectedCycleDay(new Date());
    if (expectedDay === null) {
      console.log("[cron-watchdog] no weekday window has closed yet; nothing to check");
      return;
    }

    const fired = run?.firedAt != null && heartbeatUtcDay(run.firedAt) === expectedDay;

    if (!fired) {
      const lastSeen = run?.firedAt
        ? new Date(run.firedAt).toISOString()
        : "never";
      await postSlackAlert(
        slackWebhookUrl,
        `:rotating_light: poof: the trading cron for ${expectedDay} UTC has NOT fired. Last seen heartbeat: ${lastSeen}. (checked at ${new Date().toISOString()})`,
      );
      console.error(
        `[cron-watchdog] no cycle heartbeat for ${expectedDay} UTC (last seen: ${lastSeen})`,
      );
      process.exit(1);
      return;
    }

    console.log(`[cron-watchdog] OK: cycle heartbeat found for ${expectedDay} UTC`);
  } catch (err) {
    console.error("[cron-watchdog] check failed:", err);
    process.exit(1);
  }
}

await main();
