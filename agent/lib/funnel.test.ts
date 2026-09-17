import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Candle, NewsItem } from "./data.ts";
import {
  FUNNEL_CHUNKS,
  FUNNEL_ITEMS_PER_TICKER,
  FUNNEL_MAX_ITEMS_PER_CHUNK,
  FUNNEL_OUTCOME_TRADING_DAYS,
  outcomeFromCandles,
  runFunnelChunk,
  screenFunnelItem,
  scoreFunnelOutcomes,
  selectTickerNews,
} from "./funnel.ts";
import { FUNNEL_TAG_WEIGHT, funnelScore, rankFunnel, recencyFactor } from "./funnel-score.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import type { FunnelItemRecord, StoredFunnelItem } from "./memory.ts";
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
  let awaiting: StoredFunnelItem[] = [];
  return {
    stored,
    outcomes,
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
      async funnelItemsAwaitingOutcome() {
        return awaiting;
      },
      async recordFunnelOutcome(input: { id: string; outcomeAt: number; outcomeUp: boolean; outcomePct: number }) {
        outcomes.push(input);
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
    async getCandles() {
      return [];
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
    async getCandles() {
      return [];
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
    async getCandles() {
      return [];
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
  const res = await scoreFunnelOutcomes({ news: src, memory: store.memory, now: () => NOW, sleepImpl: noSleep, logger: quiet });
  assert.equal(res.scored, 1);
  assert.equal(res.pending, 1);
  assert.equal(store.outcomes[0]?.id, "done");
  assert.equal(store.outcomes[0]?.outcomeUp, false);
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
