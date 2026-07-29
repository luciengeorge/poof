/**
 * The one alert path for production observability, shared by the failure hook
 * (agent/hooks/alert-on-failure.ts) and the online-eval hook (agent/hooks/trace-cycle.ts).
 *
 * Always logs (surfaces in Vercel Observability -> Logs), and pings Slack too when
 * SLACK_ALERT_WEBHOOK_URL is set. NEVER THROWS: both callers are hooks, and a thrown hook is
 * treated by eve as a real failure (escalating to turn.failed / session.failed), so an
 * observability failure must not become a trading failure.
 *
 * The webhook URL is a secret: it is read from the environment and never logged.
 */
export async function alert(text: string): Promise<void> {
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
