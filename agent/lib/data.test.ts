import { test } from "node:test";
import assert from "node:assert/strict";
import { FinnhubProvider, FinnhubError, finnhubFromEnv } from "./data.ts";

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

test("throws FinnhubError on non-2xx, flags 429", async () => {
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

// --- Task 3: env factory ---

test("finnhubFromEnv throws when FINNHUB_API_KEY is unset", () => {
  const prev = process.env.FINNHUB_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  try {
    assert.throws(() => finnhubFromEnv(), /FINNHUB_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FINNHUB_API_KEY = prev;
  }
});

test("finnhubFromEnv returns a provider when the key is set", () => {
  const prev = process.env.FINNHUB_API_KEY;
  process.env.FINNHUB_API_KEY = "test-key";
  try {
    const p = finnhubFromEnv();
    assert.ok(p instanceof FinnhubProvider);
  } finally {
    if (prev === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = prev;
  }
});
