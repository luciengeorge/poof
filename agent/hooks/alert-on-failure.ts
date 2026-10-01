import { defineHook } from "eve/hooks";
import { alert, describeFailure } from "../lib/alert.ts";

// Observability: a failed cron cycle must not be silent. The shared `alert` helper logs
// (surfaces in Vercel Observability -> Logs) and pings Slack when SLACK_ALERT_WEBHOOK_URL is
// set. This hook subscribes to failure-cascade events, so it must NEVER throw (that would
// escalate the failure): everything is wrapped in try/catch.

export default defineHook({
  events: {
    async "turn.failed"(event, ctx) {
      try {
        await alert(`🚨 poof turn failed (session ${ctx.session.id}): ${describeFailure(event)}`);
      } catch {
        /* never throw from a failure hook */
      }
    },
    async "session.failed"(event, ctx) {
      try {
        await alert(`🚨 poof SESSION FAILED (session ${ctx.session.id}): ${describeFailure(event)}`);
      } catch {
        /* never throw from a failure hook */
      }
    },
  },
});
