import { test } from "node:test";
import assert from "node:assert/strict";
import { FinnhubError, FinnhubProvider } from "../data.ts";
import { Memory, type ConvexLike } from "../memory.ts";
import { getFunctionName } from "convex/server";
import { runShadow, type ShadowDeps } from "./run.ts";
import { shadowFinnhub, adjustedBars, ShadowBudgetError } from "./providers.ts";
import type { ForecastRow, ShadowStore } from "./store.ts";
import type { JevClient } from "../jev.ts";

function rig() {
  let time = Date.parse("2026-11-11T16:30:00Z");
  const log: string[] = [];
  const row: ForecastRow = { _id: "event", ticker: "AAPL", day: "2026-11-11", story: "event", headline: "New contract",
    summary: "New contract signed", source: "Example", publishedAt: time - 60_000, firstSeenAt: time,
    inputCutoff: time, baseline: null, targetClose: 0, state: "new" };
  const store: ShadowStore = {
    async claim() { log.push("claim"); return { runId: "run", day: row.day, slot: 8, startedAt: time }; },
    async permit() { return true; },
    async inputs() { return { day: { day: row.day, symbols: ["AAPL"], baseline: null, baselineCount: 0, baselineCutoff: time },
      held: [{ ticker: "AAPL_US_EQ", generation: "held", thesis: "", openedAt: time - 86_400_000, observedAt: time }],
      cursors: [{ ticker: "AAPL", through: time - 900_000 }], positionStateAvailable: false, reason: "position-state-unavailable" }; },
    async finish(_lease, status, reason, quotes) { log.push(`finish:${status}:${reason}:${quotes?.length ?? 0}`); },
    async ingest(_lease, _ticker, _through, _truncated, evidence) { log.push("ingest"); assert.equal(evidence[0].eligible, true); return [row._id]; },
    async attempt() { log.push("attempt"); return { ...row, inputCutoff: time }; },
    async prediction(_lease, _id, _attempt, data) { log.push(`commit:${data.probability}`); row.probability = data.probability ?? undefined;
      return data.probability === null ? null : { committedAt: time, session: { day: "2026-11-12", open: Date.parse("2026-11-12T14:30Z"), close: Date.parse("2026-11-12T21:00Z") } }; },
    async attachStart(_lease, _id, pair) { log.push(pair ? "start" : "no-start"); assert.ok(!pair || pair.stock.at >= row.inputCutoff); return true; },
    async due() { return []; }, async score() { log.push("score"); return true; }, async report() { return { events: [], runs: [], truncated: false }; },
  };
  const jev = { async ask(_state: unknown, questions: Record<string, { type: string }>) {
    log.push("model"); const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === "noul" ?
      { type: "noul", noul: 0.8 } : { type: "choice", choice: "news-catalyst", confidence: 0.9, probabilities: {} }]));
    return { model: "test", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  } } as JevClient;
  const deps: ShadowDeps = { store, forecastsEnabled: true, now: () => time, sleep: async (ms) => { time += ms; }, jev,
    news: { async getCompanyNews() { log.push("news"); return [{ headline: row.headline, summary: row.summary, source: row.source,
      datetime: row.publishedAt / 1_000, url: "https://example.test/news", related: "AAPL" }]; },
      async getQuote(symbol) { log.push(`quote:${symbol}`); time += 1_000; return { symbol, price: 100, prevClose: 99, changePct: 1, timestamp: time }; } },
    bars: async () => [],
  };
  return { store, deps, log, row };
}
test("news run commits before any starting quote, with no agent or live write capability", async () => {
  const r = rig();
  await runShadow("news", "demo", "owner", () => r.deps, r.store);
  assert.deepEqual(r.log.slice(0, 9), ["claim", "news", "ingest", "attempt", "model", "model", "commit:0.8", "quote:AAPL", "quote:SPY"]);
  assert.ok(r.log.includes("start"));
  assert.match(r.log.at(-1)!, /^finish:completed:/);
});
test("unavailable forecast persists abstention and never fetches a starting price", async () => {
  const r = rig(); r.deps.jev = { async ask() { throw new Error("unavailable"); } };
  await runShadow("news", "demo", "owner", () => r.deps, r.store);
  assert.ok(r.log.includes("commit:null")); assert.equal(r.log.some((s) => s.startsWith("quote:")), false);
});
test("news ingestion works independently while forecast mode is off", async () => {
  const r = rig(); r.deps.forecastsEnabled = false;
  await runShadow("news", "demo", "owner", () => r.deps, r.store);
  assert.ok(r.log.includes("ingest")); assert.equal(r.log.includes("model"), false);
  assert.match(r.log.at(-1)!, /unattempted=1/);
});
test("429 stops the run after one physical fetch; no feed retry, model, or cursor advance", async () => {
  const r = rig(); let calls = 0;
  r.deps.news = shadowFinnhub(r.store, { env: "demo", runId: "run", owner: "owner" }, "secret",
    async () => { calls++; return new Response("secret response body", { status: 429, headers: { "retry-after": "0" } }); });
  assert.equal(await runShadow("news", "demo", "owner", () => r.deps, r.store), "shadow-finnhub-429");
  assert.equal(calls, 1); assert.deepEqual(r.log, ["claim", "finish:failed:shadow-finnhub-429:0"]);
});
test("positions collect quotes and report unavailable state without simulating exits", async () => {
  const r = rig();
  assert.equal(await runShadow("positions", "demo", "owner", () => r.deps, r.store), "position-state-unavailable");
  assert.deepEqual(r.log, ["claim", "quote:AAPL", "finish:skipped:position-state-unavailable:1"]);
});
test("missing outcome bars remain pending and never become a scored zero", async () => {
  const r = rig(); r.row.probability = 0.8;
  r.row.start = { stock: { symbol: "AAPL", price: 100, at: r.row.firstSeenAt }, proxy: { symbol: "SPY", price: 500, at: r.row.firstSeenAt },
    sessionDay: "2026-11-12", sessionOpen: Date.parse("2026-11-12T14:30Z"), sessionClose: Date.parse("2026-11-12T21:00Z") };
  r.store.due = async () => [r.row];
  assert.equal(await runShadow("score", "demo", "owner", () => r.deps, r.store), "outcome-data-pending");
  assert.equal(r.log.includes("score"), false);
});
test("durable budget denial prevents the physical provider request", async () => {
  const r = rig(); r.store.permit = async () => false;
  let calls = 0; const fetchImpl: typeof fetch = async () => { calls++; return new Response("[]"); };
  const lease = { env: "demo" as const, runId: "run", owner: "owner" };
  await assert.rejects(shadowFinnhub(r.store, lease, "secret", fetchImpl).getQuote("AAPL"), ShadowBudgetError);
  await assert.rejects(adjustedBars(r.store, lease, "secret", "AAPL", "2026-11-11", "2026-11-12", fetchImpl), ShadowBudgetError);
  assert.equal(calls, 0);
});
test("Finnhub timestamps are optional for old consumers, mandatory in shadow pairs", async () => {
  const body = { c: 100, pc: 99, dp: 1 };
  const provider = new FinnhubProvider({ apiKey: "secret", fetchImpl: async () => new Response(JSON.stringify(body)) });
  assert.deepEqual(await provider.getQuote("AAPL"), { symbol: "AAPL", price: 100, prevClose: 99, changePct: 1 });
  const stamped = new FinnhubProvider({ apiKey: "secret", fetchImpl: async () => new Response(JSON.stringify({ ...body, t: 1_794_412_800 })) });
  assert.equal((await stamped.getQuote("AAPL")).timestamp, 1_794_412_800_000);
});
test("shadow facade routes only shadow function names and preserves authentication", async () => {
  const calls: string[] = [];
  const client: ConvexLike = { async query(ref, args) { calls.push(getFunctionName(ref)); assert.equal(args.token, "secret"); return {}; },
    async mutation(ref, args) { calls.push(getFunctionName(ref)); assert.equal(args.token, "secret"); return {}; } };
  const store = new Memory(client, "secret").shadowStore();
  await store.claim("demo", "news", "owner"); await store.report("demo", "2026-11-11");
  assert.deepEqual(calls, ["shadow:claim", "shadow:report"]);
});


test("screen outage leaves annotation absent but still makes a forecast", async () => {
  const r = rig(), original = r.deps.jev;
  let count = 0;
  r.deps.jev = { async ask(state, questions) {
    if (++count === 1) throw new Error("screen unavailable");
    return original.ask(state, questions);
  } };
  await runShadow("news", "demo", "owner", () => r.deps, r.store);
  assert.equal(count, 2); assert.ok(r.log.includes("commit:0.8")); assert.ok(r.log.includes("start"));
});
