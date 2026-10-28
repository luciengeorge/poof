import { heartbeatUtcDay } from "./cron-watchdog.ts";

export const CYCLE_MESSAGE =
  "Run one trading cycle now, following your instructions, and post the summary here.";

type Evidence<T> = T | "unreadable";

/**
 * Should the catch-up start a cycle? Only when NEITHER sign of today's cycle exists: no `cycle`
 * cron heartbeat today and no cycle trace started today.
 *
 * Two signals because cycle.ts still dispatches when its heartbeat write fails, so a missing
 * heartbeat alone does not prove the cycle never ran. Any unreadable signal never dispatches:
 * a duplicate cycle risks a second set of orders, which is worse than one missed day.
 */
export function shouldCatchUp(
  latestHeartbeat: Evidence<{ firedAt?: unknown } | null>,
  traceStarts: Evidence<readonly number[]>,
  now: Date,
): boolean {
  if (latestHeartbeat === "unreadable" || traceStarts === "unreadable") return false;
  const today = heartbeatUtcDay(now.getTime());
  const firedAt = latestHeartbeat?.firedAt;
  if (typeof firedAt === "number" && heartbeatUtcDay(firedAt) === today) return false;
  return !traceStarts.some((startedAt) => heartbeatUtcDay(startedAt) === today);
}
