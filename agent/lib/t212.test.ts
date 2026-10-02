import { test } from "node:test";
import assert from "node:assert/strict";
import {
  T212Client,
  T212Error,
  resetT212Singleton,
  t212FromEnv,
  type T212Config,
} from "./t212.ts";
import { FAKE_CASH } from "./t212-fake.ts";

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

test("getBrokerSnapshot reads cash and positions together and caches the pair", async () => {
  let free = 100;
  const f = fakeFetch((url) => ({
    body: url.endsWith("/cash") ? { total: free, free } : [],
  }));
  const client = new T212Client(cfg({ fetchImpl: f.fn }));
  const first = await client.getBrokerSnapshot();
  const second = await client.getBrokerSnapshot();
  assert.equal(f.calls.length, 2);
  assert.equal(first.cash.free, 100);
  assert.deepEqual(first.positions, []);
  assert.equal(second, first);
  assert.ok(first.takenAt >= first.cashReadAt);
  assert.ok(first.takenAt >= first.positionsReadAt);
  assert.equal(
    f.calls.filter((call) => call.url.endsWith("/equity/account/cash")).length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.url.endsWith("/equity/portfolio")).length,
    1,
  );
  free = 200;
  const fresh = await client.getBrokerSnapshot({ fresh: true });
  assert.equal(f.calls.length, 4);
  assert.equal(fresh.cash.free, 200);
});

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

// --- t212FromEnv: BROKER_FAKE and its DRY_RUN interlock ---

const BROKER_ENV_KEYS = [
  "BROKER_FAKE",
  "DRY_RUN",
  "TRADING212_ENV",
  "TRADING212_API_KEY",
  "TRADING212_API_SECRET",
  "TRADING212_SECRET_KEY",
] as const;
type BrokerEnv = Partial<Record<(typeof BROKER_ENV_KEYS)[number], string>>;

/**
 * Run `fn` with exactly `vars` set among the broker env keys (the rest deleted), restoring the
 * prior values after. The client singleton is module-level, so it is cleared on the way in and
 * out: a fake memoised here must never leak into a later test.
 */
async function withBrokerEnv(vars: BrokerEnv, fn: () => Promise<void> | void) {
  const prev = BROKER_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of BROKER_ENV_KEYS) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetT212Singleton();
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetT212Singleton();
  }
}

/** Fail the test if anything reaches the global fetch while `fn` runs. */
async function withNetworkTripwire(fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`network reached: ${String(input)}`);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("BROKER_FAKE=true with DRY_RUN=true serves the fake with no credential set, memoised", async () => {
  await withBrokerEnv({ BROKER_FAKE: "true", DRY_RUN: "true" }, () =>
    withNetworkTripwire(async () => {
      const client = t212FromEnv();
      assert.deepEqual(await client.getCash(), FAKE_CASH);
      assert.equal(t212FromEnv(), client, "one client, one snapshot cache, per process");
    }),
  );
});

test("BROKER_FAKE=true with DRY_RUN=false THROWS: no fake balance while real orders are armed", async () => {
  await withBrokerEnv(
    { BROKER_FAKE: "true", DRY_RUN: "false", TRADING212_API_KEY: "KEY", TRADING212_API_SECRET: "SECRET" },
    () => {
      assert.throws(() => t212FromEnv(), /DRY_RUN/);
    },
  );
});

test("a fake memoised under DRY_RUN=true is refused once DRY_RUN=false", async () => {
  await withBrokerEnv({ BROKER_FAKE: "true", DRY_RUN: "true" }, () => {
    t212FromEnv();
    process.env.DRY_RUN = "false";
    assert.throws(() => t212FromEnv(), /DRY_RUN/);
  });
});

test("BROKER_FAKE=true with TRADING212_ENV=live is still the fake, and no live host is contacted", async () => {
  await withBrokerEnv(
    {
      BROKER_FAKE: "true",
      DRY_RUN: "true",
      TRADING212_ENV: "live",
      TRADING212_API_KEY: "KEY",
      TRADING212_API_SECRET: "SECRET",
    },
    () =>
      withNetworkTripwire(async () => {
        assert.deepEqual(await t212FromEnv().getCash(), FAKE_CASH);
      }),
  );
});

test("BROKER_FAKE unset with credentials is the real client, through the injected fetchImpl", async () => {
  await withBrokerEnv(
    { TRADING212_API_KEY: "KEY", TRADING212_SECRET_KEY: "SECRET", TRADING212_ENV: "demo" },
    async () => {
      const f = fakeFetch(() => ({ body: { free: 42 } }));
      const cash = await t212FromEnv(f.fn).getCash();
      assert.equal(cash.free, 42);
      assert.equal(f.calls[0].url, "https://demo.trading212.com/api/v0/equity/account/cash");
      const headers = f.calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Basic " + Buffer.from("KEY:SECRET").toString("base64"));
    },
  );
});

test("BROKER_FAKE unset, or anything but the exact string true, without credentials keeps the original error", async () => {
  for (const flag of [undefined, "1", "TRUE", "yes"]) {
    await withBrokerEnv({ BROKER_FAKE: flag, DRY_RUN: "true" }, () => {
      assert.throws(
        () => t212FromEnv(),
        /TRADING212_API_KEY and TRADING212_API_SECRET \(or TRADING212_SECRET_KEY\) must be set/,
        `BROKER_FAKE=${String(flag)}`,
      );
    });
  }
});
