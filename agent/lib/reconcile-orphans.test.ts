import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExitScope, reconcileOrphans } from "../tools/manage_positions.ts";
import { CORE_TICKER } from "./core.ts";
import type { CloseTradeArgs } from "./order-bookkeeping.ts";
import type { OpenBuyTrade } from "./positions.ts";
import type { T212Position } from "./t212.ts";

function position(ticker: string): T212Position {
  return {
    ticker,
    quantity: 2,
    averagePrice: 100,
    currentPrice: 95,
    ppl: -10,
    maxBuy: 0,
    maxSell: 2,
    pieQuantity: 0,
  };
}

function openBuy(ticker: string, over: Partial<OpenBuyTrade> = {}): OpenBuyTrade {
  return { _id: `trade-${ticker}`, ticker, createdAt: 1000, thesis: "t", ...over };
}

function recorder() {
  const closed: CloseTradeArgs[] = [];
  const alerts: string[] = [];
  return {
    closed,
    alerts,
    closeTrade: async (a: CloseTradeArgs) => {
      closed.push(a);
    },
    alert: async (text: string) => {
      alerts.push(text);
    },
  };
}

test("reconcileOrphans: an empty portfolio read closes nothing and alerts once with the reason", async () => {
  const r = recorder();
  const result = await reconcileOrphans({
    openBuys: [openBuy("VRT_US_EQ"), openBuy("ALK_US_EQ"), openBuy("LLY_US_EQ")],
    rawPositions: [],
    pendingTickers: new Set(),
    fxRate: 0.75,
    closeTrade: r.closeTrade,
    alert: r.alert,
  });
  assert.ok(result.status === "refused", "an empty read with open BUYs must be refused");
  assert.match(result.reason, /empty portfolio/);
  assert.equal(r.closed.length, 0);
  assert.equal(r.alerts.length, 1);
  assert.ok(r.alerts[0].includes(result.reason), "the alert must carry the reason");
});

test("reconcileOrphans: a good read closes exactly the orphan, priced as before, and does not alert", async () => {
  const r = recorder();
  const result = await reconcileOrphans({
    openBuys: [
      openBuy("GE_US_EQ"),
      openBuy("VRT_US_EQ", { price: 100, quantity: 2, lastPrice: 90 }),
    ],
    rawPositions: [position(CORE_TICKER), position("GE_US_EQ")],
    pendingTickers: new Set(),
    fxRate: 0.8,
    closeTrade: r.closeTrade,
    alert: r.alert,
  });
  assert.deepEqual(result, { status: "reconciled", closed: 1 });
  assert.deepEqual(r.closed, [
    {
      tradeId: "trade-VRT_US_EQ",
      pnl: (90 - 100) * 2 * 0.8,
      exitPrice: 90,
      status: "closed-estimated",
    },
  ]);
  assert.deepEqual(r.alerts, []);
});

test("reconcileOrphans: when pending orders could not be read it closes nothing and alerts", async () => {
  const r = recorder();
  const result = await reconcileOrphans({
    openBuys: [openBuy("GE_US_EQ"), openBuy("VRT_US_EQ")],
    rawPositions: [position(CORE_TICKER), position("GE_US_EQ")],
    pendingTickers: null,
    fxRate: 0.8,
    closeTrade: r.closeTrade,
    alert: r.alert,
  });
  assert.equal(result.status, "refused");
  assert.equal(r.closed.length, 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /pending orders could not be read/);
});

test("loadExitScope: a failed pending-orders read still returns the positions exits need", async (t) => {
  t.mock.method(console, "warn", () => {});
  const scope = await loadExitScope(
    {
      getPortfolio: async () => [position(CORE_TICKER), position("GE_US_EQ")],
      getPendingOrders: async () => {
        throw new Error("Trading 212 API error 503");
      },
    },
    { openBuys: async () => [openBuy("GE_US_EQ")] },
    "live",
  );
  assert.equal(scope.pendingTickers, null);
  assert.deepEqual(
    scope.positions.map((p) => p.ticker),
    ["GE_US_EQ"],
  );
  assert.deepEqual(
    scope.openBuys.map((b) => b.ticker),
    ["GE_US_EQ"],
  );
});
