import { DEFAULT_EXITS } from "./exits.ts";
import type { Proposal } from "./orders.ts";

/**
 * Entry-time floor on `maxHoldDays`.
 *
 * THE BUG THIS CLOSES. The exit engine resolves `p.maxHoldDays ?? defaultMaxHoldDays`, so a
 * per-position value always wins over the default. In seven weeks live the model stamped
 * `maxHoldDays: 10` on 35 of 51 BUYs (six more at 7, three at 5), and 32 of 32 closed positions
 * exited on the clock: zero trailing-stop exits, zero take-profit exits. The trailing stop needs a
 * +5% activation and then an 8% pullback from the high-water mark; a ten-day clock closes the
 * position first. Raising the default to 20 changed nothing, because the default was never used.
 *
 * The one legitimate reason for a short hold is an earnings print inside the window: holding
 * through a print is gap risk a stop cannot protect, and exiting the day before is the designed
 * answer. So a short hold is kept only when the proposal names that date and the hold actually
 * ends before it. Otherwise the per-position value is dropped and the default applies.
 *
 * Existing open positions keep the value they were entered with. This runs at entry only, so it
 * cannot reinterpret a stored short hold whose earnings justification was never recorded.
 */

/** Below this, a per-position hold is a clock instead of a backstop and needs a reason. */
export const MIN_MAX_HOLD_DAYS = 15;
const DAY_MS = 86_400_000;

export interface HoldFloorResult {
  proposals: Proposal[];
  /** One line per proposal whose hold was changed, worded for the cycle report. */
  notes: string[];
}

/** Calendar days from today to the date, both taken at UTC midnight, so 14:00 today does not
 * turn "eight days away" into seven. */
function daysUntil(isoDate: string, now: number): number | null {
  const at = Date.parse(isoDate);
  if (!Number.isFinite(at)) return null;
  const today = new Date(now);
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((at - startOfToday) / DAY_MS);
}

export function applyHoldFloor(
  proposals: readonly Proposal[],
  now: number = Date.now(),
  minMaxHoldDays: number = MIN_MAX_HOLD_DAYS,
): HoldFloorResult {
  const notes: string[] = [];
  const out = proposals.map((p) => {
    if (p.side !== "BUY") return p;
    if (p.maxHoldDays === undefined || p.maxHoldDays >= minMaxHoldDays) return p;

    const until = p.earningsDate ? daysUntil(p.earningsDate, now) : null;
    // An earnings date inside the default window explains a short hold: exit the session before.
    if (until !== null && until > 0 && until <= DEFAULT_EXITS.defaultMaxHoldDays) {
      const beforePrint = Math.max(1, until - 1);
      if (p.maxHoldDays <= beforePrint) return p;
      notes.push(
        `${p.ticker}: maxHoldDays ${p.maxHoldDays} moved to ${beforePrint}, the session before earnings on ${p.earningsDate}.`,
      );
      return { ...p, maxHoldDays: beforePrint };
    }

    const { maxHoldDays: _dropped, ...rest } = p;
    notes.push(
      `${p.ticker}: maxHoldDays ${p.maxHoldDays} dropped (below the ${minMaxHoldDays}-day floor with no earnings date); the ${DEFAULT_EXITS.defaultMaxHoldDays}-day default applies so the trailing stop can run.`,
    );
    return rest;
  });
  return { proposals: out, notes };
}
