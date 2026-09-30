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
    // Deliberately the LITERAL production value, not DEFAULT_EXITS.defaultMaxHoldDays, which
    // would make this tautological. This is the clock a live account trades on: it should not be
    // possible to change it without a test saying so out loud.
    maxHoldDays: 20,
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

test("checkExits: current P&L under +5% no longer disarms a trail armed by the peak", () => {
  // This test used to assert the bug: current +3% was under the +5% line, so the trail
  // stayed dormant even though price 103 is below peak 115 * (1 - 0.08) = 105.8. Arming is
  // off the peak now, and +15% is past the +8.70% breakeven, so it fires and locks in +3%.
  const r = checkExits(
    [pos({ currentPrice: 103, peakPrice: 115, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "trailing-stop");
});

test("checkExits: at a fresh high the trail ratchets up to the current price", () => {
  // New high: current 130 above the stale stored peak 120, so the effective peak
  // ratchets to max(120, 130) = 130 (trail stop 119.6). A fresh high can never
  // fire in the same call (price == peak), so we observe the ratchet on the next
  // tick: a pullback to 121 is above the 130-anchored stop (119.6) and must NOT
  // fire, which it only survives because the peak ratcheted to 130 rather than
  // staying at the stored 120 (whose stop 110.4 would be well clear too, but a
  // stored peak of 132 would fire). The paired firing case below pins the peak
  // value directly via the detail string.
  const fresh = checkExits(
    [pos({ currentPrice: 130, peakPrice: 120, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(fresh.length, 0);
  // Prove the trail is anchored to the ratcheted high-water mark (130), not the
  // current price: a drop to 119 is below 130*(1-0.08)=119.6 and fires, and the
  // detail reports the ratcheted peak.
  const r = checkExits(
    [pos({ currentPrice: 119, peakPrice: 130, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "trailing-stop");
  assert.match(r[0].detail, /peak 130\.00/);
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
  // The detail reflects the exact peak that anchors the trail (observes the peak used).
  assert.match(r[0].detail, /peak 150\.00/);
});

test("checkExits: trailing stop wins over take-profit when both would trigger", () => {
  // Peak 200, current 150: +50% pnl is past the 40% TP backstop, and 150 is also
  // below the trail stop 200*(1-0.08)=184. Precedence puts trailing-stop first.
  const r = checkExits(
    [pos({ currentPrice: 150, peakPrice: 200, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "trailing-stop");
});

test("checkExits: hard stop-loss wins over the trailing stop when the position is down", () => {
  // Down 12% (past the 10% hard stop). The peak of 150 arms the trail and current is
  // below its stop too, but the hard stop is the floor and comes first -> stop-loss.
  const r = checkExits(
    [pos({ currentPrice: 88, peakPrice: 150, stopLossPct: 0.1, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "stop-loss");
});

test("checkExits: trail arms off the peak, so a winner that fell back to +0.2% still exits", () => {
  // Peak +9% is past the +8.70% breakeven for an 8% trail, so the trail is armed. Stop is
  // 109 * 0.92 = 100.28 and current 100.2 is below it. Arming on current P&L (+0.2%, under
  // the +5% line) left this position riding to the time stop instead.
  const r = checkExits(
    [pos({ currentPrice: 100.2, peakPrice: 109, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "trailing-stop");
});

test("checkExits: trail stays dormant while the peak is under this trail's breakeven", () => {
  // Peak +8% is under the +8.70% breakeven, so the trail is not armed even though current
  // 99.3 is below its stop 108 * 0.92 = 99.36. Firing here would realise a -0.7% loss.
  const r = checkExits(
    [pos({ currentPrice: 99.3, peakPrice: 108, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});

test("checkExits: a +5% peak cannot arm the trail and stop out at -3.4%", () => {
  // The case the fixed +5% activation would have allowed: peak 105, stop 105 * 0.92 = 96.6,
  // current 96.6 sits on it. Arming at +5% off the peak would exit a winner at -3.4%.
  const r = checkExits(
    [pos({ currentPrice: 96.6, peakPrice: 105, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});

test("checkExits: breakeven activation follows each position's own trail width", () => {
  // A 15% trail breaks even at a +17.6% peak, not the +8.7% of the 8% default. Peak +12%
  // with current 95 under the stop 112 * 0.85 = 95.2 must not fire.
  const dormant = checkExits(
    [pos({ currentPrice: 95, peakPrice: 112, trailingStopPct: 0.15 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(dormant.length, 0);
  // Peak +20% clears that breakeven; current 102 sits on the stop 120 * 0.85 = 102 and fires.
  const armed = checkExits(
    [pos({ currentPrice: 102, peakPrice: 120, trailingStopPct: 0.15 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(armed.length, 1);
  assert.equal(armed[0].reason, "trailing-stop");
});

test("checkExits: stop-loss still wins over an armed trail when both would trigger", () => {
  // Peak +10% arms the 8% trail (stop 101.2) and current 89 is below it, but it is also
  // past the 10% hard stop, which comes first in precedence.
  const r = checkExits(
    [pos({ currentPrice: 89, peakPrice: 110, stopLossPct: 0.1, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "stop-loss");
});

test("checkExits: no stored peak and no rise never arms the trail", () => {
  // With no peakPrice the peak falls back to entry (100), so the trail stop is 92 and
  // current 91 is below it. A position that never rose cannot arm the trail; the 10% hard
  // stop at 90 is not hit either, so nothing fires.
  const r = checkExits(
    [pos({ currentPrice: 91, stopLossPct: 0.1, trailingStopPct: 0.08 })],
    DEFAULT_EXITS,
    NOW,
  );
  assert.equal(r.length, 0);
});
