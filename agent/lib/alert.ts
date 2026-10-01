import { OBSERVER_FETCH_TIMEOUT_MS, timeoutFetch } from "./fetch-timeout.ts";
import { redact } from "./redact.ts";

/**
 * The one alert path for production observability, shared by the failure hook
 * (agent/hooks/alert-on-failure.ts) and the online-eval hook (agent/hooks/trace-cycle.ts).
 *
 * Always logs (surfaces in Vercel Observability -> Logs), and pings Slack too when
 * SLACK_ALERT_WEBHOOK_URL is set. NEVER THROWS: both callers are hooks, and a thrown hook is
 * treated by eve as a real failure (escalating to turn.failed / session.failed), so an
 * observability failure must not become a trading failure.
 *
 * The webhook post is TIME-BOUNDED. Hooks run inline in eve's event pipeline, so a webhook
 * endpoint that HANGS rather than errors would stall a trading cycle until the OS TCP timeout.
 * With a deadline it degrades to the same caught-and-logged path an erroring endpoint already
 * takes. `timeoutMs` is a parameter only so tests can use a short deadline.
 *
 * The webhook URL is a secret: it is read from the environment and never logged. The text is
 * redacted (agent/lib/redact.ts) before it is logged or posted, so a caller that forgets to
 * redact cannot leak a secret either.
 */
export async function alert(
  text: string,
  timeoutMs: number = OBSERVER_FETCH_TIMEOUT_MS,
): Promise<void> {
  const safeText = redact(text);
  console.error("[alert]", safeText);
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await timeoutFetch(timeoutMs)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: safeText }),
    });
  } catch (err) {
    console.error("[alert] webhook post failed:", err);
  }
}

const MAX_FAILURE_TEXT = 500;
const NO_FAILURE_MESSAGE = "(failure event carried no code or message)";

/**
 * A short, redacted description of an eve `turn.failed` / `session.failed` event, for the alert.
 *
 * THE BUG THIS REPLACES. The hook used to read `data.error.message` and `data.reason`, but eve's
 * payload is `{ code, message, details?, ... }`, so neither ever matched and the fallback ran on
 * every failure: it stringified the whole payload and shipped up to 500 raw characters to Slack.
 * Convex validator errors carry the shared secret, and that path has already leaked it once.
 *
 * Only `code` and `message` are read. `details` is never included: it is free-form, and nothing
 * here can know what it holds. Redaction runs before truncation, so a cut cannot split a secret
 * into a prefix that no longer matches.
 */
export function describeFailure(event: { data?: unknown }): string {
  const data = event?.data;
  if (typeof data !== "object" || data === null) return NO_FAILURE_MESSAGE;
  const { code, message } = data as { code?: unknown; message?: unknown };
  const parts = [code, message].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0) return NO_FAILURE_MESSAGE;
  return redact(parts.join(": ")).slice(0, MAX_FAILURE_TEXT);
}
