import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRiskState, type StoredRiskState } from "./state.ts";

test("first run: seeds peak + day-start at current equity, no loss days", () => {
  const d = deriveRiskState(null, 50, "2026-06-25");
  assert.deepEqual(d.fields, {
    peakEquity: 50,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  assert.deepEqual(d.persist, {
    peakEquity: 50,
    dayStartEquity: 50,
    dayStartDate: "2026-06-25",
    consecutiveLossDays: 0,
  });
});

const stored = (over: Partial<StoredRiskState> = {}): StoredRiskState => ({
  peakEquity: 50,
  dayStartEquity: 50,
  dayStartDate: "2026-06-25",
  consecutiveLossDays: 0,
  ...over,
});

test("same day: dayPnl is vs day-start, peak rises with equity", () => {
  const d = deriveRiskState(stored(), 53, "2026-06-25");
  assert.equal(d.fields.dayPnl, 3);
  assert.equal(d.fields.peakEquity, 53);
  assert.equal(d.persist.dayStartEquity, 50); // unchanged same day
  assert.equal(d.persist.consecutiveLossDays, 0);
});

test("new day after a down day: consecutiveLossDays increments, day-start resets", () => {
  const d = deriveRiskState(
    stored({ peakEquity: 60, dayStartEquity: 55, dayStartDate: "2026-06-24", consecutiveLossDays: 1 }),
    52, // 52 < prior day-start 55 → prior day a loss
    "2026-06-25",
  );
  assert.equal(d.persist.consecutiveLossDays, 2);
  assert.equal(d.persist.dayStartEquity, 52);
  assert.equal(d.persist.dayStartDate, "2026-06-25");
  assert.equal(d.fields.dayPnl, 0); // fresh day
  assert.equal(d.fields.peakEquity, 60); // peak persists across days
});

test("new day after an up day: consecutiveLossDays resets to 0", () => {
  const d = deriveRiskState(
    stored({ dayStartEquity: 55, dayStartDate: "2026-06-24", consecutiveLossDays: 2 }),
    58, // 58 >= 55 → not a loss
    "2026-06-25",
  );
  assert.equal(d.persist.consecutiveLossDays, 0);
  assert.equal(d.persist.dayStartEquity, 58);
});
