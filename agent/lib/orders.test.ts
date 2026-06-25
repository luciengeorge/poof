import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import type { CashBalance, T212Position, T212Order } from "./t212.ts";

function cash(free: number): CashBalance {
  return { total: free, free, blocked: 0, invested: 0, pieCash: 0, result: 0, ppl: 0 };
}

// Fake client implementing only the methods the executor uses.
function fakeClient(over: {
  free?: number;
  positions?: T212Position[];
  pending?: T212Order[];
} = {}): { client: OrderExecClient; placed: { ticker: string; quantity: number }[] } {
  const placed: { ticker: string; quantity: number }[] = [];
  const client: OrderExecClient = {
    async getCash() {
      return cash(over.free ?? 10000);
    },
    async getPortfolio() {
      return over.positions ?? [];
    },
    async getPendingOrders() {
      return over.pending ?? [];
    },
    async placeMarketOrder(input) {
      placed.push(input);
      return { id: 1, ticker: input.ticker, quantity: input.quantity } as T212Order;
    },
  };
  return { client, placed };
}

const noState = {
  peakEquity: 0,
  dayPnl: 0,
  newPositionsToday: 0,
  consecutiveLossDays: 0,
};

function buy(notional: number, price = 100): Proposal {
  return { ticker: "AAPL_US_EQ", side: "BUY", notional, price, thesis: "t" };
}

test("dry-run: accepted proposal is reported but not sent to T212", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: true,
    resolveRiskState: async () => noState,
  });
  assert.equal(res.placed.length, 1);
  assert.equal(res.placed[0].dryRun, true);
  assert.equal(res.placed[0].quantity, 5); // £500 / ($100 * fx 1) = 5 shares
  assert.equal(placed.length, 0); // nothing actually sent
});

test("live: accepted proposal is sent with signed share quantity", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
  });
  assert.equal(res.placed[0].dryRun, false);
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0], { ticker: "AAPL_US_EQ", quantity: 5 });
});

test("live SELL sends a negative quantity", async () => {
  const { client, placed } = fakeClient({
    positions: [
      {
        ticker: "AAPL_US_EQ",
        quantity: 10,
        averagePrice: 100,
        currentPrice: 100,
        ppl: 0,
        maxBuy: 0,
        maxSell: 10,
        pieQuantity: 0,
      },
    ],
  });
  const res = await evaluateAndExecute(
    [{ ticker: "AAPL_US_EQ", side: "SELL", notional: 300, price: 100, thesis: "t" }],
    { client, fxRate: 1, dryRun: false, resolveRiskState: async () => noState },
  );
  assert.equal(res.placed.length, 1);
  assert.equal(placed[0].quantity, -3);
});

test("risk gate rejects an oversize trade (not placed)", async () => {
  const { client, placed } = fakeClient(); // equity 10000 => max trade 800
  const res = await evaluateAndExecute([buy(900)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
  });
  assert.equal(res.placed.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /trade size/i);
  assert.equal(placed.length, 0);
});

test("reconciliation: skips a ticker that already has a pending order", async () => {
  const { client, placed } = fakeClient({
    pending: [{ id: 9, ticker: "AAPL_US_EQ", quantity: 5 } as T212Order],
  });
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
  });
  assert.equal(res.placed.length, 1);
  assert.match(res.placed[0].skipped ?? "", /pending/i);
  assert.equal(placed.length, 0); // not re-sent
});

test("halt: a tripped daily-loss state rejects everything", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => ({ ...noState, dayPnl: -500 }), // -5% of 10000 > 4% cap
  });
  assert.equal(res.placed.length, 0);
  assert.match(res.rejected[0].reason, /halted/i);
  assert.equal(placed.length, 0);
});
