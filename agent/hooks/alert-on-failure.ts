import { defineHook } from "eve/hooks";
import { alert } from "../lib/alert.ts";

// Observability: a failed cron cycle must not be silent. The shared `alert` helper logs
// (surfaces in Vercel Observability -> Logs) and pings Slack when SLACK_ALERT_WEBHOOK_URL is
// set. This hook subscribes to failure-cascade events, so it must NEVER throw (that would
// escalate the failure): everything is wrapped in try/catch.

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
