import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

// Dead-man's-switch for the "cycle" cron. Vercel Hobby purges runtime logs in ~1h, so a
// cron that never fires leaves no trace. This runs on a schedule outside Vercel (GitHub
// Actions) and alerts to Slack if today's heartbeat never showed up in Convex.

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function firedAtUtcDate(firedAt) {
  return new Date(firedAt).toISOString().slice(0, 10);
}

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

    const today = todayUtc();
    const firedToday = run?.firedAt != null && firedAtUtcDate(run.firedAt) === today;

    if (!firedToday) {
      const lastSeen = run?.firedAt
        ? new Date(run.firedAt).toISOString()
        : "never";
      await postSlackAlert(
        slackWebhookUrl,
        `:rotating_light: poof: today's trading cron (${today} UTC) has NOT fired. Last seen heartbeat: ${lastSeen}.`,
      );
      console.error(
        `[cron-watchdog] no cycle heartbeat for ${today} UTC (last seen: ${lastSeen})`,
      );
      process.exit(1);
      return;
    }

    console.log(`[cron-watchdog] OK — cycle heartbeat found for ${today} UTC`);
  } catch (err) {
    console.error("[cron-watchdog] check failed:", err);
    process.exit(1);
  }
}

await main();
