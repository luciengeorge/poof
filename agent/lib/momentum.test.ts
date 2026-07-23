import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "./data.ts";
import {
  rankMomentum,
  aboveTrend,
  momentumScore,
  type MomentumConfig,
} from "./momentum.ts";

/** Terse candle builder; only the close matters for momentum, so open=high=low=close. */
function bar(date: string, close: number): Candle {
  return { date, open: close, high: close, low: close, close };
}

// Small config so the fixtures stay readable: 12-1 becomes "return from 4 sessions ago to
// 1 session ago", trend SMA over 3 sessions. Six dated bars per ticker (indices 0..5).
const CFG: MomentumConfig = { lookbackDays: 4, skipDays: 1, trendWindow: 3 };
const DATES = [
  "2024-01-01",
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
  "2024-01-08",
];
const AS_OF = "2024-01-08"; // the last bar (index 5)

// With lookbackDays=4, skipDays=1 and 6 bars: startIdx = 5-4 = 1, endIdx = 5-1 = 4.
// Score = close[idx4] / close[idx1] - 1. We pin idx1 to 100 for all three names so the
// ranking is read straight off the idx4 close.
function series(idx1: number, idx4: number, tail: number): Candle[] {
  return [
    bar(DATES[0], 50),
    bar(DATES[1], idx1),
    bar(DATES[2], 200),
    bar(DATES[3], 200),
    bar(DATES[4], idx4),
    bar(DATES[5], tail),
  ];
}

test("rankMomentum ranks the universe by trailing 12-1 return, descending", () => {
  const universe: Record<string, Candle[]> = {
    HImom: series(100, 130, 130), // +30%
    MIDmom: series(100, 110, 110), // +10%
    LOmom: series(100, 90, 90), // -10%
  };
  const ranked = rankMomentum(universe, AS_OF, CFG);

  assert.deepEqual(
    ranked.map((r) => r.ticker),
    ["HImom", "MIDmom", "LOmom"],
  );
  assert.ok(Math.abs(ranked[0].score - 0.3) < 1e-9);
  assert.ok(Math.abs(ranked[1].score - 0.1) < 1e-9);
  assert.ok(Math.abs(ranked[2].score - -0.1) < 1e-9);
  assert.deepEqual(
    ranked.map((r) => r.direction),
    ["long", "long", "short"],
  );
});

test("rankMomentum excludes tickers without enough history", () => {
  const universe: Record<string, Candle[]> = {
    FULL: series(100, 120, 120),
    SHORT: [bar(DATES[4], 100), bar(DATES[5], 200)], // only 2 bars, no valid window
  };
  const ranked = rankMomentum(universe, AS_OF, CFG);
  assert.deepEqual(
    ranked.map((r) => r.ticker),
    ["FULL"],
  );
});

test("look-ahead safety: a spike AFTER asOfDate does not change the score", () => {
  const before = series(100, 130, 130);
  const withFutureSpike: Candle[] = [
    ...before,
    bar("2024-01-09", 9_999), // huge print strictly after asOfDate
  ];
  const scoreBefore = momentumScore(before, AS_OF, CFG);
  const scoreAfter = momentumScore(withFutureSpike, AS_OF, CFG);
  assert.notEqual(scoreBefore, null);
  assert.equal(scoreAfter, scoreBefore);
});

test("aboveTrend flags whether the as-of close sits above its N-day SMA", () => {
  // Last 3 closes (indices 3,4,5) drive the 3-day SMA and the as-of close is index 5.
  // UPtrend: closes 200,130,180 => SMA 170, as-of 180 > 170 => true.
  const up: Candle[] = series(100, 130, 180);
  // DOWNtrend: closes 200,130,120 => SMA 150, as-of 120 < 150 => false.
  const down: Candle[] = series(100, 130, 120);
  assert.equal(aboveTrend(up, AS_OF, CFG.trendWindow), true);
  assert.equal(aboveTrend(down, AS_OF, CFG.trendWindow), false);
});

test("aboveTrend returns false without enough history for the SMA window", () => {
  const shallow: Candle[] = [bar(DATES[4], 100), bar(DATES[5], 200)];
  assert.equal(aboveTrend(shallow, AS_OF, CFG.trendWindow), false);
});
