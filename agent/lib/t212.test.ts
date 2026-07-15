import { test } from "node:test";
import assert from "node:assert/strict";
import { T212Client, T212Error, type T212Config } from "./t212.ts";

// Records requests and returns a canned Response.
function fakeFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url: String(input), init: i });
    const r = handler(String(input), i);
    const bodyText =
      r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(bodyText, {
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function cfg(over: Partial<T212Config> = {}): T212Config {
  return { apiKey: "KEY", apiSecret: "SECRET", env: "demo", ...over };
}

// --- Task 1: scaffold ---

test("uses the demo base URL and Basic auth header", async () => {
  const f = fakeFetch(() => ({ body: { free: 100 } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getCash();
  assert.equal(
    f.calls[0].url,
    "https://demo.trading212.com/api/v0/equity/account/cash",
  );
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(
    headers.Authorization,
    "Basic " + Buffer.from("KEY:SECRET").toString("base64"),
  );
});

test("uses the live base URL when env=live", async () => {
  const f = fakeFetch(() => ({ body: {} }));
  const client = new T212Client(cfg({ env: "live", fetchImpl: f.fn }));
  await client.getCash();
  assert.match(f.calls[0].url, /^https:\/\/live\.trading212\.com\/api\/v0\//);
});

test("throws T212Error on non-2xx, flags 429 as rateLimited", async () => {
  const f = fakeFetch(() => ({ status: 429, body: "slow down" }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await assert.rejects(
    () => client.getCash(),
    (err: unknown) => {
      assert.ok(err instanceof T212Error);
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      assert.match(err.body, /slow down/);
      return true;
    },
  );
});

test("captures rate-limit headers into lastRateLimit()", async () => {
  const f = fakeFetch(() => ({
    body: { free: 1 },
    headers: {
      "x-ratelimit-limit": "50",
      "x-ratelimit-remaining": "49",
      "x-ratelimit-reset": "1700000000",
      "x-ratelimit-period": "60",
      "x-ratelimit-used": "1",
    },
  }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getCash();
  const rl = client.lastRateLimit();
  assert.equal(rl?.limit, 50);
  assert.equal(rl?.remaining, 49);
  assert.equal(rl?.used, 1);
});

// --- Task 2: read methods ---

test("getPortfolio parses positions and hits the right path", async () => {
  const f = fakeFetch(() => ({
    body: [
      {
        ticker: "AAPL_US_EQ",
        quantity: 1.5,
        averagePrice: 100,
        currentPrice: 110,
        ppl: 15,
        maxBuy: 10,
        maxSell: 1.5,
        pieQuantity: 0,
      },
    ],
  }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  const positions = await client.getPortfolio();
  assert.equal(f.calls[0].url, "https://demo.trading212.com/api/v0/equity/portfolio");
  assert.equal(positions[0].ticker, "AAPL_US_EQ");
  assert.equal(positions[0].currentPrice, 110);
});

test("getPosition URL-encodes the ticker", async () => {
  const f = fakeFetch(() => ({ body: { ticker: "AAPL_US_EQ" } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getPosition("AAPL_US_EQ");
  assert.equal(
    f.calls[0].url,
    "https://demo.trading212.com/api/v0/equity/portfolio/AAPL_US_EQ",
  );
});

test("getPendingOrders and getInstruments hit the right paths", async () => {
  const f = fakeFetch(() => ({ body: [] }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getPendingOrders();
  await client.getInstruments();
  assert.equal(f.calls[0].url, "https://demo.trading212.com/api/v0/equity/orders");
  assert.equal(
    f.calls[1].url,
    "https://demo.trading212.com/api/v0/equity/metadata/instruments",
  );
});

// --- Task 3: order methods ---

test("placeMarketOrder POSTs signed quantity as JSON", async () => {
  const f = fakeFetch(() => ({ body: { id: 1, ticker: "AAPL_US_EQ", quantity: 2 } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  const order = await client.placeMarketOrder({ ticker: "AAPL_US_EQ", quantity: 2 });
  const call = f.calls[0];
  assert.equal(call.url, "https://demo.trading212.com/api/v0/equity/orders/market");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body as string), {
    ticker: "AAPL_US_EQ",
    quantity: 2,
  });
  assert.equal(order.id, 1);
});

test("placeMarketOrder passes negative quantity for SELL verbatim", async () => {
  const f = fakeFetch(() => ({ body: { id: 2 } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.placeMarketOrder({ ticker: "AAPL_US_EQ", quantity: -3 });
  assert.equal(JSON.parse(f.calls[0].init.body as string).quantity, -3);
});

test("placeLimitOrder includes limitPrice and timeValidity", async () => {
  const f = fakeFetch(() => ({ body: { id: 3 } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.placeLimitOrder({
    ticker: "AAPL_US_EQ",
    quantity: 1,
    limitPrice: 105.5,
    timeValidity: "DAY",
  });
  assert.equal(f.calls[0].url, "https://demo.trading212.com/api/v0/equity/orders/limit");
  assert.deepEqual(JSON.parse(f.calls[0].init.body as string), {
    ticker: "AAPL_US_EQ",
    quantity: 1,
    limitPrice: 105.5,
    timeValidity: "DAY",
  });
});

test("cancelOrder DELETEs the order by id", async () => {
  const f = fakeFetch(() => ({ status: 200, body: "" }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.cancelOrder(12345);
  assert.equal(f.calls[0].url, "https://demo.trading212.com/api/v0/equity/orders/12345");
  assert.equal(f.calls[0].init.method, "DELETE");
});

// --- Task 4: getCash/getPortfolio TTL cache ---

test("getCash caches within the TTL: two calls hit the network once", async () => {
  const f = fakeFetch(() => ({ body: { free: 100 } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getCash();
  await client.getCash();
  assert.equal(f.calls.length, 1);
});

test("getPortfolio caches within the TTL: two calls hit the network once", async () => {
  const f = fakeFetch(() => ({ body: [] }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getPortfolio();
  await client.getPortfolio();
  assert.equal(f.calls.length, 1);
});

test("getCash({fresh:true}) bypasses the cache and refetches", async () => {
  let free = 100;
  const f = fakeFetch(() => ({ body: { free } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  const first = await client.getCash();
  free = 200;
  const second = await client.getCash({ fresh: true });
  assert.equal(f.calls.length, 2);
  assert.equal(first.free, 100);
  assert.equal(second.free, 200);
});

test("getPortfolio({fresh:true}) bypasses the cache and refetches", async () => {
  let quantity = 1;
  const f = fakeFetch(() => ({
    body: [
      {
        ticker: "AAPL_US_EQ",
        quantity,
        averagePrice: 100,
        currentPrice: 110,
        ppl: 0,
        maxBuy: 10,
        maxSell: 10,
        pieQuantity: 0,
      },
    ],
  }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  const first = await client.getPortfolio();
  quantity = 2;
  const second = await client.getPortfolio({ fresh: true });
  assert.equal(f.calls.length, 2);
  assert.equal(first[0].quantity, 1);
  assert.equal(second[0].quantity, 2);
});

test("a fresh:true fetch is itself cached for the next plain call", async () => {
  let free = 100;
  const f = fakeFetch(() => ({ body: { free } }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getCash();
  free = 300;
  await client.getCash({ fresh: true });
  const third = await client.getCash();
  assert.equal(f.calls.length, 2);
  assert.equal(third.free, 300);
});

test("getPendingOrders is never cached: repeated calls always refetch", async () => {
  const f = fakeFetch(() => ({ body: [] }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  await client.getPendingOrders();
  await client.getPendingOrders();
  assert.equal(f.calls.length, 2);
});
