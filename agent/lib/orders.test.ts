import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import { T212Error, type CashBalance, type T212Position, type T212Order } from "./t212.ts";
import { etDateString } from "./clock.ts";

function cash(free: number): CashBalance {
  return { total: free, free, blocked: 0, invested: 0, pieCash: 0, result: 0, ppl: 0 };
}

// Fake client implementing only the methods the executor uses.
function fakeClient(over: {
  free?: number;
  positions?: T212Position[];
  pending?: T212Order[];
  // Reject any order whose quantity has more than this many decimals with T212's
  // "invalid quantity precision N" error (simulates the per-instrument precision cap).
  precisionCap?: number;
} = {}): { client: OrderExecClient; placed: { ticker: string; quantity: number }[] } {
  const placed: { ticker: string; quantity: number }[] = [];
  const decimals = (n: number) => (String(Math.abs(n)).split(".")[1] ?? "").length;
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
      if (over.precisionCap !== undefined && decimals(input.quantity) > over.precisionCap) {
        throw new Error(
          `Trading 212 API error 400: {"code":"invalid quantity precision ${over.precisionCap}"}`,
        );
      }
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
    resolvePrice: async () => 100,
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
    resolvePrice: async () => 100,
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
  const { client, placed } = fakeClient(); // equity 10000 => max trade 3000 (30%)
  const res = await evaluateAndExecute([buy(3500)], {
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

test("precision: retries at the broker's allowed decimals and places", async () => {
  const { client, placed } = fakeClient({ precisionCap: 2 }); // instrument allows 2 dp
  // £1000 / $7 = 142.857142… shares (6dp) → first attempt rejected → retry at 2dp.
  const res = await evaluateAndExecute([buy(1000, 7)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 7,
  });
  assert.equal(placed.length, 1); // only the successful (retried) order landed
  assert.equal(placed[0].quantity, 142.85); // truncated DOWN to 2dp
  assert.equal(res.placed[0].dryRun, false);
  assert.ok(res.placed[0].order);
});

test("precision: skips (not blind-fires) when qty rounds to 0 at whole-shares-only", async () => {
  // $100 share, £30 notional -> 0.3 shares; instrument is whole-shares-only (0 dp) -> 0.
  const { client, placed } = fakeClient({ precisionCap: 0 });
  const res = await evaluateAndExecute([buy(300, 1000)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 1000,
  });
  assert.equal(placed.length, 0); // nothing sent
  assert.equal(res.placed.length, 1);
  assert.match(res.placed[0].skipped ?? "", /rounds to 0/i);
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
    resolvePrice: async () => 100,
  });
  assert.equal(res.placed.length, 0);
  assert.match(res.rejected[0].reason, /halted/i);
  assert.equal(placed.length, 0);
});

test("BUY is sized from the server price, not the model's price", async () => {
  const { client, placed } = fakeClient();
  // Model says $100, server says $102 (within 5% tolerance) -> size from $102.
  const res = await evaluateAndExecute([buy(510, 100)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 102,
  });
  assert.equal(res.rejected.length, 0);
  assert.equal(placed.length, 1);
  // £510 / $102 = 5 shares (NOT £510 / $100 = 5.1)
  assert.equal(placed[0].quantity, 5);
});

test("BUY rejected when model price deviates >5% from server price", async () => {
  const { client, placed } = fakeClient();
  // Model says $80, server says $100 -> 20% deviation, well past the 5% tolerance.
  const res = await evaluateAndExecute([buy(500, 80)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  assert.equal(res.placed.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /price mismatch/i);
  assert.equal(placed.length, 0);
});

test("order intent: first real placement records an intent marker, keyed by ET-date:ticker:side:notional", async () => {
  const { client, placed } = fakeClient();
  const recorded: string[] = [];
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async () => false,
    recordOrderIntent: async (key) => {
      recorded.push(key);
    },
  });
  assert.equal(placed.length, 1);
  assert.equal(res.placed[0].dryRun, false);
  assert.deepEqual(recorded, [`${etDateString(new Date())}:AAPL_US_EQ:BUY:500`]);
});

test("order intent: a second run with the same intent key already recorded skips without placing", async () => {
  const { client, placed } = fakeClient();
  const recorded: string[] = [];
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async () => true,
    recordOrderIntent: async (key) => {
      recorded.push(key);
    },
  });
  assert.equal(placed.length, 0);
  assert.equal(res.placed.length, 1);
  assert.match(res.placed[0].skipped ?? "", /duplicate: order intent already recorded/i);
  assert.deepEqual(recorded, []);
});

test("order intent: dry-run never records an intent marker", async () => {
  const { client, placed } = fakeClient();
  const recorded: string[] = [];
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: true,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async () => false,
    recordOrderIntent: async (key) => {
      recorded.push(key);
    },
  });
  assert.equal(res.placed[0].dryRun, true);
  assert.equal(placed.length, 0);
  assert.deepEqual(recorded, []);
});

test("BUY rejected fail-closed when resolvePrice throws", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => {
      throw new Error("quote fetch failed");
    },
  });
  assert.equal(res.placed.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /could not fetch live price/i);
  assert.equal(placed.length, 0);
});

test("T212 per-order rejection: skipped with the rejection reason, not thrown", async () => {
  const { client } = fakeClient();
  const rejecting: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw new T212Error(
        400,
        '{"type":"/api-errors/min-opened-position-exceeded","title":"Error while placing the order","status":400,"detail":"must have opened position at least 1.00"}',
      );
    },
  };
  const res = await evaluateAndExecute([buy(500)], {
    client: rejecting,
    fxRate: 1,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  assert.equal(res.placed.length, 1);
  assert.match(res.placed[0].skipped ?? "", /T212 rejected/i);
  assert.match(res.placed[0].skipped ?? "", /must have opened position/i);
});

test("T212 per-order rejection: one bad order doesn't abort the rest of the batch", async () => {
  const { client, placed } = fakeClient();
  const mixed: OrderExecClient = {
    ...client,
    async placeMarketOrder(input) {
      if (input.ticker === "MSFT_US_EQ") {
        throw new T212Error(
          400,
          '{"type":"/api-errors/min-opened-position-exceeded","title":"Error while placing the order","status":400,"detail":"must have opened position at least 1.00"}',
        );
      }
      placed.push(input);
      return { id: 1, ticker: input.ticker, quantity: input.quantity } as T212Order;
    },
  };
  const res = await evaluateAndExecute(
    [buy(500), { ticker: "MSFT_US_EQ", side: "BUY", notional: 500, price: 100, thesis: "t" }],
    {
      client: mixed,
      fxRate: 1,
      dryRun: false,
      resolveRiskState: async () => noState,
      resolvePrice: async () => 100,
    },
  );
  assert.equal(res.placed.length, 2);
  assert.equal(placed.length, 1); // only the good order actually landed
  const good = res.placed.find((p) => p.proposal.ticker === "AAPL_US_EQ");
  const bad = res.placed.find((p) => p.proposal.ticker === "MSFT_US_EQ");
  assert.ok(good && !good.skipped && good.order);
  assert.match(bad?.skipped ?? "", /T212 rejected/i);
});

test("non-T212 / 5xx errors still throw: infra failures aren't swallowed as skips", async () => {
  const { client } = fakeClient();
  const failing: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw new T212Error(500, "internal server error");
    },
  };
  await assert.rejects(
    evaluateAndExecute([buy(500)], {
      client: failing,
      fxRate: 1,
      dryRun: false,
      resolveRiskState: async () => noState,
      resolvePrice: async () => 100,
    }),
  );
});

test("the top-of-cycle risk gate reads force-fresh cash and positions", async () => {
  const seen: { cash: boolean; portfolio: boolean }[] = [];
  const { client: base } = fakeClient();
  const client: OrderExecClient = {
    ...base,
    async getCash(opts) {
      seen.push({ cash: opts?.fresh === true, portfolio: false });
      return base.getCash();
    },
    async getPortfolio(opts) {
      seen.push({ cash: false, portfolio: opts?.fresh === true });
      return base.getPortfolio();
    },
  };
  await evaluateAndExecute([buy(500)], {
    client,
    fxRate: 1,
    dryRun: true,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  assert.ok(seen.some((s) => s.cash));
  assert.ok(seen.some((s) => s.portfolio));
});
