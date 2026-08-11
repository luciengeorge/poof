import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecordTradeArgs,
  buildCloseTradeArgs,
  buildOrphanCloseTradeArgs,
  PLACED_STATUS,
} from "./order-bookkeeping.ts";
import type { PlacedResult, Proposal } from "./orders.ts";
import type { ManagedPosition, OpenBuyTrade } from "./positions.ts";

function buy(over: Partial<Proposal> = {}): Proposal {
  return {
    ticker: "AAPL_US_EQ",
    side: "BUY",
    notional: 500,
    price: 100,
    thesis: "t",
    ...over,
  };
}

function placed(over: Partial<PlacedResult> = {}): PlacedResult {
  return { proposal: buy(), quantity: 5, dryRun: false, ...over };
}

test("PLACED_STATUS is the literal string openBuys() filters trades on", () => {
  // openBuys (convex/memory.ts) matches trades on status === "placed" && side === "BUY".
  // If this drifts, a live position silently disappears from the stop-loss engine.
  assert.equal(PLACED_STATUS, "placed");
});

test("buildRecordTradeArgs: a placed (live) BUY gets status === PLACED_STATUS", () => {
  const args = buildRecordTradeArgs([placed()], "live");
  assert.equal(args.length, 1);
  assert.equal(args[0].status, PLACED_STATUS);
  assert.equal(args[0].status, "placed");
});

test("buildRecordTradeArgs: a dry-run BUY gets status 'dry-run'", () => {
  const args = buildRecordTradeArgs([placed({ dryRun: true })], "demo");
  assert.equal(args[0].status, "dry-run");
});

test("buildRecordTradeArgs: a skipped result gets status 'skipped' regardless of dryRun", () => {
  const args = buildRecordTradeArgs(
    [placed({ dryRun: false, skipped: "a pending order already exists" })],
    "live",
  );
  assert.equal(args[0].status, "skipped");
});

test("buildRecordTradeArgs: carries exit levels + trade fields through unchanged", () => {
  const proposal = buy({
    stopLossPct: 0.1,
    takeProfitPct: 0.2,
    trailingStopPct: 0.08,
    maxHoldDays: 30,
    redTeamVerdict: "approved",
    strategyTag: "momentum",
    confidence: 0.62,
  });
  const args = buildRecordTradeArgs(
    [{ proposal, quantity: 5, dryRun: false }],
    "live",
  );
  assert.deepEqual(args[0], {
    env: "live",
    ticker: "AAPL_US_EQ",
    side: "BUY",
    notional: 500,
    price: 100,
    quantity: 5,
    dryRun: false,
    thesis: "t",
    redTeamVerdict: "approved",
    strategyTag: "momentum",
    // Carried through so calibration can score the claim once the position closes.
    predictedConfidence: 0.62,
    status: "placed",
    stopLossPct: 0.1,
    takeProfitPct: 0.2,
    trailingStopPct: 0.08,
    maxHoldDays: 30,
  });
});

test("buildRecordTradeArgs: maps each placed result independently, preserving order", () => {
  const args = buildRecordTradeArgs(
    [
      placed({ proposal: buy({ ticker: "AAA" }) }),
      placed({ proposal: buy({ ticker: "BBB" }), dryRun: true }),
      placed({ proposal: buy({ ticker: "CCC" }), skipped: "quantity rounds to 0" }),
    ],
    "live",
  );
  assert.deepEqual(
    args.map((a) => [a.ticker, a.status]),
    [
      ["AAA", "placed"],
      ["BBB", "dry-run"],
      ["CCC", "skipped"],
    ],
  );
});

function managedPosition(over: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    ticker: "AAPL_US_EQ",
    entryPrice: 100,
    currentPrice: 90,
    marketValue: 900,
    openedAt: 0,
    unrealizedPnl: -100,
    tradeId: "trade_1",
    ...over,
  };
}

test("buildCloseTradeArgs: an executed exit closes its matched originating BUY", () => {
  const byTicker = new Map([["AAPL_US_EQ", managedPosition()]]);
  const args = buildCloseTradeArgs(
    [placed({ proposal: buy({ side: "SELL" }) })],
    byTicker,
  );
  assert.deepEqual(args, [{ tradeId: "trade_1", pnl: -100, exitPrice: 90 }]);
});

test("buildCloseTradeArgs: skips a skipped placed exit (no order actually sent)", () => {
  const byTicker = new Map([["AAPL_US_EQ", managedPosition()]]);
  const args = buildCloseTradeArgs(
    [placed({ proposal: buy({ side: "SELL" }), skipped: "a pending order already exists" })],
    byTicker,
  );
  assert.deepEqual(args, []);
});

test("buildCloseTradeArgs: skips an exit with no known originating BUY (no tradeId)", () => {
  const byTicker = new Map([
    ["AAPL_US_EQ", managedPosition({ tradeId: undefined })],
  ]);
  const args = buildCloseTradeArgs(
    [placed({ proposal: buy({ side: "SELL" }) })],
    byTicker,
  );
  assert.deepEqual(args, []);
});

test("buildOrphanCloseTradeArgs: closes an orphaned open BUY with zero pnl and status closed-unknown", () => {
  const orphan: OpenBuyTrade = {
    _id: "trade_2",
    ticker: "TSLA_US_EQ",
    createdAt: 0,
    thesis: "t",
  };
  // No observed price on this row, so it still books unknown: the honest fallback is preserved.
  const args = buildOrphanCloseTradeArgs([orphan], 0.75);
  assert.deepEqual(args, [{ tradeId: "trade_2", pnl: 0, status: "closed-unknown" }]);
});

// --- orphan reconciliation: recover a REAL observed outcome instead of discarding it ---
//
// On 2026-08-10, three of seven closures (OXY, LNG, CRM) were booked `closed-unknown` with pnl 0
// because the positions had already left the broker. That starves the learning loop by design:
// attribution excludes unknown outcomes and calibration cannot score them, so a third of closures
// taught nothing. The fix is NOT to estimate from today's price, which would inject a fabricated
// number into the very measurements being fed. It is to record the price we ACTUALLY observed while
// the position was still visible, and reconcile from that.

const orphan = (over: Record<string, unknown> = {}) => ({
  _id: "t1",
  ticker: "OXY_US_EQ",
  createdAt: 1_785_000_000_000,
  thesis: "energy catalyst",
  price: 50,
  quantity: 2,
  ...over,
});

test("an orphan with a LAST OBSERVED price closes with a real P&L, not a placeholder", () => {
  // Observed at 55 having entered at 50, 2 shares, fx 0.75 -> (55-50)*2*0.75 = 7.50
  const args = buildOrphanCloseTradeArgs([orphan({ lastPrice: 55, lastSeenAt: 1 })], 0.75);
  assert.equal(args.length, 1);
  assert.equal(args[0]?.status, "closed-estimated");
  assert.ok(Math.abs((args[0]?.pnl ?? 0) - 7.5) < 1e-9);
  assert.equal(args[0]?.exitPrice, 55);
});

test("a LOSS is recovered just as faithfully as a gain", () => {
  const args = buildOrphanCloseTradeArgs([orphan({ lastPrice: 40, lastSeenAt: 1 })], 0.75);
  assert.ok((args[0]?.pnl ?? 0) < 0, "a position last seen below entry closed at a loss");
});

test("REGRESSION: with NO observed price it stays closed-unknown rather than inventing one", () => {
  // The honest fallback. A fabricated outcome entering attribution is worse than a missing one,
  // because a missing outcome is excluded by design while a wrong one is believed.
  const args = buildOrphanCloseTradeArgs([orphan()], 0.75);
  assert.equal(args[0]?.status, "closed-unknown");
  assert.equal(args[0]?.pnl, 0);
  assert.equal(args[0]?.exitPrice, undefined);
});

test("a missing quantity or entry price also falls back rather than computing nonsense", () => {
  for (const broken of [{ lastPrice: 55, quantity: undefined }, { lastPrice: 55, price: undefined }]) {
    const args = buildOrphanCloseTradeArgs([orphan(broken)], 0.75);
    assert.equal(args[0]?.status, "closed-unknown", JSON.stringify(broken));
  }
});

test("a non-finite fx rate cannot produce a NaN P&L", () => {
  const args = buildOrphanCloseTradeArgs([orphan({ lastPrice: 55, lastSeenAt: 1 })], Number.NaN);
  assert.equal(args[0]?.status, "closed-unknown");
});
