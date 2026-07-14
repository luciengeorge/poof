import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkExits,
  effectiveLevels,
  DEFAULT_EXITS,
  type OpenPosition,
} from "./exits.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY; // arbitrary fixed "now" (epoch ms)

function pos(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    ticker: "AAPL_US_EQ",
    entryPrice: 100,
    currentPrice: 100,
    marketValue: 10,
    openedAt: NOW - DAY, // 1 day old
    ...over,
  };
}

test("effectiveLevels: uses defaults when unset, clamps out-of-bounds", () => {
  assert.deepEqual(effectiveLevels(pos(), DEFAULT_EXITS), {
    stopLossPct: 0.1,
    takeProfitPct: 0.2,
    maxHoldDays: 10,
  });
  const clamped = effectiveLevels(pos({ stopLossPct: 0.9, takeProfitPct: 0.01 }), DEFAULT_EXITS);
  assert.equal(clamped.stopLossPct, DEFAULT_EXITS.maxStopLossPct); // 0.9 -> 0.25
  assert.equal(clamped.takeProfitPct, DEFAULT_EXITS.minTakeProfitPct); // 0.01 -> 0.05
});

test("checkExits: no signal inside the band", () => {
  const r = checkExits([pos({ currentPrice: 105 })], DEFAULT_EXITS, NOW);
  assert.equal(r.length, 0);
});

test("checkExits: stop-loss fires when down past the stop", () => {
  const r = checkExits([pos({ currentPrice: 89, stopLossPct: 0.1 })], DEFAULT_EXITS, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "stop-loss");
  assert.ok(r[0].pnlPct < 0);
  assert.equal(r[0].marketValue, 10);
});

test("checkExits: take-profit fires when up past the target", () => {
  const r = checkExits([pos({ currentPrice: 121, takeProfitPct: 0.2 })], DEFAULT_EXITS, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "take-profit");
});

test("checkExits: stop-loss wins if somehow both would trigger", () => {
  // tp 0.05, sl 0.05; price down 10% -> stop-loss takes priority
  const r = checkExits(
    [pos({ currentPrice: 90, stopLossPct: 0.05, takeProfitPct: 0.05 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r[0].reason, "stop-loss");
});

test("checkExits: max-hold fires when held too long inside the band", () => {
  const r = checkExits(
    [pos({ currentPrice: 102, openedAt: NOW - 11 * DAY, maxHoldDays: 10 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "max-hold");
});

test("checkExits: ignores positions with no valid entry price", () => {
  const r = checkExits([pos({ entryPrice: 0, currentPrice: 50 })], DEFAULT_EXITS, NOW);
  assert.equal(r.length, 0);
});

test("checkExits: unknown open time (openedAt 0) never triggers max-hold", () => {
  const r = checkExits(
    [pos({ currentPrice: 102, openedAt: 0, maxHoldDays: 10 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});

test("checkExits: a real old openedAt still triggers max-hold", () => {
  const r = checkExits(
    [pos({ currentPrice: 102, openedAt: NOW - 11 * DAY, maxHoldDays: 10 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "max-hold");
});

test("checkExits: unknown open time still lets stop-loss fire", () => {
  const r = checkExits(
    [pos({ currentPrice: 89, stopLossPct: 0.1, openedAt: 0 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "stop-loss");
});
