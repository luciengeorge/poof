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
    takeProfitPct: DEFAULT_EXITS.defaultTakeProfitPct,
    maxHoldDays: 10,
    trailingStopPct: DEFAULT_EXITS.defaultTrailingStopPct,
  });
  const clamped = effectiveLevels(
    pos({ stopLossPct: 0.9, takeProfitPct: 0.01, trailingStopPct: 0.9 }),
    DEFAULT_EXITS,
  );
  assert.equal(clamped.stopLossPct, DEFAULT_EXITS.maxStopLossPct); // 0.9 -> 0.25
  assert.equal(clamped.takeProfitPct, DEFAULT_EXITS.minTakeProfitPct); // 0.01 -> 0.05
  assert.equal(clamped.trailingStopPct, DEFAULT_EXITS.maxTrailingStopPct); // 0.9 -> 0.2
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

test("checkExits: trailing stop is dormant below the activation threshold", () => {
  // Up only 3% (< 5% activation): the trail must NOT fire even though price 103
  // is below peak 115 * (1 - 0.08) = 105.8. Below activation only the hard stop
  // governs, and the hard stop isn't hit -> no exit.
  const r = checkExits(
    [pos({ currentPrice: 103, peakPrice: 115, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});

test("checkExits: at a fresh high the trail ratchets up and does not fire", () => {
  // New high: current 130 above the stale stored peak 120, so the effective peak
  // ratchets to 130 (trail stop 119.6). No pullback yet, and 30% is under the 40%
  // take-profit backstop -> no exit.
  const r = checkExits(
    [pos({ currentPrice: 130, peakPrice: 120, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});

test("checkExits: trailing stop fires on a pullback from the peak once activated", () => {
  // Up 35% (>= 5% activation). Peak 150, trail 8% -> stop at 138. Price pulled
  // back to 135 (<= 138) -> trailing-stop fires (and TP backstop 40% not reached).
  const r = checkExits(
    [pos({ currentPrice: 135, peakPrice: 150, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "trailing-stop");
});

test("checkExits: hard stop-loss wins over the trailing stop when the position is down", () => {
  // Down 12% (past the 10% hard stop). The trail would also point below current,
  // but the position is below activation and the hard stop is the floor -> stop-loss.
  const r = checkExits(
    [pos({ currentPrice: 88, peakPrice: 150, stopLossPct: 0.1, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "stop-loss");
});
