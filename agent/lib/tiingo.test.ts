import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TiingoProvider,
  TiingoError,
  tiingoFromEnv,
  mapTiingoPrices,
} from "./tiingo.ts";

function fakeFetch(
  handler: (url: string) => { status?: number; body?: unknown },
) {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const r = handler(String(input));
    const bodyText =
      r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(bodyText, { status: r.status ?? 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

// --- getCandles: URL / params ---

test("getCandles builds the daily-prices URL with startDate/endDate/token/format", async () => {
  const f = fakeFetch(() => ({ body: [] }));
  const p = new TiingoProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await p.getCandles("AAPL", "2024-01-01", "2025-01-01");
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/tiingo/daily/aapl/prices");
  assert.equal(u.searchParams.get("startDate"), "2024-01-01");
  assert.equal(u.searchParams.get("endDate"), "2025-01-01");
  assert.equal(u.searchParams.get("token"), "KEY");
  assert.equal(u.searchParams.get("format"), "json");
});

// --- getCandles: uses ADJUSTED fields and normalizes/sorts ---

test("getCandles maps ADJUSTED OHLC, strips the time, and sorts ascending", async () => {
  // Deliberately out of order, and raw != adj so we prove adj is used.
  const f = fakeFetch(() => ({
    body: [
      {
        date: "2024-01-04T00:00:00.000Z",
        open: 200,
        high: 201,
        low: 199,
        close: 200.5,
        adjOpen: 102,
        adjHigh: 104,
        adjLow: 101,
        adjClose: 103,
        volume: 1000,
      },
      {
        date: "2024-01-03T00:00:00.000Z",
        open: 190,
        high: 191,
        low: 189,
        close: 190.5,
        adjOpen: 100,
        adjHigh: 101,
        adjLow: 99,
        adjClose: 100.5,
        volume: 900,
      },
    ],
  }));
  const p = new TiingoProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const candles = await p.getCandles("AAPL", "2024-01-03", "2024-01-04");
  assert.deepEqual(candles, [
    { date: "2024-01-03", open: 100, high: 101, low: 99, close: 100.5 },
    { date: "2024-01-04", open: 102, high: 104, low: 101, close: 103 },
  ]);
});

// --- mapTiingoPrices: empty / malformed ---

test("mapTiingoPrices returns [] for an empty array", () => {
  assert.deepEqual(mapTiingoPrices([]), []);
});

test("mapTiingoPrices skips rows missing adjusted fields", () => {
  const rows = [
    {
      date: "2024-01-03T00:00:00.000Z",
      adjOpen: 100,
      adjHigh: 101,
      adjLow: 99,
      adjClose: 100.5,
    },
    // malformed: missing adjClose
    { date: "2024-01-04T00:00:00.000Z", adjOpen: 102, adjHigh: 104, adjLow: 101 },
  ] as unknown as Parameters<typeof mapTiingoPrices>[0];
  assert.deepEqual(mapTiingoPrices(rows), [
    { date: "2024-01-03", open: 100, high: 101, low: 99, close: 100.5 },
  ]);
});

// --- 429 backoff (mirrors data.test.ts) ---

test("retries once on 429 then resolves on 200", async () => {
  let calls = 0;
  const f = fakeFetch(() => {
    calls++;
    if (calls === 1) return { status: 429, body: "limit" };
    return { body: [] };
  });
  const p = new TiingoProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await p.getCandles("AAPL", "2024-01-01", "2024-01-31");
  assert.equal(calls, 2);
});

test("persistent 429 retries the full budget then throws TiingoError", async () => {
  const f = fakeFetch(() => ({ status: 429, body: "limit" }));
  const p = new TiingoProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await assert.rejects(
    () => p.getCandles("AAPL", "2024-01-01", "2024-01-31"),
    (err: unknown) => {
      assert.ok(err instanceof TiingoError);
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      return true;
    },
  );
  assert.equal(f.calls.length, 4); // initial attempt + 3 retries
});

test("non-429 error throws TiingoError immediately without retrying", async () => {
  const f = fakeFetch(() => ({ status: 403, body: "no access" }));
  const p = new TiingoProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await assert.rejects(
    () => p.getCandles("AAPL", "2024-01-01", "2024-01-31"),
    (err: unknown) => {
      assert.ok(err instanceof TiingoError);
      assert.equal(err.status, 403);
      assert.equal(err.rateLimited, false);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
});

// --- env factory ---

test("tiingoFromEnv throws when TIINGO_API_KEY is unset", () => {
  const prev = process.env.TIINGO_API_KEY;
  delete process.env.TIINGO_API_KEY;
  try {
    assert.throws(() => tiingoFromEnv(), /TIINGO_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.TIINGO_API_KEY = prev;
  }
});

test("tiingoFromEnv returns a provider when the key is set", () => {
  const prev = process.env.TIINGO_API_KEY;
  process.env.TIINGO_API_KEY = "test-key";
  try {
    const p = tiingoFromEnv();
    assert.ok(p instanceof TiingoProvider);
  } finally {
    if (prev === undefined) delete process.env.TIINGO_API_KEY;
    else process.env.TIINGO_API_KEY = prev;
  }
});
