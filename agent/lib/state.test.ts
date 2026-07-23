import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRiskState, resolveLimits, type StoredRiskState } from "./state.ts";
import { checkHalt, DEFAULT_LIMITS } from "./risk.ts";

test("resolveLimits: returns the shipped defaults when no env overrides", () => {
  assert.deepEqual(resolveLimits({}), DEFAULT_LIMITS);
});

test("resolveLimits: TRADING_* env vars override individual limits", () => {
  const limits = resolveLimits({
    TRADING_MAX_DEPLOYED_PCT: "0.5",
    TRADING_MAX_TRADE_PCT: "0.1",
    TRADING_MAX_PER_NAME_PCT: "",
    TRADING_MIN_PRICE: "not-a-number",
  });
  assert.equal(limits.maxDeployedPct, 0.5);
  assert.equal(limits.maxTradePct, 0.1);
  assert.equal(limits.maxPerNamePct, DEFAULT_LIMITS.maxPerNamePct); // blank -> default
  assert.equal(limits.minPrice, DEFAULT_LIMITS.minPrice); // non-numeric -> default
});

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
    prevEquity: 50,
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
  // dayPnl is vs the prevEquity reference (yesterday's day-start, 55), not the just-reset
  // dayStartEquity: a same-day 5% intraday move must still be visible to checkHalt.
  assert.equal(d.fields.dayPnl, -3);
  assert.equal(d.persist.prevEquity, 55);
  assert.equal(d.fields.peakEquity, 60); // peak persists across days
});

test("day rollover with a >4% drop trips checkHalt's daily cap", () => {
  const d = deriveRiskState(
    stored({ peakEquity: 100, dayStartEquity: 100, dayStartDate: "2026-06-24", consecutiveLossDays: 0 }),
    95, // 5% drop vs prior day-start
    "2026-06-25",
  );
  assert.equal(d.fields.dayPnl, -5);
  assert.equal(d.persist.prevEquity, 100);

  const halt = checkHalt(
    { equity: 95, cash: 0, positions: [], ...d.fields },
    DEFAULT_LIMITS,
  );
  assert.equal(halt.halted, true);
  assert.match(halt.reason ?? "", /daily loss cap/);

  // SAME-DAY second derive (e.g. submit_orders running after manage_positions already
  // persisted this cycle's state) must see the SAME reference, not reset to currentEquity:
  // this is the regression guard for resolveRiskState running twice per cycle.
  const second = deriveRiskState(d.persist, 95, "2026-06-25");
  assert.equal(second.fields.dayPnl, -5);
  assert.equal(second.persist.prevEquity, 100);
  const secondHalt = checkHalt(
    { equity: 95, cash: 0, positions: [], ...second.fields },
    DEFAULT_LIMITS,
  );
  assert.equal(secondHalt.halted, true);
});

test("flat day: dayPnl stays ~0 against the stable reference", () => {
  const d = deriveRiskState(stored({ prevEquity: 50 }), 50, "2026-06-25");
  assert.equal(d.fields.dayPnl, 0);
  assert.equal(d.persist.prevEquity, 50);
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

test("new day after a small sub-threshold drop: noise, consecutiveLossDays resets to 0", () => {
  const d = deriveRiskState(
    stored({ dayStartEquity: 100, dayStartDate: "2026-06-24", consecutiveLossDays: 2 }),
    99.5, // 0.5% drop, below the 1.5% default threshold → not a loss day
    "2026-06-25",
  );
  assert.equal(d.persist.consecutiveLossDays, 0);
  assert.equal(d.persist.dayStartEquity, 99.5);
});

test("new day after a drop exceeding the threshold: counts as a loss day", () => {
  const d = deriveRiskState(
    stored({ dayStartEquity: 100, dayStartDate: "2026-06-24", consecutiveLossDays: 1 }),
    97, // 3% drop, above the 1.5% default threshold → a loss day
    "2026-06-25",
  );
  assert.equal(d.persist.consecutiveLossDays, 2);
  assert.equal(d.persist.dayStartEquity, 97);
});

test("lossDayMinDropPct is tunable: a 3% drop no longer counts under a 5% threshold", () => {
  const d = deriveRiskState(
    stored({ dayStartEquity: 100, dayStartDate: "2026-06-24", consecutiveLossDays: 2 }),
    97, // 3% drop
    "2026-06-25",
    0.05,
  );
  assert.equal(d.persist.consecutiveLossDays, 0);
  assert.equal(d.persist.dayStartEquity, 97);
});
