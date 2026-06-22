import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsMarketOpen, nyParts } from "./clock.ts";

// 2026-06-22 is a Monday. 14:00 UTC = 10:00 EDT (summer, UTC-4).
test("converts UTC to New York wall-clock (DST-aware)", () => {
  const p = nyParts(new Date("2026-06-22T14:00:00Z"));
  assert.equal(p.weekday, "Mon");
  assert.equal(p.hour, 10);
  assert.equal(p.minute, 0);
});

test("market open during regular hours on a weekday", () => {
  // 14:30 UTC = 10:30 EDT -> open
  assert.equal(isUsMarketOpen(new Date("2026-06-22T14:30:00Z")), true);
});

test("market closed before the open", () => {
  // 13:00 UTC = 09:00 EDT -> before 09:30 -> closed
  assert.equal(isUsMarketOpen(new Date("2026-06-22T13:00:00Z")), false);
});

test("market closed after the close", () => {
  // 20:30 UTC = 16:30 EDT -> after 16:00 -> closed
  assert.equal(isUsMarketOpen(new Date("2026-06-22T20:30:00Z")), false);
});

test("market closed on the weekend", () => {
  // 2026-06-20 is a Saturday, 15:00 UTC = 11:00 EDT
  assert.equal(isUsMarketOpen(new Date("2026-06-20T15:00:00Z")), false);
});

test("winter DST offset is handled (EST, UTC-5)", () => {
  // 2026-01-05 is a Monday. 14:30 UTC = 09:30 EST -> open
  assert.equal(isUsMarketOpen(new Date("2026-01-05T14:30:00Z")), true);
  // 14:00 UTC = 09:00 EST -> closed
  assert.equal(isUsMarketOpen(new Date("2026-01-05T14:00:00Z")), false);
});
