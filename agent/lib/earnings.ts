/**
 * Pick the next upcoming earnings report from a calendar and decide whether it falls
 * inside a position's intended hold window, i.e. whether the position would be held
 * THROUGH the print (uncontrolled binary/gap risk) unless it's a deliberate earnings play.
 * Pure + unit-tested. Dates are YYYY-MM-DD (UTC-naive day comparison is fine here).
 */
import type { EarningsEvent } from "./data.ts";
import { DEFAULT_EXITS } from "./exits.ts";

export interface NextEarnings {
  date: string;
  hour: string; // "bmo" | "amc" | "dmh" | ""
  daysUntil: number;
  epsEstimate: number | null;
}

const dayMs = 86_400_000;

function daysBetween(todayISO: string, dateISO: string): number {
  const a = Date.parse(`${todayISO}T00:00:00Z`);
  const b = Date.parse(`${dateISO}T00:00:00Z`);
  return Math.round((b - a) / dayMs);
}

/** Soonest earnings on or after `todayISO`, or null if none upcoming in the calendar. */
export function nextEarnings(
  events: EarningsEvent[],
  todayISO: string,
): NextEarnings | null {
  const upcoming = events
    .filter((e) => e.date >= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date));
  const e = upcoming[0];
  if (!e) return null;
  return {
    date: e.date,
    hour: e.hour,
    daysUntil: daysBetween(todayISO, e.date),
    epsEstimate: e.epsEstimate,
  };
}

/**
 * Would a position opened today be held THROUGH this earnings print?
 * True when earnings land within the hold window: `maxHoldDays` if set, else
 * `defaultWindowDays` (a position with no explicit horizon is assumed held that long).
 *
 * The final fallback READS `DEFAULT_EXITS.defaultMaxHoldDays` rather than repeating the number.
 * It used to be a literal 10 written independently of the exit engine, which meant raising the
 * default hold to 20 would have left this guard looking only 10 days ahead: a position could then
 * be held straight through a print that was never flagged, which is exactly the uncontrolled gap
 * risk this function exists to prevent. Two constants that must agree should not be two constants.
 */
export function heldThroughEarnings(
  next: NextEarnings | null,
  opts: { maxHoldDays?: number; defaultWindowDays?: number } = {},
): boolean {
  if (!next) return false;
  const window =
    opts.maxHoldDays ?? opts.defaultWindowDays ?? DEFAULT_EXITS.defaultMaxHoldDays;
  return next.daysUntil >= 0 && next.daysUntil <= window;
}
