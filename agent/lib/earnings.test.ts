import { test } from "node:test";
import assert from "node:assert/strict";
import { nextEarnings, heldThroughEarnings } from "./earnings.ts";
import type { EarningsEvent } from "./data.ts";

function ev(date: string, over: Partial<EarningsEvent> = {}): EarningsEvent {
  return { symbol: "NKE", date, hour: "amc", epsEstimate: 1.0, ...over };
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
