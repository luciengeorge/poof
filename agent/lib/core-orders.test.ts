import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CORE_FLOOR_QUANTITY, CORE_TICKER, isCore, sweepQuantity } from "./core.ts";
import { coreFundingKey, coreOrderRecord, fundFromCore, sweepCore } from "./core-orders.ts";
import { brokerSnapshotWithFx, buildRiskSnapshot } from "./execution.ts";
import { checkHalt, DEFAULT_LIMITS } from "./risk.ts";
import type { OrderExecClient } from "./orders.ts";
import type { CashBalance, T212Order, T212Position } from "./t212.ts";
import type { CoreOrderRecord, TradeRecord } from "./memory.ts";
import { CORE_PROPOSAL_REASON, submitOrders } from "../tools/submit_orders.ts";

const NOW = new Date(Date.UTC(2026, 8, 30, 15, 35));
const FX = { rate: 0.755, source: "live" } as const;

function cash(total: number, free: number): CashBalance {
  return { total, free, blocked: 0, invested: 0, pieCash: 0, result: 0, ppl: 0 };
}

function position(ticker: string, quantity: number, currentPrice: number): T212Position {
  return {
    ticker,
    quantity,
    averagePrice: currentPrice,
    currentPrice,
    ppl: 0,
    maxBuy: 0,
    maxSell: quantity,
    pieQuantity: 0,
  };
}

interface Account {
  total: number;
  free: number;
  positions: T212Position[];
  pending?: T212Order[];
}

// Fake client in the orders.test.ts style: plain object, records what it was sent. `account` is
// read on every call, so a test can change it between steps (a fill, a deposit).
function fakeClient(account: Account): {
  client: OrderExecClient;
  sent: { ticker: string; quantity: number }[];
} {
  const sent: { ticker: string; quantity: number }[] = [];
  const client: OrderExecClient = {
    async getBrokerSnapshot() {
      return {
        cash: cash(account.total, account.free),
        positions: account.positions,
        takenAt: 0,
        cashReadAt: 0,
        positionsReadAt: 0,
      };
    },
    async getPendingOrders() {
      return account.pending ?? [];
    },
    async placeMarketOrder(input) {
      sent.push(input);
      return { id: sent.length, ticker: input.ticker, quantity: input.quantity };
    },
  };
  return { client, sent };
}

function intents(initial: string[] = []) {
  const keys = new Set(initial);
  return {
    keys,
    hasOrderIntent: async (key: string) => keys.has(key),
    recordOrderIntent: async (key: string) => {
      keys.add(key);
    },
  };
}

// 1000 GBP account: 530 free cash, 4 core shares at 95.50 GBP, the rest in a stock.
function idleCashAccount(): Account {
  return { total: 1000, free: 530, positions: [position(CORE_TICKER, 4, 95.5)] };
}

test("the sweep sizes from the broker's core price at rate 1, not the USD rate", async () => {
  const { client, sent } = fakeClient(idleCashAccount());
  const result = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...intents() });
  const expected = sweepQuantity({
    freeCash: 530,
    equity: 1000,
    corePrice: 95.5,
    precision: 6,
    reservedForStocks: 0,
  });
  assert.ok(Math.abs(expected - 5.183764) < 1e-6, `500 GBP excess at 95.50 GBP, got ${expected}`);
  assert.deepEqual(sent, [{ ticker: CORE_TICKER, quantity: expected }]);
  assert.equal(result.status, "placed");
  assert.equal(result.priceGbp, 95.5);
  assert.match(result.detail, /swept £495\.05 of idle cash into the index core/);
});

test("no second sweep while a core order is still pending", async () => {
  const account = idleCashAccount();
  account.pending = [{ id: 7, ticker: CORE_TICKER, quantity: 5 }];
  const { client, sent } = fakeClient(account);
  const result = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...intents() });
  assert.equal(result.status, "pending");
  assert.deepEqual(sent, []);
});

test("a cycle that raised funds does not sweep them back, even once the sale has filled", async () => {
  // 30 GBP free, 900 GBP of core: a 150 GBP stock buy is short by 120.
  const account: Account = { total: 1000, free: 30, positions: [position(CORE_TICKER, 9, 100)] };
  const { client, sent } = fakeClient(account);
  const store = intents();
  const funded = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    ...store,
  });
  assert.equal(funded.status, "placed");
  assert.ok(store.keys.has(coreFundingKey(NOW, false)), "the sale leaves its marker");

  // Winter: London is open, so the sale fills at once and its proceeds show as free cash.
  account.free = 30 + 151.52;
  account.positions = [position(CORE_TICKER, 9 - 1.515151, 100)];
  const swept = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...store });
  assert.equal(swept.status, "funds-raised");
  assert.equal(sent.length, 1, "only the funding sale was sent");
  assert.ok(sent[0].quantity < 0);
});

test("funding sells the shortfall plus the buffer and says the stock waits a cycle", async () => {
  const { client, sent } = fakeClient({
    total: 1000,
    free: 30,
    positions: [position(CORE_TICKER, 9, 100)],
  });
  const result = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    ...intents(),
  });
  // 120 short + 30 buffer = 150 GBP, sized against 99: 1.515151 shares.
  assert.deepEqual(sent, [{ ticker: CORE_TICKER, quantity: -1.515151 }]);
  assert.match(
    result.detail,
    /^raised £151\.52 from the index core; the stock can be bought next cycle$/,
  );
});

test("funding never sells the core below the floor", async () => {
  const { client, sent } = fakeClient({
    total: 1000,
    free: 30,
    positions: [position(CORE_TICKER, 2, 100)],
  });
  const result = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 5000,
    ...intents(),
  });
  assert.equal(result.status, "placed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quantity, -(2 - CORE_FLOOR_QUANTITY));
  assert.ok(2 + sent[0].quantity >= CORE_FLOOR_QUANTITY - 1e-9, "the floor is kept");
});

test("funding a core already at the floor sells nothing", async () => {
  const { client, sent } = fakeClient({
    total: 1000,
    free: 30,
    positions: [position(CORE_TICKER, CORE_FLOOR_QUANTITY, 100)],
  });
  const result = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    ...intents(),
  });
  assert.equal(result.status, "nothing-to-do");
  assert.deepEqual(sent, []);
});

test("a second funding sale in the same cycle is refused", async () => {
  const { client, sent } = fakeClient({
    total: 1000,
    free: 30,
    positions: [position(CORE_TICKER, 9, 100)],
  });
  const result = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    ...intents([coreFundingKey(NOW, false)]),
  });
  assert.equal(result.status, "funds-raised");
  assert.deepEqual(sent, []);
});

test("a halt does not stop the sweep", async () => {
  const account = idleCashAccount();
  const { client, sent } = fakeClient(account);
  // The gate would call this account halted: a 50% drawdown and five straight loss days.
  const snapshot = buildRiskSnapshot({
    brokerSnapshot: brokerSnapshotWithFx(
      {
        cash: cash(account.total, account.free),
        positions: account.positions,
        takenAt: 0,
        cashReadAt: 0,
        positionsReadAt: 0,
      },
      FX,
    ),
    peakEquity: 2000,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 5,
  });
  assert.equal(checkHalt(snapshot, DEFAULT_LIMITS).halted, true);

  const result = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...intents() });
  assert.equal(result.status, "placed");
  assert.equal(sent.length, 1);

  // And the core path cannot even see a halt: it never touches the gate or the risk state.
  const src = readFileSync(new URL("./core-orders.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\/risk(-runtime)?\.ts"/);
  assert.doesNotMatch(src, /\b(validateOrders|checkHalt|resolveRiskState|evaluateAndExecute)\(/);
});

test("not held and not pending: 'not bootstrapped', nothing guessed and nothing sent", async () => {
  const account: Account = {
    total: 1000,
    free: 900,
    positions: [position("AAPL_US_EQ", 1, 130)],
  };
  const { client, sent } = fakeClient(account);
  const swept = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...intents() });
  const funded = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    ...intents(),
  });
  assert.equal(swept.status, "not-bootstrapped");
  assert.equal(funded.status, "not-bootstrapped");
  assert.deepEqual(sent, []);

  // A bootstrap order still in flight counts as pending, not as a reason to guess again.
  account.pending = [{ id: 1, ticker: CORE_TICKER, quantity: 0.1 }];
  const inFlight = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...intents() });
  assert.equal(inFlight.status, "pending");
  assert.deepEqual(sent, []);
});

test("dry run simulates both paths, and a simulated sale blocks only the simulated sweep", async () => {
  const account: Account = { total: 1000, free: 30, positions: [position(CORE_TICKER, 9, 100)] };
  const { client, sent } = fakeClient(account);
  const store = intents();
  const funded = await fundFromCore({
    client,
    fx: FX,
    dryRun: true,
    now: NOW,
    shortfall: 120,
    ...store,
  });
  assert.equal(funded.status, "simulated");
  assert.equal(funded.quantity, -1.515151);
  assert.match(funded.detail, /^DRY RUN: would have raised £151\.52/);
  assert.deepEqual(sent, []);

  account.free = 530;
  const drySweep = await sweepCore({ client, fx: FX, dryRun: true, now: NOW, ...store });
  assert.equal(drySweep.status, "funds-raised");
  // The dry-run marker has its own key, so it can never block a real sweep.
  const liveSweep = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, ...store });
  assert.equal(liveSweep.status, "placed");
});

test("an unreadable marker fails closed: no sweep and no sale", async () => {
  const { client, sent } = fakeClient({
    total: 1000,
    free: 530,
    positions: [position(CORE_TICKER, 9, 100)],
  });
  const down = async () => {
    throw new Error("convex unavailable");
  };
  const swept = await sweepCore({ client, fx: FX, dryRun: false, now: NOW, hasOrderIntent: down });
  const funded = await fundFromCore({
    client,
    fx: FX,
    dryRun: false,
    now: NOW,
    shortfall: 120,
    hasOrderIntent: down,
    recordOrderIntent: async () => {},
  });
  assert.equal(swept.status, "failed");
  assert.equal(funded.status, "failed");
  assert.deepEqual(sent, []);
});

test("only attempted core orders reach the audit table", () => {
  const base = { action: "sweep" as const, quantity: 0, notionalGbp: 0, dryRun: false, detail: "" };
  assert.equal(coreOrderRecord({ ...base, status: "pending" }, "live"), null);
  assert.equal(coreOrderRecord({ ...base, status: "not-bootstrapped" }, "live"), null);
  const row = coreOrderRecord(
    {
      ...base,
      status: "placed",
      quantity: 1.5,
      notionalGbp: 150,
      priceGbp: 100,
      order: { id: 42, ticker: CORE_TICKER, quantity: 1.5 },
    },
    "live",
  );
  assert.deepEqual(row, {
    env: "live",
    action: "sweep",
    status: "placed",
    quantity: 1.5,
    priceGbp: 100,
    notionalGbp: 150,
    dryRun: false,
    detail: "",
    orderId: 42,
  });
});

test("submit_orders funds a cash-short stock buy from the core, and no core order is recorded as a trade", async () => {
  // 1000 GBP: 900 in the core, one stock, 30 free. The agent sells the stock, wants a 150 GBP
  // buy, and also tries to trade the core directly, which it must not.
  const { client, sent } = fakeClient({
    total: 1000,
    free: 30,
    positions: [position(CORE_TICKER, 9, 100), position("AAA_US_EQ", 1, 92.72)],
  });
  const store = intents();
  const trades: TradeRecord[] = [];
  const coreRows: CoreOrderRecord[] = [];
  const result = await submitOrders(
    [
      { ticker: "AAA_US_EQ", side: "SELL", notional: 70, price: 92.72, thesis: "exit" },
      {
        ticker: "DDD_US_EQ",
        side: "BUY",
        notional: 150,
        price: 50,
        thesis: "t",
        maxHoldDays: 20,
      },
      { ticker: CORE_TICKER, side: "SELL", notional: 100, price: 100, thesis: "raise cash" },
      { ticker: CORE_TICKER, side: "BUY", notional: 150, price: 100, thesis: "park cash" },
    ],
    {
      client,
      memory: {
        listExternalHoldings: async () => [],
        hasOrderIntent: async (_env, key) => store.hasOrderIntent(key),
        recordOrderIntent: async (_env, key) => store.recordOrderIntent(key),
        recordTrade: async (t) => {
          trades.push(t);
        },
        recordCoreOrder: async (r) => {
          coreRows.push(r);
        },
      },
      env: "live",
      fx: FX,
      dryRun: false,
      resolveRiskState: async () => ({
        peakEquity: 1000,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
      resolvePrice: async () => 50,
      limits: DEFAULT_LIMITS,
      jev: null,
    },
  );

  // The stock buy was refused for cash only, and not retried.
  const refused = result.rejected.find((r) => r.proposal.ticker === "DDD_US_EQ");
  assert.match(refused?.reason ?? "", /insufficient cash/);
  assert.equal(result.cashShortfall, 120);
  // The funding sale went out, once; nothing else touched the core.
  assert.deepEqual(
    sent.map((o) => o.ticker),
    ["AAA_US_EQ", CORE_TICKER],
  );
  assert.equal(sent[1].quantity, -1.515151);
  assert.match(result.core?.detail ?? "", /raised £151\.52 from the index core/);
  // Direct core proposals are refused before the gate.
  const coreRefusals = result.rejected.filter((r) => isCore(r.proposal.ticker));
  assert.equal(coreRefusals.length, 2);
  assert.ok(coreRefusals.every((r) => r.reason === CORE_PROPOSAL_REASON));
  // The trades table saw the stock sale and nothing from the core; the core has its own row.
  assert.deepEqual(
    trades.map((t) => t.ticker),
    ["AAA_US_EQ"],
  );
  assert.deepEqual(
    coreRows.map((r) => [r.action, r.status]),
    [["fund", "placed"]],
  );
});

test("the tools wire the core path where it belongs (structural)", () => {
  const submit = readFileSync(new URL("../tools/submit_orders.ts", import.meta.url), "utf8");
  const gate = submit.indexOf("evaluateAndExecute(stockProposals");
  const funding = submit.indexOf("fundFromCore(");
  const recording = submit.indexOf("buildRecordTradeArgs(result.placed");
  assert.ok(gate > 0 && funding > gate, "funding runs after the gate, on its shortfall");
  assert.match(submit, /shortfall: result\.cashShortfall/);
  assert.ok(recording > funding, "trades are recorded from `placed`, which the core never joins");
  assert.match(submit, /return submitOrders\(proposals, \{/, "the tool runs the tested path");

  const record = readFileSync(new URL("../tools/record_cycle.ts", import.meta.url), "utf8");
  const logged = record.indexOf("await memory.recordCycle(");
  const sweep = record.indexOf("await sweepCore(");
  assert.ok(logged > 0 && sweep > logged, "the sweep runs after the cycle is recorded");
  assert.doesNotMatch(record, /recordTrade|buildRecordTradeArgs/, "a sweep is never a trade");
});
