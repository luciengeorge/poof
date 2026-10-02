import { test } from "node:test";
import assert from "node:assert/strict";
import { T212Client, type CashBalance, type T212Position } from "./t212.ts";
import { FAKE_CASH, FAKE_POSITIONS, fakeT212Fetch } from "./t212-fake.ts";
import { CORE_TICKER } from "./core.ts";

const BASE = "https://demo.trading212.com/api/v0";

const POSITION_NUMBERS = [
  "quantity",
  "averagePrice",
  "currentPrice",
  "ppl",
  "maxBuy",
  "maxSell",
  "pieQuantity",
] as const;

test("GET /equity/account/cash resolves 200 with a finite CashBalance that can fund a BUY", async () => {
  const res = await fakeT212Fetch()(`${BASE}/equity/account/cash`, { method: "GET" });
  assert.equal(res.status, 200);
  const cash = (await res.json()) as CashBalance;
  for (const key of ["total", "free", "blocked", "invested", "pieCash", "result", "ppl"] as const) {
    assert.ok(Number.isFinite(cash[key]), `${key} must be a finite number`);
  }
  assert.ok(cash.free > 0, "free cash must be positive so the cycle can reach submit_orders");
});

test("GET /equity/portfolio resolves 200 with US stocks plus the index core, every number finite", async () => {
  const res = await fakeT212Fetch()(`${BASE}/equity/portfolio`, { method: "GET" });
  assert.equal(res.status, 200);
  const positions = (await res.json()) as T212Position[];
  assert.ok(Array.isArray(positions));
  const stocks = positions.filter((p) => p.ticker !== CORE_TICKER);
  assert.ok(stocks.length >= 2, "at least two US stocks");
  for (const p of stocks) assert.match(p.ticker, /^[A-Z]+_US_EQ$/);
  assert.equal(positions.filter((p) => p.ticker === CORE_TICKER).length, 1);
  for (const p of positions) {
    for (const key of POSITION_NUMBERS) {
      assert.ok(Number.isFinite(p[key]), `${p.ticker}.${key} must be a finite number`);
    }
  }
});

test("GET /equity/orders resolves 200 with no pending orders", async () => {
  const res = await fakeT212Fetch()(`${BASE}/equity/orders`, { method: "GET" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("an unrecognised path rejects instead of answering with an empty body", async () => {
  const fake = fakeT212Fetch();
  await assert.rejects(
    () => fake(`${BASE}/equity/metadata/instruments`, { method: "GET" }),
    /no canned response for GET \/equity\/metadata\/instruments/,
  );
});

test("an order placement rejects: the fake never accepts an order", async () => {
  const fake = fakeT212Fetch();
  await assert.rejects(
    () =>
      fake(`${BASE}/equity/orders/market`, {
        method: "POST",
        body: JSON.stringify({ ticker: "AAPL_US_EQ", quantity: 1 }),
      }),
    /no canned response for POST \/equity\/orders\/market/,
  );
});

test("a real T212Client reads the canned values through the fake, without touching the network", async () => {
  // A tripwire on the global fetch: if the fake ever delegated to the network, this throws.
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network reached");
  }) as typeof fetch;
  try {
    const client = new T212Client({
      apiKey: "unused",
      apiSecret: "unused",
      env: "demo",
      fetchImpl: fakeT212Fetch(),
    });
    assert.deepEqual(await client.getCash({ fresh: true }), FAKE_CASH);
    assert.deepEqual(await client.getPortfolio({ fresh: true }), FAKE_POSITIONS);
    const snapshot = await client.getBrokerSnapshot({ fresh: true });
    assert.deepEqual(snapshot.cash, FAKE_CASH);
    assert.deepEqual(snapshot.positions, FAKE_POSITIONS);
    assert.deepEqual(await client.getPendingOrders(), []);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
