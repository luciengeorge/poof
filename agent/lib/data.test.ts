import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FinnhubProvider,
  FinnhubError,
  finnhubFromEnv,
  mapCandles,
  resetFinnhubProvider,
} from "./data.ts";

function fakeFetch(
  handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    const r = handler(String(input));
    const bodyText =
      r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(bodyText, { status: r.status ?? 200, headers: r.headers });
  };
  return { fn: fn as unknown as typeof fetch, calls, inits };
}

/** A fetch that never resolves on its own; it settles only when aborted. */
function hangingFetch() {
  let aborted = false;
  const fn = async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  return { fn: fn as unknown as typeof fetch, wasAborted: () => aborted };
}

// --- Task 1: scaffold + getQuote ---

test("getQuote builds the right URL with token and maps fields", async () => {
  const f = fakeFetch(() => ({
    body: { c: 110, pc: 100, dp: 10, d: 10, h: 111, l: 99, o: 101, t: 1 },
  }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const q = await p.getQuote("AAPL");
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/api/v1/quote");
  assert.equal(u.searchParams.get("symbol"), "AAPL");
  assert.equal(u.searchParams.get("token"), "KEY");
  assert.deepEqual(q, { symbol: "AAPL", price: 110, prevClose: 100, changePct: 10 });
});

test("persistent 429 retries the full budget then throws FinnhubError", async () => {
  const f = fakeFetch(() => ({ status: 429, body: "limit" }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await assert.rejects(
    () => p.getQuote("AAPL"),
    (err: unknown) => {
      assert.ok(err instanceof FinnhubError);
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      return true;
    },
  );
  assert.equal(f.calls.length, 4); // initial attempt + 3 retries
});

// --- 429 backoff ---

test("retries once on 429 then resolves on 200", async () => {
  let calls = 0;
  const f = fakeFetch(() => {
    calls++;
    if (calls === 1) return { status: 429, body: "limit" };
    return { body: { c: 110, pc: 100, dp: 10 } };
  });
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const q = await p.getQuote("AAPL");
  assert.equal(calls, 2);
  assert.deepEqual(q, { symbol: "AAPL", price: 110, prevClose: 100, changePct: 10 });
});

// --- deadlines ---

test("a hanging Finnhub read is aborted at the deadline instead of waiting for ever", async () => {
  const h = hangingFetch();
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: h.fn, timeoutMs: 25 });
  const startedAt = Date.now();
  await assert.rejects(() => p.getQuote("AAPL"), /timed out after 25ms/);
  assert.ok(h.wasAborted(), "the AbortSignal must have fired");
  assert.ok(Date.now() - startedAt < 2_000, "must not have waited anywhere near the default");
});

test("every Finnhub attempt, the 429 retry included, carries an abort signal", async () => {
  let n = 0;
  const f = fakeFetch(() => {
    n++;
    if (n === 1) return { status: 429, body: "limit", headers: { "retry-after": "0.01" } };
    return { body: { c: 110, pc: 100, dp: 10 } };
  });
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await p.getQuote("AAPL");
  assert.equal(f.inits.length, 2);
  for (const init of f.inits) assert.ok(init?.signal instanceof AbortSignal);
});

test("a successful Finnhub read disarms its deadline", async () => {
  // A deadline left armed after success would fire later on a finished request (and keep a warm
  // serverless process holding a timer). Waiting past it and finding the signal unaborted proves
  // the timer was cleared; merely completing several calls in a row would not.
  const f = fakeFetch(() => ({ body: { c: 110, pc: 100, dp: 10 } }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn, timeoutMs: 20 });
  await p.getQuote("AAPL");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const signal = f.inits[0]?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("the call budget gives up on a persistent 429 before sleeping, not after the retries run out", async () => {
  const f = fakeFetch(() => ({ status: 429, body: "limit", headers: { "retry-after": "1" } }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn, callBudgetMs: 50 });
  const startedAt = Date.now();
  await assert.rejects(
    () => p.getQuote("AAPL"),
    (err: unknown) => {
      assert.ok(err instanceof FinnhubError);
      assert.equal(err.status, 429);
      return true;
    },
  );
  // One call, not four: the first one-second backoff already overshoots a 50 ms budget, so the
  // budget (not retry exhaustion) is what ended the call, and it ended it without sleeping.
  assert.equal(f.calls.length, 1);
  assert.ok(Date.now() - startedAt < 500, "the budget must be checked before the backoff sleep");
});

// --- Task 2: news ---

test("getCompanyNews passes symbol + date range and maps items", async () => {
  const f = fakeFetch(() => ({
    body: [
      {
        headline: "Apple beats earnings",
        summary: "Strong quarter.",
        source: "Reuters",
        url: "https://x/y",
        datetime: 1700000000,
        related: "AAPL",
      },
    ],
  }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const news = await p.getCompanyNews("AAPL", "2026-06-01", "2026-06-22");
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/api/v1/company-news");
  assert.equal(u.searchParams.get("symbol"), "AAPL");
  assert.equal(u.searchParams.get("from"), "2026-06-01");
  assert.equal(u.searchParams.get("to"), "2026-06-22");
  assert.equal(news.length, 1);
  assert.equal(news[0].headline, "Apple beats earnings");
  assert.equal(news[0].related, "AAPL");
});

test("getMarketNews hits the general category", async () => {
  const f = fakeFetch(() => ({ body: [] }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await p.getMarketNews();
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/api/v1/news");
  assert.equal(u.searchParams.get("category"), "general");
});

test("mapNews tolerates a missing 'related' field", async () => {
  const f = fakeFetch(() => ({
    body: [{ headline: "h", summary: "s", source: "x", url: "u", datetime: 1 }],
  }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const news = await p.getMarketNews();
  assert.equal(news[0].related, "");
});

// --- earnings calendar ---

test("getEarningsCalendar passes symbol+range and maps the earningsCalendar array", async () => {
  const f = fakeFetch(() => ({
    body: {
      earningsCalendar: [
        { symbol: "NKE", date: "2026-06-26", hour: "amc", epsEstimate: 0.6, year: 2026 },
        { symbol: "NKE", date: "2026-03-20", hour: "bmo", epsEstimate: null },
      ],
    },
  }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const events = await p.getEarningsCalendar("NKE", "2026-06-25", "2026-09-23");
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/api/v1/calendar/earnings");
  assert.equal(u.searchParams.get("symbol"), "NKE");
  assert.equal(u.searchParams.get("from"), "2026-06-25");
  assert.deepEqual(events[0], { symbol: "NKE", date: "2026-06-26", hour: "amc", epsEstimate: 0.6 });
  assert.equal(events[1].epsEstimate, null);
});

test("getEarningsCalendar tolerates a missing earningsCalendar field", async () => {
  const f = fakeFetch(() => ({ body: {} }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  assert.deepEqual(await p.getEarningsCalendar("X", "2026-06-01", "2026-06-30"), []);
});

// --- candles (backtest data source) ---

test("getCandles passes symbol+resolution+range and maps the parallel-array payload", async () => {
  // Two bars, deliberately out of order in the payload to prove we sort by date.
  const f = fakeFetch(() => ({
    body: {
      s: "ok",
      t: [1704326400, 1704240000], // 2024-01-04, 2024-01-03 (UTC)
      o: [102, 100],
      h: [104, 101],
      l: [101, 99],
      c: [103, 100.5],
    },
  }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const candles = await p.getCandles("AAPL", "2024-01-03", "2024-01-04", "D");
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, "/api/v1/stock/candle");
  assert.equal(u.searchParams.get("symbol"), "AAPL");
  assert.equal(u.searchParams.get("resolution"), "D");
  assert.equal(u.searchParams.get("from"), String(Math.floor(Date.parse("2024-01-03") / 1000)));
  assert.equal(u.searchParams.get("to"), String(Math.floor(Date.parse("2024-01-04") / 1000)));
  assert.deepEqual(candles, [
    { date: "2024-01-03", open: 100, high: 101, low: 99, close: 100.5 },
    { date: "2024-01-04", open: 102, high: 104, low: 101, close: 103 },
  ]);
});

test("getCandles defaults resolution to D", async () => {
  const f = fakeFetch(() => ({ body: { s: "no_data" } }));
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await p.getCandles("AAPL", "2024-01-01", "2024-01-31");
  const u = new URL(f.calls[0]);
  assert.equal(u.searchParams.get("resolution"), "D");
});

test("mapCandles returns [] on no_data or missing arrays", () => {
  assert.deepEqual(mapCandles({ s: "no_data" }), []);
  assert.deepEqual(mapCandles({ s: "ok", t: [1] }), []);
});

// --- Task 3: env factory ---

/** Run `fn` with a test key and no memoised provider on either side of it, so order cannot matter. */
async function withFinnhubKey(fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env.FINNHUB_API_KEY;
  process.env.FINNHUB_API_KEY = "test-key";
  resetFinnhubProvider();
  try {
    await fn();
  } finally {
    resetFinnhubProvider();
    if (prev === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = prev;
  }
}

test("finnhubFromEnv throws when FINNHUB_API_KEY is unset", () => {
  // finnhubFromEnv memoises: a provider left by an earlier test would be returned without the env
  // being read, and this would stop throwing for a reason that has nothing to do with the key.
  resetFinnhubProvider();
  const prev = process.env.FINNHUB_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  try {
    assert.throws(() => finnhubFromEnv(), /FINNHUB_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FINNHUB_API_KEY = prev;
  }
});

test("finnhubFromEnv returns a provider when the key is set", () => {
  // Reset so this builds a provider rather than passing on one memoised by an earlier test, and
  // again afterwards so it leaves no memoised provider behind for a later one.
  resetFinnhubProvider();
  const prev = process.env.FINNHUB_API_KEY;
  process.env.FINNHUB_API_KEY = "test-key";
  try {
    const p = finnhubFromEnv();
    assert.ok(p instanceof FinnhubProvider);
  } finally {
    resetFinnhubProvider();
    if (prev === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = prev;
  }
});

test("finnhubFromEnv shares one provider per process on the default path", async () => {
  await withFinnhubKey(() => {
    assert.equal(finnhubFromEnv(), finnhubFromEnv());
  });
});

test("an injected fetchImpl bypasses the shared provider and never replaces it", async () => {
  await withFinnhubKey(() => {
    const shared = finnhubFromEnv();
    const f = fakeFetch(() => ({ body: {} }));
    const a = finnhubFromEnv(f.fn);
    const b = finnhubFromEnv(f.fn);
    assert.notEqual(a, b);
    assert.notEqual(a, shared);
    assert.notEqual(b, shared);
    assert.equal(finnhubFromEnv(), shared);
  });
});

test("resetFinnhubProvider drops the shared provider so the next call builds a new one", async () => {
  await withFinnhubKey(() => {
    const first = finnhubFromEnv();
    resetFinnhubProvider();
    assert.notEqual(finnhubFromEnv(), first);
  });
});

test("the shared provider uses the fetch in place at request time, not the one it was built under", async () => {
  // The memoised provider outlives the test that built it. Had it captured fetch at construction,
  // a stub installed later (as the get_prices test below does) would be ignored and the real fetch
  // used. The construction-time fetch here is a trap that throws, so no failure can reach the network.
  const prevFetch = globalThis.fetch;
  let trapped = 0;
  globalThis.fetch = (async () => {
    trapped++;
    throw new Error("the construction-time fetch was used");
  }) as typeof fetch;
  try {
    await withFinnhubKey(async () => {
      const p = finnhubFromEnv();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ c: 110, pc: 100, dp: 10 }))) as typeof fetch;
      const q = await p.getQuote("AAPL");
      assert.equal(q.price, 110);
      assert.equal(trapped, 0);
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// --- get_prices tool: partial results ---

test("get_prices returns quotes for symbols that succeed and failures for symbols that reject", async () => {
  const prevKey = process.env.FINNHUB_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.FINNHUB_API_KEY = "test-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const symbol = new URL(String(input)).searchParams.get("symbol");
    if (symbol === "BAD") throw new Error("network down");
    return new Response(JSON.stringify({ c: 110, pc: 100, dp: 10 }), {
      status: 200,
    });
  }) as typeof fetch;
  // The tool calls finnhubFromEnv(), which memoises. Reset so this test builds its own provider
  // under the stub above rather than reusing one an earlier test left, and again afterwards.
  resetFinnhubProvider();
  try {
    const getPrices = (await import("../tools/get_prices.ts")).default;
    const result = (await (getPrices.execute as any)({
      symbols: ["AAPL", "BAD"],
    })) as { quotes: { symbol: string }[]; failures: { symbol: string; error: string }[] };
    assert.equal(result.quotes.length, 1);
    assert.equal(result.quotes[0].symbol, "AAPL");
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].symbol, "BAD");
    assert.match(result.failures[0].error, /network down/);
  } finally {
    resetFinnhubProvider();
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = prevKey;
  }
});
