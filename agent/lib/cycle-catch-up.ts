export const CYCLE_MESSAGE =
  "Run one trading cycle now, following your instructions, and post the summary here.";

/** The UTC calendar day of a timestamp, e.g. "2026-10-28". Same day key the cron watchdog uses. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Should the catch-up start a cycle? Only when today's primary cycle cron left no heartbeat.
 *
 * `latest` is the newest `cycle` cron run, null when there has never been one, or "unreadable"
 * when the lookup failed. An unreadable heartbeat never dispatches: a duplicate cycle risks a
 * second set of orders, which is worse than one missed day.
 */
export function shouldCatchUp(
  latest: { firedAt?: unknown } | null | "unreadable",
  now: Date,
): boolean {
  if (latest === "unreadable") return false;
  if (latest === null || typeof latest.firedAt !== "number") return true;
  return utcDay(latest.firedAt) !== utcDay(now.getTime());
}
