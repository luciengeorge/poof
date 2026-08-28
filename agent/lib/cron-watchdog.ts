/**
 * Which day should the cycle watchdog expect a heartbeat for?
 *
 * THE BUG THIS REPLACES. The watchdog used `new Date()` at RUN time to decide which day to
 * check. That is only correct if the job runs on the day it was scheduled for, and GitHub
 * Actions cron is explicitly best-effort: on 2026-08-27 the 16:10 UTC run was delayed by
 * roughly nine hours and executed at 00:51 UTC the NEXT day. It then asked "did Friday's
 * cycle fire?" fourteen hours before Friday's cycle was due, and paged a human at 1:51am
 * about a system that was working perfectly. An alert that fires on correct behaviour is a
 * defect in the alert.
 *
 * The fix is to stop assuming punctuality. Derive the day from the schedule's own semantics:
 * the most recent WEEKDAY whose fire window has already CLOSED, relative to now. That answer
 * is correct whether the watchdog runs on time, hours late, or on a Saturday.
 */

/**
 * The cycle cron is `0 15 * * 1-5`, but Vercel Hobby applies up to ~59 minutes of jitter, so a
 * legitimate fire can land anywhere in 15:00-15:59 UTC. The window is therefore only closed
 * once 16:00 UTC has passed. Checking any earlier is asking whether something happened before
 * it was due.
 */
export const CYCLE_WINDOW_CLOSES_UTC_HOUR = 16;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The most recent day that SHOULD have a cycle heartbeat by `now`, as `YYYY-MM-DD` UTC.
 *
 * Returns null only in the impossible case of no weekday in the preceding week, which keeps
 * the caller total rather than letting a malformed clock loop forever.
 */
export function lastExpectedCycleDay(now: Date): string | null {
  const cursor = new Date(now.getTime());

  // If today's window has not closed yet, today cannot be overdue: start from yesterday.
  if (cursor.getUTCHours() < CYCLE_WINDOW_CLOSES_UTC_HOUR) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // Walk back to the most recent weekday. The cycle does not run at weekends, so a Saturday
  // or Sunday with no heartbeat is expected, not a failure.
  for (let step = 0; step < 8; step += 1) {
    if (!isWeekend(cursor)) return cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return null;
}

/** The UTC calendar day of a heartbeat timestamp, for comparison against the expected day. */
export function heartbeatUtcDay(firedAt: number | string): string {
  return new Date(firedAt).toISOString().slice(0, 10);
}
