import { defineHook } from "eve/hooks";

// Observability: a failed cron cycle must not be silent. Always log (surfaces in Vercel
// Observability -> Logs), and if SLACK_ALERT_WEBHOOK_URL is set, ping Slack too. This hook
// subscribes to failure-cascade events, so it must NEVER throw (that would escalate the
// failure) — everything is wrapped in try/catch.
async function alert(text: string): Promise<void> {
  console.error("[alert]", text);
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[alert] webhook post failed:", err);
  }
}

function describe(event: { data?: unknown }): string {
  const data = event?.data as
    | { error?: { message?: string }; reason?: string }
    | undefined;
  const msg = data?.error?.message ?? data?.reason;
  if (msg) return String(msg).slice(0, 500);
  try {
    return JSON.stringify(data ?? {}).slice(0, 500);
  } catch {
    return "(unserializable failure payload)";
  }
}

export default defineHook({
  events: {
    async "turn.failed"(event, ctx) {
      try {
        await alert(`🚨 poof turn failed (session ${ctx.session.id}): ${describe(event)}`);
      } catch {
        /* never throw from a failure hook */
      }
    },
    async "session.failed"(event, ctx) {
      try {
        await alert(`🚨 poof SESSION FAILED (session ${ctx.session.id}): ${describe(event)}`);
      } catch {
        /* never throw from a failure hook */
      }
    },
  },
});
