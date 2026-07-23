import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedPositions,
  realizedStats,
  realizedStatsByTag,
  orphanedOpenBuys,
  type OpenBuyTrade,
} from "./positions.ts";
import type { T212Position } from "./t212.ts";

function t212pos(over: Partial<T212Position> = {}): T212Position {
  return {
    ticker: "AAPL_US_EQ",
    quantity: 1,
    averagePrice: 100,
    currentPrice: 110,
    ppl: 10,
    maxBuy: 0,
    maxSell: 1,
    pieQuantity: 0,
    ...over,
  };
}

function buy(over: Partial<OpenBuyTrade> = {}): OpenBuyTrade {
  return { _id: "t1", ticker: "AAPL_US_EQ", createdAt: 1000, thesis: "ai demand", ...over };
}

test("buildManagedPositions: joins position to its latest open BUY", () => {
  const m = buildManagedPositions(
    [t212pos()],
    [buy({ _id: "old", createdAt: 1000, stopLossPct: 0.1 }), buy({ _id: "new", createdAt: 2000, stopLossPct: 0.05 })],
    0.8,
  );
  assert.equal(m.length, 1);
  assert.equal(m[0].tradeId, "new"); // latest wins
  assert.equal(m[0].stopLossPct, 0.05);
  assert.equal(m[0].entryPrice, 100);
  assert.equal(m[0].currentPrice, 110);
  assert.equal(m[0].marketValue, 1 * 110 * 0.8);
  assert.equal(m[0].unrealizedPnl, 10);
  assert.equal(m[0].thesis, "ai demand");
});

test("buildManagedPositions: position with no matching BUY still managed (no levels)", () => {
  const m = buildManagedPositions([t212pos({ ticker: "X_US_EQ" })], [], 1);
  assert.equal(m[0].tradeId, undefined);
  assert.equal(m[0].stopLossPct, undefined);
  assert.equal(m[0].openedAt, 0);
});

test("realizedStats: win rate + total over closed trades only", () => {
  const s = realizedStats([
    { status: "closed", pnl: 5 },
    { status: "closed", pnl: -2 },
    { status: "closed", pnl: 3 },
    { status: "placed", pnl: 0 }, // ignored (open)
    { status: "closed" }, // ignored (no pnl)
  ]);
  assert.equal(s.closedCount, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.totalPnl, 6);
  assert.equal(Math.round(s.winRatePct), 67);
  assert.equal(s.closedUnknown, 0);
});

test("realizedStats: closed-unknown rows excluded from wins/losses/total but counted separately", () => {
  const s = realizedStats([
    { status: "closed", pnl: 5 },
    { status: "closed", pnl: -2 },
    { status: "closed-unknown", pnl: 0 },
    { status: "closed-unknown", pnl: 0 },
  ]);
  assert.equal(s.closedCount, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.totalPnl, 3);
  assert.equal(s.closedUnknown, 2);
});

test("realizedStatsByTag: buckets closed trades by strategy tag with correct per-tag stats", () => {
  const byTag = realizedStatsByTag([
    { status: "closed", pnl: 10, strategyTag: "momentum" },
    { status: "closed", pnl: -4, strategyTag: "momentum" },
    { status: "closed", pnl: 6, strategyTag: "momentum" },
    { status: "closed", pnl: -3, strategyTag: "earnings-play" },
    { status: "placed", pnl: 0, strategyTag: "momentum" }, // ignored (open)
  ]);
  assert.equal(byTag.momentum.closedCount, 3);
  assert.equal(byTag.momentum.wins, 2);
  assert.equal(byTag.momentum.losses, 1);
  assert.equal(byTag.momentum.totalPnl, 12);
  assert.equal(Math.round(byTag.momentum.winRatePct), 67);
  assert.equal(byTag["earnings-play"].closedCount, 1);
  assert.equal(byTag["earnings-play"].wins, 0);
  assert.equal(byTag["earnings-play"].losses, 1);
  assert.equal(byTag["earnings-play"].totalPnl, -3);
});

test("realizedStatsByTag: missing/unknown tags bucket under 'other'", () => {
  const byTag = realizedStatsByTag([
    { status: "closed", pnl: 5 }, // no tag
    { status: "closed", pnl: -1, strategyTag: "not-a-real-tag" }, // unknown tag
    { status: "closed", pnl: 2, strategyTag: "momentum" },
  ]);
  assert.equal(byTag.other.closedCount, 2);
  assert.equal(byTag.other.totalPnl, 4);
  assert.equal(byTag.momentum.closedCount, 1);
  assert.equal(Object.keys(byTag).sort().join(","), "momentum,other");
});

test("orphanedOpenBuys: open buys not held anymore", () => {
  const orphans = orphanedOpenBuys(
    [buy({ _id: "held", ticker: "AAPL_US_EQ" }), buy({ _id: "gone", ticker: "TSLA_US_EQ" })],
    [t212pos({ ticker: "AAPL_US_EQ" })],
  );
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]._id, "gone");
});
