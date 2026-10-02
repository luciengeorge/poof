import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import { T212Error, type CashBalance, type T212Position, type T212Order } from "./t212.ts";
import { etDateString } from "./clock.ts";
import { DEFAULT_LIMITS } from "./risk.ts";
import type { TradeRecord } from "./memory.ts";
import { submitOrders } from "../tools/submit_orders.ts";
import { exitIntentKey } from "../tools/manage_positions.ts";

// Order-mechanics tests size at 5% of a 10,000 equity. The live floor is a sizing POLICY
// (pinned in risk.test.ts); these tests are about execution, so they state their own limits.
const TEST_LIMITS = { ...DEFAULT_LIMITS, minTradePct: 0.02, maxConcurrentPositions: 10 };

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
    async getBrokerSnapshot() {
      return {
        cash: cash(over.free ?? 10000),
        positions: over.positions ?? [],
        takenAt: 0,
        cashReadAt: 0,
        positionsReadAt: 0,
      };
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
const FX = { rate: 1, source: "live" } as const;

function buy(notional: number, price = 100): Proposal {
  return { ticker: "AAPL_US_EQ", side: "BUY", notional, price, thesis: "t" };
}

test("dry-run: accepted proposal is reported but not sent to T212", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fx: FX,
    dryRun: true,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    { client, fx: FX, dryRun: false, resolveRiskState: async () => noState },
  );
  assert.equal(res.placed.length, 1);
  assert.equal(placed[0].quantity, -3);
});

test("risk gate rejects an oversize trade (not placed)", async () => {
  const { client, placed } = fakeClient(); // equity 10000 => max trade 3000 (30%)
  const res = await evaluateAndExecute([buy(3500)], {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => ({ ...noState, dayPnl: -700 }), // -7% of 10000 > 6% cap
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
    fx: FX,
    dryRun: true,
    limits: TEST_LIMITS,
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

// A durable intent store shared across runs, the way Convex is shared across a re-fired step.
function intentStore() {
  const keys = new Set<string>();
  return {
    keys,
    hasOrderIntent: async (key: string) => keys.has(key),
    recordOrderIntent: async (key: string) => {
      keys.add(key);
    },
  };
}

const MIN_POSITION_REJECTION = new T212Error(
  400,
  '{"type":"/api-errors/min-opened-position-exceeded","title":"Error while placing the order","status":400,"detail":"must have opened position at least 1.00"}',
);

test("order intent: a BUY's marker is written BEFORE the order is sent, not after", async () => {
  // Ordering, not presence: a process killed between the broker accepting the order and the
  // marker landing must still leave the marker, or a re-run places the trade twice.
  const events: string[] = [];
  const { client } = fakeClient();
  const logging: OrderExecClient = {
    ...client,
    async placeMarketOrder(input) {
      events.push(`place:${input.ticker}`);
      return client.placeMarketOrder(input);
    },
  };
  await evaluateAndExecute([buy(500)], {
    client: logging,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async () => false,
    recordOrderIntent: async (key) => {
      events.push(`intent:${key}`);
    },
  });
  assert.deepEqual(events, [
    `intent:${etDateString(new Date())}:AAPL_US_EQ:BUY:500`,
    "place:AAPL_US_EQ",
  ]);
});

test("order intent: a failed BUY still blocks a same-day retry (the accepted trade-off)", async () => {
  // Writing the marker first can only over-block: a BUY the broker refused keeps its marker,
  // so the same order cannot be retried until the next ET day. That is deliberate. The other
  // way round fails by placing a duplicate position on a real account.
  const store = intentStore();
  const { client } = fakeClient();
  const refusing: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw MIN_POSITION_REJECTION;
    },
  };
  const opts = {
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: store.hasOrderIntent,
    recordOrderIntent: store.recordOrderIntent,
  };
  const first = await evaluateAndExecute([buy(500)], { ...opts, client: refusing });
  assert.match(first.placed[0].skipped ?? "", /T212 rejected/);
  assert.deepEqual([...store.keys], [`${etDateString(new Date())}:AAPL_US_EQ:BUY:500`]);

  const { client: working, placed } = fakeClient();
  const retry = await evaluateAndExecute([buy(500)], { ...opts, client: working });
  assert.equal(placed.length, 0);
  assert.match(retry.placed[0].skipped ?? "", /duplicate: order intent already recorded/);
});

function proposal(ticker: string): Proposal {
  return { ticker, side: "BUY", notional: 500, price: 100, thesis: "t" };
}

// Fills AAPL, then the connection drops on MSFT. Records every ticker it was asked to place.
function failsOnSecondOrder(): { client: OrderExecClient; attempted: string[] } {
  const attempted: string[] = [];
  const { client } = fakeClient();
  return {
    attempted,
    client: {
      ...client,
      async placeMarketOrder(input) {
        attempted.push(input.ticker);
        if (input.ticker === "MSFT_US_EQ") throw new Error("fetch failed");
        return { id: attempted.length, ticker: input.ticker, quantity: input.quantity } as T212Order;
      },
    },
  };
}

const THREE_BUYS = [proposal("AAPL_US_EQ"), proposal("MSFT_US_EQ"), proposal("NVDA_US_EQ")];

test("a throw mid-batch keeps the order already filled and stops the batch", async () => {
  const { client, attempted } = failsOnSecondOrder();
  const res = await evaluateAndExecute(THREE_BUYS, {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  // The filled order is still reported, so the caller can book it.
  assert.equal(res.placed.length, 1);
  assert.equal(res.placed[0].proposal.ticker, "AAPL_US_EQ");
  assert.ok(res.placed[0].order && !res.placed[0].skipped);
  // The throwing order is surfaced, and nothing is tried after an infra failure.
  assert.deepEqual(attempted, ["AAPL_US_EQ", "MSFT_US_EQ"]);
  assert.deepEqual(
    res.rejected.map((r) => [r.proposal.ticker, r.reason]),
    [
      ["MSFT_US_EQ", "outcome unknown: broker error: fetch failed"],
      ["NVDA_US_EQ", "not placed: batch stopped after a broker error on MSFT_US_EQ"],
    ],
  );
});

test("a throw from the send is reported as outcome unknown, a throw before it as not placed", async () => {
  // The broker may have accepted an order whose send threw, so "not placed" would be a false
  // claim in the cycle report. A throw before the send is a known non-placement.
  const { client: base } = fakeClient();
  const dropping: OrderExecClient = {
    ...base,
    async placeMarketOrder() {
      throw new Error("socket hang up");
    },
  };
  const opts = {
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  };
  const sendThrew = await evaluateAndExecute([buy(500)], { ...opts, client: dropping });
  assert.deepEqual(
    sendThrew.rejected.map((r) => r.reason),
    ["outcome unknown: broker error: socket hang up"],
  );

  const { client, placed } = fakeClient();
  const keyThrew = await evaluateAndExecute([buy(500)], {
    ...opts,
    client,
    intentKeyOf: () => {
      throw new Error("bad key");
    },
  });
  assert.equal(placed.length, 0);
  assert.deepEqual(
    keyThrew.rejected.map((r) => r.reason),
    ["not placed: broker error: bad key"],
  );
});

test("submit_orders books the filled order in trades when a later order throws", async () => {
  // The invariant end to end: anything the broker accepted reaches recordTrade.
  const { client } = failsOnSecondOrder();
  const trades: TradeRecord[] = [];
  const res = await submitOrders(THREE_BUYS, {
    client,
    memory: {
      listExternalHoldings: async () => [],
      hasOrderIntent: async () => false,
      recordOrderIntent: async () => {},
      recordTrade: async (t) => {
        trades.push(t);
      },
      recordCoreOrder: async () => {},
    },
    env: "live",
    fx: FX,
    dryRun: false,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    limits: TEST_LIMITS,
    jev: null,
  });
  assert.deepEqual(
    trades.map((t) => [t.ticker, t.status]),
    [["AAPL_US_EQ", "placed"]],
  );
  assert.match(
    res.rejected.find((r) => r.proposal.ticker === "MSFT_US_EQ")?.reason ?? "",
    /^outcome unknown: broker error: /,
  );
});

test("manage_positions passes the intent guard and its exit key to the executor (structural)", () => {
  // The executor guards on `if (hasOrderIntent && ...)`, so a caller that omits the callbacks
  // gets no guard and no error. Unit tests on the executor stay green with the wiring missing;
  // only the tool's source can show it is there.
  const src = readFileSync(new URL("../tools/manage_positions.ts", import.meta.url), "utf8");
  const call = /evaluateAndExecute\(proposals, \{([\s\S]*?)\n\s*\}\)/.exec(src)?.[1] ?? "";
  assert.ok(call, "manage_positions must call evaluateAndExecute(proposals, { ... })");
  assert.match(
    call,
    /hasOrderIntent: \(key\) => memory\.hasOrderIntent\(tradingEnv\(\), key\)/,
    "exits must check the durable intent marker",
  );
  assert.match(
    call,
    /recordOrderIntent: async \(key\) => \{\s*await memory\.recordOrderIntent\(tradingEnv\(\), key\);/,
    "exits must record the durable intent marker",
  );
  assert.match(
    call,
    /intentKeyOf: exitIntentKey/,
    "exits must use a key that ignores the live-priced notional, or the guard can never match",
  );
});

function held(ticker: string, quantity: number): T212Position {
  return {
    ticker,
    quantity,
    averagePrice: 100,
    currentPrice: 100,
    ppl: 0,
    maxBuy: 0,
    maxSell: quantity,
    pieQuantity: 0,
  };
}

function exit(ticker: string, notional: number): Proposal {
  return { ticker, side: "SELL", notional, price: 100, thesis: "exit: stop-loss" };
}

test("exit intent: a second exit for the same ticker on the same day is suppressed, even at a new notional", async () => {
  // An exit's notional is the live market value, so it moves between runs. The exit key leaves it
  // out: one exit per ticker per ET day. A different ticker is still free to exit.
  const store = intentStore();
  const run = async (proposals: Proposal[]) => {
    const { client, placed } = fakeClient({
      positions: [held("AAPL_US_EQ", 10), held("MSFT_US_EQ", 10)],
    });
    const res = await evaluateAndExecute(proposals, {
      client,
      fx: FX,
      dryRun: false,
      resolveRiskState: async () => noState,
      hasOrderIntent: store.hasOrderIntent,
      recordOrderIntent: store.recordOrderIntent,
      intentKeyOf: exitIntentKey,
    });
    return { res, placed };
  };

  const first = await run([exit("AAPL_US_EQ", 300)]);
  assert.deepEqual(first.placed, [{ ticker: "AAPL_US_EQ", quantity: -3 }]);
  assert.deepEqual([...store.keys], [`${etDateString(new Date())}:AAPL_US_EQ:EXIT`]);

  const second = await run([exit("AAPL_US_EQ", 310), exit("MSFT_US_EQ", 200)]);
  assert.deepEqual(second.placed, [{ ticker: "MSFT_US_EQ", quantity: -2 }]);
  const aapl = second.res.placed.find((p) => p.proposal.ticker === "AAPL_US_EQ");
  assert.match(aapl?.skipped ?? "", /duplicate: order intent already recorded/);
});

const EXIT_OPTS = {
  fx: FX,
  dryRun: false,
  resolveRiskState: async () => noState,
  intentKeyOf: exitIntentKey,
};

test("exit intent: a SELL the broker refuses records no marker, so a same-day retry sends it", async () => {
  // A marker written before the send would turn this refusal into a "duplicate" on the agent's
  // next manage_positions call, and the stop-loss would never go out that day.
  const store = intentStore();
  const { client } = fakeClient({ positions: [held("AAPL_US_EQ", 10)] });
  const refusing: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw MIN_POSITION_REJECTION;
    },
  };
  const first = await evaluateAndExecute([exit("AAPL_US_EQ", 300)], {
    ...EXIT_OPTS,
    hasOrderIntent: store.hasOrderIntent,
    recordOrderIntent: store.recordOrderIntent,
    client: refusing,
  });
  assert.match(first.placed[0].skipped ?? "", /T212 rejected/);
  assert.deepEqual([...store.keys], []);

  const { client: working, placed } = fakeClient({ positions: [held("AAPL_US_EQ", 10)] });
  const retry = await evaluateAndExecute([exit("AAPL_US_EQ", 300)], {
    ...EXIT_OPTS,
    hasOrderIntent: store.hasOrderIntent,
    recordOrderIntent: store.recordOrderIntent,
    client: working,
  });
  assert.deepEqual(placed, [{ ticker: "AAPL_US_EQ", quantity: -3 }]);
  assert.ok(retry.placed[0].order && !retry.placed[0].skipped);
  assert.deepEqual([...store.keys], [`${etDateString(new Date())}:AAPL_US_EQ:EXIT`]);
});

test("exit intent: a SELL whose send throws records no marker", async () => {
  const store = intentStore();
  const { client } = fakeClient({ positions: [held("AAPL_US_EQ", 10)] });
  const dropping: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw new Error("fetch failed");
    },
  };
  const res = await evaluateAndExecute([exit("AAPL_US_EQ", 300)], {
    ...EXIT_OPTS,
    hasOrderIntent: store.hasOrderIntent,
    recordOrderIntent: store.recordOrderIntent,
    client: dropping,
  });
  assert.deepEqual(
    res.rejected.map((r) => r.reason),
    ["outcome unknown: broker error: fetch failed"],
  );
  assert.deepEqual([...store.keys], []);
});

test("exit intent: a placed SELL records its marker AFTER the order is sent", async () => {
  const events: string[] = [];
  const { client } = fakeClient({ positions: [held("AAPL_US_EQ", 10)] });
  const logging: OrderExecClient = {
    ...client,
    async placeMarketOrder(input) {
      events.push(`place:${input.ticker}`);
      return client.placeMarketOrder(input);
    },
  };
  await evaluateAndExecute([exit("AAPL_US_EQ", 300)], {
    ...EXIT_OPTS,
    client: logging,
    hasOrderIntent: async () => false,
    recordOrderIntent: async (key) => {
      events.push(`intent:${key}`);
    },
  });
  assert.deepEqual(events, [
    "place:AAPL_US_EQ",
    `intent:${etDateString(new Date())}:AAPL_US_EQ:EXIT`,
  ]);
});

// Convex's argument validator prints the whole argument object, token included, into its error.
const CONVEX_TOKEN_ERROR = 'ArgumentValidationError: {token: "s3cr3t-shared-value", env: "live"}';

test("intent guard: a BUY whose marker cannot be saved is not sent, and the batch carries on", async () => {
  // Fail closed for BUYs: a duplicate BUY is the hazard the guard exists for, and a refused BUY
  // just waits a cycle.
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([proposal("AAPL_US_EQ"), proposal("MSFT_US_EQ")], {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async () => false,
    recordOrderIntent: async (key) => {
      if (key.includes(":AAPL_US_EQ:")) throw new Error(CONVEX_TOKEN_ERROR);
    },
  });
  assert.deepEqual(
    placed.map((o) => o.ticker),
    ["MSFT_US_EQ"],
  );
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].proposal.ticker, "AAPL_US_EQ");
  assert.match(res.rejected[0].reason, /^not placed: duplicate guard unavailable: /);
  assert.doesNotMatch(res.rejected[0].reason, /s3cr3t-shared-value/);
});

test("intent guard: a BUY whose marker cannot be read is not sent, and the batch carries on", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([proposal("AAPL_US_EQ"), proposal("MSFT_US_EQ")], {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
    hasOrderIntent: async (key) => {
      if (key.includes(":AAPL_US_EQ:")) throw new Error(CONVEX_TOKEN_ERROR);
      return false;
    },
    recordOrderIntent: async () => {},
  });
  assert.deepEqual(
    placed.map((o) => o.ticker),
    ["MSFT_US_EQ"],
  );
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].proposal.ticker, "AAPL_US_EQ");
  assert.match(res.rejected[0].reason, /^not placed: duplicate guard unavailable: /);
  assert.doesNotMatch(res.rejected[0].reason, /s3cr3t-shared-value/);
  assert.match(res.rejected[0].reason, /\[REDACTED\]/);
});

test("intent guard: a SELL whose marker cannot be saved after the sale is still reported placed", async (t) => {
  // Fail open for SELLs: an ISA cannot short and Trading 212 rejects selling shares not held, so
  // a duplicate SELL cannot oversell, while a blocked stop-loss is the worse failure. The sale
  // already happened, so the failed write is logged, redacted, and changes nothing.
  const warn = t.mock.method(console, "warn", () => {});
  const { client, placed } = fakeClient({ positions: [held("AAPL_US_EQ", 10)] });
  const res = await evaluateAndExecute([exit("AAPL_US_EQ", 300)], {
    client,
    fx: FX,
    dryRun: false,
    resolveRiskState: async () => noState,
    hasOrderIntent: async () => false,
    recordOrderIntent: async () => {
      throw new Error(CONVEX_TOKEN_ERROR);
    },
  });
  assert.deepEqual(placed, [{ ticker: "AAPL_US_EQ", quantity: -3 }]);
  assert.deepEqual(res.rejected, []);
  assert.equal(res.placed.length, 1);
  assert.ok(res.placed[0].order && !res.placed[0].skipped);
  const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /intent write failed for SELL AAPL_US_EQ after it was placed/);
  assert.doesNotMatch(logged, /s3cr3t-shared-value/);
});

test("intent guard: a SELL whose marker cannot be read is still sent, and later orders still run", async () => {
  const { client, placed } = fakeClient({
    positions: [held("AAPL_US_EQ", 10), held("MSFT_US_EQ", 10)],
  });
  const res = await evaluateAndExecute([exit("AAPL_US_EQ", 300), exit("MSFT_US_EQ", 200)], {
    client,
    fx: FX,
    dryRun: false,
    resolveRiskState: async () => noState,
    hasOrderIntent: async () => {
      throw new Error(CONVEX_TOKEN_ERROR);
    },
    recordOrderIntent: async () => {},
  });
  assert.deepEqual(placed, [
    { ticker: "AAPL_US_EQ", quantity: -3 },
    { ticker: "MSFT_US_EQ", quantity: -2 },
  ]);
  assert.deepEqual(res.rejected, []);
});

test("BUY rejected fail-closed when resolvePrice throws", async () => {
  const { client, placed } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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

test("a price-fetch failure has the Finnhub key redacted from its rejected reason", async () => {
  // Finnhub takes its key as `?token=`, so a fetch error that echoes the URL carries it.
  const { client } = fakeClient();
  const res = await evaluateAndExecute([buy(500)], {
    client,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => {
      throw new Error("GET https://finnhub.io/api/v1/quote?token=FAKE123&symbol=AAPL failed: 503");
    },
  });
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /^could not fetch live price for AAPL_US_EQ: /);
  assert.doesNotMatch(res.rejected[0].reason, /FAKE123/);
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
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
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
      fx: FX,
      dryRun: false,
      limits: TEST_LIMITS,
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

test("non-T212 / 5xx errors are reported as broker errors: infra failures aren't swallowed as skips", async () => {
  const { client } = fakeClient();
  const failing: OrderExecClient = {
    ...client,
    async placeMarketOrder() {
      throw new T212Error(500, "internal server error");
    },
  };
  const res = await evaluateAndExecute([buy(500)], {
    client: failing,
    fx: FX,
    dryRun: false,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  assert.equal(res.placed.length, 0);
  assert.deepEqual(
    res.rejected.map((r) => r.reason),
    ["outcome unknown: broker error: Trading 212 API error 500: internal server error"],
  );
});

test("the top-of-cycle risk gate forces a fresh broker snapshot", async () => {
  const seen: boolean[] = [];
  const { client: base } = fakeClient();
  const client: OrderExecClient = {
    ...base,
    async getBrokerSnapshot(opts) {
      seen.push(opts?.fresh === true);
      return base.getBrokerSnapshot();
    },
  };
  await evaluateAndExecute([buy(500)], {
    client,
    fx: FX,
    dryRun: true,
    limits: TEST_LIMITS,
    resolveRiskState: async () => noState,
    resolvePrice: async () => 100,
  });
  assert.deepEqual(seen, [true]);
});
