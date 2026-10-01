import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Candle, NewsItem } from "./data.ts";
import {
  FUNNEL_CHUNKS,
  FUNNEL_ITEMS_PER_TICKER,
  FUNNEL_MAX_ITEMS_PER_CHUNK,
  FUNNEL_OUTCOME_TICKERS_PER_RUN,
  FUNNEL_OUTCOME_TRADING_DAYS,
  type FunnelOutcome,
  outcomeFromCandles,
  runFunnelChunk,
  screenFunnelItem,
  scoreFunnelOutcomes,
  selectTickerNews,
} from "./funnel.ts";
import { FUNNEL_TAG_WEIGHT, funnelScore, rankFunnel, recencyFactor } from "./funnel-score.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import type { FunnelItemRecord, StoredFunnelItem } from "./memory.ts";
import { TiingoError } from "./tiingo.ts";
import { loadUniverse, universeChunk } from "./universe.ts";

const NOW = Date.parse("2026-09-17T12:05:00Z");
const H = 3_600_000;

function news(over: Partial<NewsItem> = {}): NewsItem {
  return {
    headline: "Acme raises full-year guidance",
    summary: "Strong demand.",
    source: "reuters",
    url: `https://n/${Math.random()}`,
    datetime: Math.floor((NOW - 2 * H) / 1000),
    related: "ACME",
    ...over,
  };
}

function fakeJev(answers: Partial<{ fresh: number; priced: number; tag: string; up: number }> = {}, fail = false) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions) });
      if (fail) throw new Error("jev down");
      const out: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions as Record<string, JevQuestion>)) {
        if (q.type === "noul") {
          out[id] = { type: "noul", noul: id === "freshCatalyst" ? answers.fresh ?? 0.8 : id === "pricedIn" ? answers.priced ?? 0.2 : answers.up ?? 0.5 };
        } else {
          const options = Object.keys(q.criteria);
          const choice = answers.tag ?? "news-catalyst";
          const probabilities: Record<string, number> = {};
          for (const o of options) probabilities[o] = o === choice ? 0.7 : 0.3 / (options.length - 1);
          out[id] = { type: "choice", choice, probabilities, confidence: 0.7 };
        }
      }
      return { model: "jev-1.13.0", answers: out, usage: { input_tokens: 1, output_tokens: 0 } } as JevResponse<typeof questions>;
    },
  };
  return { client, asked };
}

function fakeMemory() {
  const stored: FunnelItemRecord[] = [];
  const outcomes: { id: string; outcomeUp: boolean; outcomePct: number }[] = [];
  const batches: FunnelOutcome[][] = [];
  let awaiting: StoredFunnelItem[] = [];
  return {
    stored,
    outcomes,
    batches,
    setAwaiting(items: StoredFunnelItem[]) {
      awaiting = items;
    },
    memory: {
      async upsertFunnelItems(items: FunnelItemRecord[]) {
        const seen = new Set(stored.map((s) => s.url));
        let inserted = 0;
        let skipped = 0;
        for (const i of items) {
          if (seen.has(i.url)) skipped += 1;
          else {
            stored.push(i);
            seen.add(i.url);
            inserted += 1;
          }
        }
        return { inserted, skipped };
      },
      // Both queries honour the window and the limit exactly as the Convex range queries do, so a
      // scorer that swaps or drops a bound gets nothing back here, just as it would in production.
      async funnelItemsAwaitingOutcome(screenedAfter: number, screenedBefore: number, limit: number) {
        // Oldest first, and stable: several fixtures share a screenedAt and the run order depends on it.
        return [...awaiting]
          .filter((i) => i.screenedAt > screenedAfter && i.screenedAt < screenedBefore)
          .sort((a, b) => a.screenedAt - b.screenedAt)
          .slice(0, limit);
      },
      async funnelItemsAwaitingOutcomeForTicker(ticker: string, screenedAfter: number, screenedBefore: number, limit: number) {
        return awaiting
          .filter((i) => i.ticker === ticker && i.screenedAt > screenedAfter && i.screenedAt < screenedBefore)
          .slice(0, limit);
      },
      async recordFunnelOutcomes(batch: FunnelOutcome[]) {
        batches.push(batch);
        outcomes.push(...batch);
      },
    },
  };
}

const quiet = { warn: () => {} };
const noSleep = async () => {};

// --- scoring ---

test("score is multiplicative: failing any one test drives it to near zero", () => {
  const base = { freshCatalyst: 0.9, pricedIn: 0.1, strategyTag: "news-catalyst", strategyTagConfidence: 0.9, publishedAt: NOW };
  const good = funnelScore(base, NOW);
  assert.ok(good > 0.7, `expected a strong score, got ${good}`);
  assert.equal(funnelScore({ ...base, strategyTag: "other" }, NOW), 0);
  assert.ok(funnelScore({ ...base, pricedIn: 0.95 }, NOW) < 0.05);
  assert.ok(funnelScore({ ...base, freshCatalyst: 0.05 }, NOW) < 0.05);
});

test("recency halves the score every half-life and never goes negative", () => {
  assert.equal(recencyFactor(NOW, NOW), 1);
  assert.ok(Math.abs(recencyFactor(NOW - 18 * H, NOW) - 0.5) < 1e-9);
  assert.equal(recencyFactor(NOW + H, NOW), 1);
});

test("every strategy tag has a weight and 'other' is worth nothing", () => {
  assert.equal(FUNNEL_TAG_WEIGHT.other, 0);
  assert.equal(FUNNEL_TAG_WEIGHT["news-catalyst"], 1);
  const unknown = funnelScore({ freshCatalyst: 1, pricedIn: 0, strategyTag: "made-up", strategyTagConfidence: 1, publishedAt: NOW }, NOW);
  assert.equal(unknown, 0);
});

test("ranking is highest first with a fresh-first tiebreak", () => {
  const a = { freshCatalyst: 0.5, pricedIn: 0.5, strategyTag: "news-catalyst", strategyTagConfidence: 1, publishedAt: NOW - H };
  const b = { ...a, publishedAt: NOW };
  const c = { ...a, freshCatalyst: 0.9 };
  const ranked = rankFunnel([a, b, c], NOW);
  assert.equal(ranked[0]?.item, c);
  assert.ok((ranked[0]?.score ?? 0) >= (ranked[1]?.score ?? 0));
});

// --- universe ---

test("universe loads, deduplicates, and stripes into chunks that partition it", () => {
  const u = loadUniverse();
  assert.ok(u.tickers.length > 400, `expected the S&P 500, got ${u.tickers.length}`);
  assert.equal(new Set(u.tickers).size, u.tickers.length);
  const chunks = Array.from({ length: FUNNEL_CHUNKS }, (_v, i) => universeChunk(u.tickers, i, FUNNEL_CHUNKS));
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), u.tickers.length);
  assert.equal(new Set(chunks.flat()).size, u.tickers.length);
  assert.throws(() => universeChunk(u.tickers, FUNNEL_CHUNKS, FUNNEL_CHUNKS));
  for (const t of ["AAPL", "MSFT"]) assert.ok(u.tickers.includes(t), `${t} should be in the universe`);
});

test("the universe is imported, never read off disk (structural)", () => {
  // The bundler collapses the app into one file, so a runtime read of a sibling data file resolves
  // to a path production does not have. That broke every funnel fire for thirteen days.
  const src = readFileSync(new URL("./universe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:fs/);
  assert.doesNotMatch(src, /import\.meta\.url/);
  assert.match(src, /from "\.\.\/data\/universe\.ts"/);
});

// --- selection ---

test("ticker news keeps recent, deduplicated items, newest first, capped", () => {
  const stale = news({ datetime: Math.floor((NOW - 48 * H) / 1000), url: "https://n/stale" });
  const dupe = news({ url: "https://n/same" });
  const items = [stale, dupe, { ...dupe }, ...Array.from({ length: 8 }, (_v, i) => news({ datetime: Math.floor((NOW - i * H) / 1000) }))];
  const picked = selectTickerNews(items, NOW);
  assert.equal(picked.length, FUNNEL_ITEMS_PER_TICKER);
  assert.equal(picked.some((n) => n.url === "https://n/stale"), false);
  assert.equal(picked.filter((n) => n.url === "https://n/same").length <= 1, true);
  for (let i = 1; i < picked.length; i += 1) assert.ok((picked[i - 1]?.datetime ?? 0) >= (picked[i]?.datetime ?? 0));
});

// --- screening ---

test("each item is asked the three screening questions and the directional shadow, in one call", async () => {
  const { client, asked } = fakeJev({ up: 0.61 });
  const s = await screenFunnelItem(client, "ACME", news());
  assert.deepEqual(asked[0]?.ids.sort(), ["freshCatalyst", "higherIn10d", "pricedIn", "strategyTag"]);
  assert.equal(s.higherIn10d, 0.61);
  assert.equal(s.model, "jev-1.13.0");
  assert.match(JSON.stringify(asked[0]?.state), /ACME/);
});

// --- the chunk run ---

test("a chunk fetches, screens, scores and stores; one failing ticker is counted, not fatal", async () => {
  const { client } = fakeJev();
  const store = fakeMemory();
  const src = {
    async getCompanyNews(symbol: string) {
      if (symbol === "BAD") throw new Error("finnhub 500");
      return [news({ related: symbol, url: `https://n/${symbol}` })];
    },
  };
  const result = await runFunnelChunk(["AAA", "BAD", "CCC"], { news: src, jev: client, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.equal(result.tickers, 3);
  assert.equal(result.failures, 1);
  assert.equal(result.inserted, 2);
  assert.equal(store.stored[0]?.day, "2026-09-17");
  assert.ok((store.stored[0]?.score ?? 0) > 0);
  assert.equal(typeof store.stored[0]?.higherIn10d, "number");
});

test("a Jev failure on one item skips that item and keeps the rest", async () => {
  const good = fakeJev();
  let calls = 0;
  const flaky: JevClient = {
    async ask(state, questions) {
      calls += 1;
      if (calls === 1) throw new Error("jev 429");
      return good.client.ask(state, questions);
    },
  };
  const store = fakeMemory();
  const src = {
    async getCompanyNews(symbol: string) {
      return [news({ url: `https://n/${symbol}` })];
    },
  };
  const result = await runFunnelChunk(["A", "B"], { news: src, jev: flaky, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.equal(result.screened, 1);
  assert.equal(result.failures, 1);
});

test("a chunk stops fetching once it has enough items for the time budget", async () => {
  const { client } = fakeJev();
  const store = fakeMemory();
  let fetched = 0;
  const src = {
    async getCompanyNews(symbol: string) {
      fetched += 1;
      return Array.from({ length: FUNNEL_ITEMS_PER_TICKER }, (_v, i) => news({ url: `https://n/${symbol}/${i}` }));
    },
  };
  const many = Array.from({ length: 200 }, (_v, i) => `T${i}`);
  const result = await runFunnelChunk(many, { news: src, jev: client, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.ok(fetched < many.length, "fetching should stop early");
  assert.ok(result.screened <= FUNNEL_MAX_ITEMS_PER_CHUNK);
});

// --- outcomes ---

function candles(start: string, closes: number[]): Candle[] {
  const d0 = Date.parse(start);
  return closes.map((close, i) => ({ date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), open: close, high: close, low: close, close }));
}

test("outcome uses the screening-day close and the close ten sessions later", () => {
  const closes = Array.from({ length: FUNNEL_OUTCOME_TRADING_DAYS + 1 }, (_v, i) => 100 + i);
  const out = outcomeFromCandles(candles("2026-09-01", closes), "2026-09-01");
  assert.equal(out?.outcomeUp, true);
  // 110 / 100 - 1 carries float error; compare within a hair, the meaning is unchanged.
  assert.ok(Math.abs((out?.outcomePct ?? 0) - 10) < 1e-9);
  assert.equal(outcomeFromCandles(candles("2026-09-01", closes.slice(0, 5)), "2026-09-01"), null);
});

test("outcome scoring records finished items and leaves the rest pending", async () => {
  const store = fakeMemory();
  const base = { day: "2026-09-01", ticker: "X", headline: "h", summary: "s", source: "r", url: "u", publishedAt: 0, screenedAt: Date.parse("2026-09-01T12:00:00Z"), model: "m", freshCatalyst: 0, pricedIn: 0, strategyTag: "other", strategyTagConfidence: 0, higherIn10d: 0.6, score: 0 };
  store.setAwaiting([{ ...base, _id: "done" }, { ...base, _id: "young", ticker: "Y" }]);
  const src = {
    async getCompanyNews() {
      return [];
    },
    async getCandles(symbol: string) {
      const n = symbol === "X" ? FUNNEL_OUTCOME_TRADING_DAYS + 1 : 3;
      return candles("2026-09-01", Array.from({ length: n }, (_v, i) => 50 - i));
    },
  };
  const res = await scoreFunnelOutcomes({ candles: src, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.equal(res.scored, 1);
  assert.equal(res.pending, 1);
  assert.equal(store.outcomes[0]?.id, "done");
  assert.equal(store.outcomes[0]?.outcomeUp, false);
});

function awaitingItem(_id: string, ticker: string, screenedAt: number): StoredFunnelItem {
  return { _id, day: new Date(screenedAt).toISOString().slice(0, 10), ticker, headline: "h", summary: "s", source: "r", url: `u/${_id}`, publishedAt: 0, screenedAt, model: "m", freshCatalyst: 0, pricedIn: 0, strategyTag: "other", strategyTagConfidence: 0, higherIn10d: 0.6, score: 0 };
}

const AUG = (day: number, hour = 12) => Date.UTC(2026, 7, day, hour);

/** Records each request and serves a month of rising daily closes from the requested start. */
function recordingCandles(fail: (symbol: string) => unknown = () => null) {
  const calls: { symbol: string; fromISO: string }[] = [];
  const source = {
    async getCandles(symbol: string, fromISO: string) {
      calls.push({ symbol, fromISO });
      const err = fail(symbol);
      if (err) throw err;
      return candles(fromISO, Array.from({ length: 30 }, (_v, i) => 100 + i));
    },
  };
  return { calls, source };
}

test("outcome scoring makes one candle request per ticker, from its oldest screening day", async () => {
  const store = fakeMemory();
  // X's oldest item is deliberately not first, so the request start cannot come from result order.
  store.setAwaiting([awaitingItem("x-new", "X", AUG(25, 14)), awaitingItem("x-old", "X", AUG(20)), awaitingItem("x-same", "X", AUG(25, 15)), awaitingItem("y", "Y", AUG(21))]);
  const { calls, source } = recordingCandles();
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(calls.map((c) => c.symbol).sort(), ["X", "Y"]);
  assert.equal(calls.find((c) => c.symbol === "X")?.fromISO, "2026-08-20");
  assert.equal(store.batches.length, 2);
  assert.deepEqual(store.outcomes.map((o) => o.id).sort(), ["x-new", "x-old", "x-same", "y"]);
  assert.equal(res.scored, 4);
  assert.equal(res.tickers, 2);
});

test("outcome scoring fetches at most FUNNEL_OUTCOME_TICKERS_PER_RUN tickers, from a start that moves with the clock", async () => {
  const store = fakeMemory();
  const tickers = Array.from({ length: 12 }, (_v, i) => `T${i}`);
  store.setAwaiting(tickers.map((t, i) => awaitingItem(t, t, AUG(1) + i * H)));
  const start = Math.floor(NOW / 60_000) % tickers.length;
  // A start of zero would hide a scorer that always begins at the head, and only a start past 2
  // makes the ten wrap round the end of the list.
  assert.ok(start > tickers.length - FUNNEL_OUTCOME_TICKERS_PER_RUN, `NOW gives start ${start}; pick one that wraps`);
  const { calls, source } = recordingCandles();
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  const expected = Array.from({ length: FUNNEL_OUTCOME_TICKERS_PER_RUN }, (_v, i) => tickers[(start + i) % tickers.length]);
  assert.equal(calls.length, FUNNEL_OUTCOME_TICKERS_PER_RUN);
  assert.deepEqual(calls.map((c) => c.symbol), expected);
  assert.equal(res.tickers, FUNNEL_OUTCOME_TICKERS_PER_RUN);
});

test("a non-429 error on one ticker is counted and the run carries on", async () => {
  const store = fakeMemory();
  store.setAwaiting([awaitingItem("x", "X", AUG(20)), awaitingItem("y", "Y", AUG(21))]);
  const at = NOW + 60_000;
  assert.equal(Math.floor(at / 60_000) % 2, 0, "the run must start at X for this test to mean anything");
  const { calls, source } = recordingCandles((s) => (s === "X" ? new Error("tiingo 404") : null));
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => at, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(calls.map((c) => c.symbol), ["X", "Y"]);
  assert.equal(res.failures, 1);
  assert.equal(res.rateLimited, false);
  assert.deepEqual(store.outcomes.map((o) => o.id), ["y"]);
});

test("outcome scoring stops the run on a 429", async () => {
  const store = fakeMemory();
  store.setAwaiting([awaitingItem("x", "X", AUG(20)), awaitingItem("y", "Y", AUG(21))]);
  const at = NOW + 60_000;
  assert.equal(Math.floor(at / 60_000) % 2, 0, "the run must start at X for this test to mean anything");
  const { calls, source } = recordingCandles((s) => (s === "X" ? new TiingoError(429, "rate limited") : null));
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => at, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(calls.map((c) => c.symbol), ["X"]);
  assert.equal(res.rateLimited, true);
  assert.equal(res.failures, 1);
  assert.equal(res.scored, 0);
});

test("a ticker that always fails cannot block every fire", async () => {
  const store = fakeMemory();
  const tickers = Array.from({ length: 11 }, (_v, i) => `T${i}`);
  store.setAwaiting(tickers.map((t, i) => awaitingItem(t, t, AUG(1) + i * H)));
  const run = async (at: number) => {
    const { calls, source } = recordingCandles((s) => (s === "T0" ? new Error("unknown symbol") : null));
    await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => at, sleepImpl: noSleep, logger: quiet });
    return calls.map((c) => c.symbol);
  };
  const first = await run(NOW);
  const second = await run(NOW + 60_000);
  assert.notEqual(first[0], second[0]);
  assert.ok(new Set([...first, ...second]).size > FUNNEL_OUTCOME_TICKERS_PER_RUN);
});

test("outcome scoring only touches items inside the window: older than 16 days, younger than 60", async () => {
  const store = fakeMemory();
  const day = 86_400_000;
  store.setAwaiting([
    awaitingItem("x-stale", "X", NOW - 61 * day),
    awaitingItem("x-ripe", "X", NOW - 20 * day),
    awaitingItem("x-young", "X", NOW - 10 * day),
    awaitingItem("stale", "OLD", NOW - 61 * day),
    awaitingItem("young", "NEW", NOW - 10 * day),
  ]);
  const { calls, source } = recordingCandles();
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.deepEqual(calls.map((c) => c.symbol), ["X"]);
  assert.equal(calls[0]?.fromISO, new Date(NOW - 20 * day).toISOString().slice(0, 10));
  assert.deepEqual(store.outcomes.map((o) => o.id), ["x-ripe"]);
  assert.equal(res.scored, 1);
});

test("an item without a full window yet stays pending and records nothing", async () => {
  const store = fakeMemory();
  store.setAwaiting([awaitingItem("z", "Z", AUG(28))]);
  const source = {
    async getCandles(_symbol: string, fromISO: string) {
      return candles(fromISO, Array.from({ length: FUNNEL_OUTCOME_TRADING_DAYS }, (_v, i) => 100 + i));
    },
  };
  const res = await scoreFunnelOutcomes({ candles: source, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.equal(res.tickers, 1);
  assert.equal(res.pending, 1);
  assert.equal(res.scored, 0);
  assert.equal(store.batches.length, 0);
  assert.equal(store.outcomes.length, 0);
});

// --- wiring ---

test("four funnel schedules exist, all before the 15:00 UTC cycle, all calling the shared handler", () => {
  const letters = ["a", "b", "c", "d"];
  for (const l of letters) {
    const src = readFileSync(new URL(`../schedules/funnel-${l}.ts`, import.meta.url), "utf8");
    const m = src.match(/cron: "(\d+) (\d+) \* \* 1-5"/);
    assert.ok(m, `funnel-${l} must declare a weekday cron`);
    const hour = Number(m?.[2]);
    // Hobby jitter is up to 59 minutes, so the latest fire must still land before 15:00 UTC.
    assert.ok(hour <= 13, `funnel-${l} fires at ${hour}:xx, too close to the 15:00 cycle`);
    assert.match(src, /runFunnelSchedule\("funnel-[a-d]"\)/);
  }
  assert.equal(letters.length, FUNNEL_CHUNKS);
});

test("nothing between claiming a chunk and the try that can mark it failed (structural)", () => {
  // A throw after the claim but outside the try leaves the chunk at `started` for ever, so the
  // ordering here is the whole point: unit tests cannot see it.
  const src = readFileSync(new URL("./funnel-schedule.ts", import.meta.url), "utf8");
  const claim = src.indexOf("claimFunnelChunk(");
  const tryAt = src.indexOf("try {", claim);
  const failure = src.indexOf('status: "failed"', tryAt);
  assert.ok(claim > 0 && tryAt > 0 && failure > 0, "expected a claim, a try, and a failure path");
  for (const call of ["loadUniverse(", "universeChunk(", "finnhubFromEnv()", "claimed chunk"]) {
    const at = src.indexOf(call, claim);
    assert.ok(at > tryAt, `${call} runs before the try that marks the chunk failed`);
    assert.ok(at < failure, `${call} should sit inside that try, not after its catch`);
  }
});

test("outcome scoring gets its candles from Tiingo, not the Finnhub news client (structural)", () => {
  // Every unit test injects a fake candle source, so all of them stay green if the schedule keeps
  // passing the Finnhub client, whose /stock/candle 403s on our tier. That is the bug that shipped
  // and scored nothing for months; only this file's source shows the wiring.
  const src = readFileSync(new URL("./funnel-schedule.ts", import.meta.url), "utf8");
  assert.match(src, /from "\.\/tiingo\.ts"/);
  assert.match(src, /const candles = tiingoFromEnv\(\)/);
  assert.match(src, /scoreFunnelOutcomes\(\{ candles, memory/);
  assert.doesNotMatch(src, /scoreFunnelOutcomes\(\{[^}]*news/);
  assert.match(src, /finnhubFromEnv\(\)/);
});
