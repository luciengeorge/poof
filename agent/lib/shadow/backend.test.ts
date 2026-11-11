import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";

// Convex uses bundler-style extensionless imports. Resolve only that tree for Node's test runner.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".js"]) if (existsSync(new URL(base.href + ext))) return next(base.href + ext, context);
  }
  return next(specifier, context);
} });
const root = new URL("../../../convex/", import.meta.url);
const schema = (await import(new URL("schema.ts", root).href)).default;
const component = new URL("./", import.meta.resolve("@convex-dev/rate-limiter/convex.config.js"));
const componentSchema = (await import(new URL("schema.js", component).href)).default;
const api = anyApi.shadow;
const token = "shadow-test-secret";
function setup(t: TestContext) {
  const saved = { ...process.env };
  t.after(() => { for (const name of ["APP_SHARED_SECRET", "SHADOW_RESEARCH_ENABLED", "SHADOW_FEED_QUOTAS_VERIFIED"]) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  } });
  t.mock.method(Date, "now", () => Date.parse("2026-11-11T16:30:00Z"));
  process.env.APP_SHARED_SECRET = token;
  process.env.SHADOW_RESEARCH_ENABLED = "true";
  process.env.SHADOW_FEED_QUOTAS_VERIFIED = "true";
  const db = convexTest(schema, { "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./shadow.ts": () => import(new URL("shadow.ts", root).href) });
  db.registerComponent("rateLimiter", componentSchema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", component).href),
    "./lib.js": () => import(new URL("lib.js", component).href),
  });
  return db;
}
test("backend defaults off, authenticates, and prevents duplicate or stale owners", async (t) => {
  const db = setup(t);
  const args = { token, env: "demo", kind: "news", owner: "worker-a" };
  await assert.rejects(db.mutation(api.claim, { ...args, token: "wrong" }), /Unauthenticated/);
  process.env.SHADOW_RESEARCH_ENABLED = "false";
  await assert.rejects(db.mutation(api.claim, args), /disabled/);
  process.env.SHADOW_RESEARCH_ENABLED = "true";
  const [a, b] = await Promise.all([db.mutation(api.claim, args), db.mutation(api.claim, { ...args, owner: "worker-b" })]);
  assert.equal([a, b].filter((x) => x.runId).length, 1);
  const winner = a.runId ? a : b;
  const lease = { token, env: "demo", runId: winner.runId, owner: a.runId ? "worker-a" : "worker-b" };
  await assert.rejects(db.mutation(api.inputs, { ...lease, owner: "stale" }), /lease/);
  const inputs = await db.mutation(api.inputs, lease);
  assert.equal(inputs.positionStateAvailable, false);
  assert.equal(await db.mutation(api.permit, { ...lease, provider: "finnhub" }), true);
  assert.equal(await db.mutation(api.permit, { ...lease, provider: "finnhub" }), true);
  assert.equal(await db.mutation(api.permit, { ...lease, provider: "finnhub" }), false);
  t.mock.method(Date, "now", () => Date.parse("2026-11-11T16:35:00Z"));
  await assert.rejects(db.mutation(api.finish, { ...lease, status: "completed", quotes: [], observations: [] }), /lease/);
});
test("news cursor commits with evidence, corrections cannot rewrite or reforecast, and probabilities are immutable", async (t) => {
  const db = setup(t);
  await db.run(async (ctx) => { await ctx.db.insert("shadowDays", { env: "demo", day: "2026-11-11", frozenAt: Date.now(),
    symbols: ["AAPL"], baseline: null, baselineCount: 0, baselineCutoff: Date.now() - 7_200_000 }); });
  const claim = await db.mutation(api.claim, { token, env: "demo", kind: "news", owner: "one" });
  const lease = { token, env: "demo", runId: claim.runId, owner: "one" };
  const item = { story: "story", url: "https://example.test/news", headline: "Original", summary: "Original evidence",
    source: "Example", publishedAt: Date.now() - 60_000, firstSeenAt: Date.now(), eligible: true };
  const batch = { ...lease, ticker: "AAPL", through: Date.now(), truncated: false, items: [item] };
  const ids = await db.mutation(api.ingest, batch);
  assert.equal(ids.length, 1);
  assert.deepEqual(await db.mutation(api.ingest, { ...batch, items: [{ ...item, headline: "Correction" }] }), []);
  const row = await db.mutation(api.attempt, { ...lease, eventId: ids[0], attemptId: "attempt" });
  assert.equal(row.headline, "Original"); assert.equal(row.versions, 2);
  const prediction = { ...lease, eventId: ids[0], attemptId: "attempt", probability: 0.8, model: "test", completedAt: Date.now() };
  const commit = await db.mutation(api.prediction, prediction);
  assert.equal(commit.session.day, "2026-11-12");
  assert.equal(await db.mutation(api.prediction, { ...prediction, probability: 0.1 }), null);
  const start = { stock: { symbol: "AAPL", price: 100, at: Date.now() - 1 }, proxy: { symbol: "SPY", price: 500, at: Date.now() },
    sessionOpen: commit.session.open, sessionClose: commit.session.close, sessionDay: commit.session.day };
  await assert.rejects(db.mutation(api.attachStart, { ...lease, eventId: ids[0], start }), /starting pair/);
  assert.equal(await db.mutation(api.attachStart, { ...lease, eventId: ids[0], start: { ...start, stock: { ...start.stock, at: Date.now() } } }), true);
  // A late invalid item rolls back the ENTIRE ingestion transaction, including preceding inserts/cursor.
  t.mock.method(Date, "now", () => batch.through + 1_000);
  await assert.rejects(db.mutation(api.ingest, { ...batch, through: Date.now(), items: [
    { ...item, story: "new", url: "https://example.test/new" },
    { ...item, story: "bad", headline: "x".repeat(501) },
  ] }), /Invalid/);
  const report = await db.query(api.report, { token, env: "demo", day: "2026-11-11" });
  assert.equal(report.events.length, 1); assert.equal(report.events[0].probability, 0.8);
  await db.run(async (ctx) => {
    const revisions = await ctx.db.query("shadowRevisions").collect();
    assert.equal(revisions.length, 1); assert.equal(revisions[0].headline, "Correction");
    const cursor = await ctx.db.query("shadowCursors").first(); assert.equal(cursor!.through, batch.through);
    assert.equal((await ctx.db.query("trades").collect()).length, 0);
    assert.equal((await ctx.db.query("cycles").collect()).length, 0);
    assert.equal((await ctx.db.query("riskState").collect()).length, 0);
  });
});
