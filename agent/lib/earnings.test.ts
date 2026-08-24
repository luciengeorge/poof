import { test } from "node:test";
import assert from "node:assert/strict";
import { nextEarnings, heldThroughEarnings } from "./earnings.ts";
import { DEFAULT_EXITS } from "./exits.ts";
import type { EarningsEvent } from "./data.ts";

function ev(date: string, over: Partial<EarningsEvent> = {}): EarningsEvent {
  return { symbol: "NKE", date, hour: "amc", epsEstimate: 1.0, ...over };
}

/** Fixed reference day, so the window tests never depend on when they are run. */
const TODAY = "2026-06-25";

/** The ISO date `n` days after TODAY. */
function dayOffset(n: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

test("nextEarnings: picks the soonest upcoming date, computes daysUntil", () => {
  const n = nextEarnings(
    [ev("2026-07-10"), ev("2026-06-26"), ev("2026-09-01")],
    "2026-06-25",
  );
  assert.equal(n?.date, "2026-06-26");
  assert.equal(n?.daysUntil, 1);
  assert.equal(n?.hour, "amc");
});

test("nextEarnings: ignores past prints; null when none upcoming", () => {
  assert.equal(nextEarnings([ev("2026-06-01"), ev("2026-06-20")], "2026-06-25"), null);
});

test("nextEarnings: includes an event dated today (daysUntil 0)", () => {
  const n = nextEarnings([ev("2026-06-25")], "2026-06-25");
  assert.equal(n?.daysUntil, 0);
});

test("heldThroughEarnings: within default 10d window -> true", () => {
  const n = nextEarnings([ev("2026-06-30")], "2026-06-25"); // 5 days
  assert.equal(heldThroughEarnings(n), true);
});

test("heldThroughEarnings: beyond window -> false", () => {
  const n = nextEarnings([ev("2026-07-20")], "2026-06-25"); // 25 days
  assert.equal(heldThroughEarnings(n), false);
});

test("heldThroughEarnings: respects a shorter maxHoldDays (exit before print)", () => {
  const n = nextEarnings([ev("2026-06-30")], "2026-06-25"); // 5 days
  // plan to exit in 3 days -> not held through
  assert.equal(heldThroughEarnings(n, { maxHoldDays: 3 }), false);
  assert.equal(heldThroughEarnings(n, { maxHoldDays: 7 }), true);
});

test("heldThroughEarnings: null next -> false", () => {
  assert.equal(heldThroughEarnings(null), false);
});

test("heldThroughEarnings: the default window TRACKS the exit engine's max hold", () => {
  // The guard and the clock are one decision, not two. This used to be a literal 10 in earnings.ts
  // written independently of DEFAULT_EXITS, so raising the hold to 20 would have left the guard
  // looking 10 days ahead and a position could be held straight through an unflagged print.
  const hold = DEFAULT_EXITS.defaultMaxHoldDays;
  const inside = nextEarnings([ev(dayOffset(hold - 1))], TODAY);
  const outside = nextEarnings([ev(dayOffset(hold + 1))], TODAY);
  assert.equal(heldThroughEarnings(inside), true, "a print inside the hold window must be flagged");
  assert.equal(heldThroughEarnings(outside), false, "a print the clock exits before must not be");
});

test("heldThroughEarnings: a print at 15 days is now inside the window", () => {
  // Pins the actual behaviour change of raising the hold 10 -> 20. At the old default this was
  // false, and a position opened today would have sat through the print with no guard fired.
  assert.equal(heldThroughEarnings(nextEarnings([ev(dayOffset(15))], TODAY)), true);
});
