import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { createReconciliationStore } from "./reconciliation-store.ts";
import { reconcileExecution } from "./reconcile-execution.ts";
import { classifyOrderEvidence, nextHistoryCursor } from "./order-evidence.ts";
import { reconciliationDiagnostic } from "./reconciliation-diagnostics.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".js"]) if (existsSync(new URL(base.href + ext))) return next(base.href + ext, context);
  }
  return next(specifier, context);
} });
const root = new URL("../../convex/", import.meta.url);
const schema = (await import(new URL("schema.ts", root).href)).default;
const api = anyApi.executionCoordination, reconciliation = anyApi.executionReconciliation;
const identity = { env: "demo" as const, account: "test-account", owner: "reconcile/test" };
const token = "reconciliation-test-only";
const expected = { operationId: "opaque", brokerOrderId: 123, ticker: "AAPL_US_EQ", quantity: -1, startedAt: Date.parse("2026-11-17T15:00:00Z") };
const order = { id: 123, instrument: { ticker: "AAPL_US_EQ" }, quantity: 1, side: "SELL", filledQuantity: 1, status: "FILLED", createdAt: "2026-11-17T15:00:00Z" };
const fill = { id: 456, quantity: 1, price: 100, type: "TRADE", filledAt: "2026-11-17T15:00:00Z" };
function setup(t: TestContext) {
  for (const [key, value] of Object.entries({ APP_SHARED_SECRET: token, EXECUTION_ACCOUNT_ID: identity.account, EXECUTION_COORDINATION_ENABLED: "true" })) {
    const old = process.env[key]; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }); process.env[key] = value;
  }
  let now = Date.parse("2026-11-17T15:00:00Z");
  t.mock.method(Date, "now", () => now);
  const db = convexTest(schema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./executionCoordination.ts": () => import(new URL("executionCoordination.ts", root).href),
    "./executionReconciliation.ts": () => import(new URL("executionReconciliation.ts", root).href),
  });
  const store = createReconciliationStore((namespace, name, args) => db.mutation(anyApi[namespace][name], { token, ...args }));
  async function seed(state: "pending" | "unknown" | "filled" | "sending" = "pending", acknowledged = true, quantity = -1) {
    const owner = { ...identity, owner: "root/turn", token };
    const lease = { ...owner, ...await db.mutation(api.claim, owner) };
    const op = await db.mutation(api.begin, { ...lease, key: "sell", kind: "write", ticker: expected.ticker, quantity, entryLimit: 4 });
    if (state !== "sending") await db.mutation(api.settle, { ...lease, operationId: op.operationId, outcome: state,
      ...(acknowledged ? { brokerOrderId: 123 } : {}) });
    now += 60_001;
    return op.operationId;
  }
  const config = { identity, store, apiKey: "fake-key", apiSecret: "fake-secret" };
  return { db, store, seed, config, setTime: (value: number) => { now = value; } };
}
const response = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });

test("read-only reconciliation authenticates and requires an acknowledged fenced order before any broker request", async t => {
  const { db, config, seed } = setup(t);
  let sends = 0;
  const fetchImpl: typeof fetch = async () => { sends++; return response([]); };
  await assert.rejects(reconcileExecution({ ...config, fetchImpl }), error => {
    assert.equal(reconciliationDiagnostic(error).status, "not-needed");
    assert.equal(reconciliationDiagnostic(error).exitCode, 0); return true;
  });
  await seed("unknown", false);
  await assert.rejects(db.mutation(reconciliation.claim, { ...identity, token: "wrong" }), /Unauthenticated/);
  await assert.rejects(db.mutation(reconciliation.claim, { ...identity, token, env: "live" }), /No fenced/);
  await assert.rejects(reconcileExecution({ ...config, fetchImpl }), error => {
    assert.equal(reconciliationDiagnostic(error).status, "manual-audit-required");
    assert.equal(reconciliationDiagnostic(error).exitCode, 2); return true;
  });
  assert.equal(sends, 0);
});

test("a sending POST can never be transferred to a reconciliation owner on timeout alone", async t => {
  const { seed, store } = setup(t);
  await seed("sending");
  await assert.rejects(store.claim(identity), /manual audit/);
});

test("GET evidence for a FILLED sell preserves residual quantity and never clears the original order fence", async t => {
  const { seed, config, db, store } = setup(t);
  const operationId = await seed("filled");
  const requests: string[] = [];
  const result = await reconcileExecution({ ...config, fetchImpl: async (url, init) => {
    assert.equal(init!.method, "GET"); requests.push(String(url));
    return response(String(url).includes("history") ? { items: [{ order, fill }], nextPagePath: null } :
      String(url).includes("portfolio") ? [{ ticker: expected.ticker, quantity: 0.25 }] : []);
  } });
  assert.equal(requests.length, 3);
  assert.equal(result.classification, "filled");
  assert.equal(result.positionQuantity, 0.25);
  assert.equal(result.canClearFence, false);
  const account = (await db.run(ctx => ctx.db.query("executionAccounts").take(1)))[0];
  assert.equal(account.activeWrite, operationId);
  assert.equal(account.activeReads.length, 0);
  assert.equal(account.owner, "");
  assert.equal((await db.run(ctx => ctx.db.get(operationId)))!.state, "filled");
  await assert.rejects(db.mutation(api.claim, { ...identity, token, owner: "next/turn" }), /busy/);
  await assert.rejects(store.claim(identity), /already completed/);
  assert.equal((await db.run(ctx => ctx.db.query("trades").take(1))).length, 0);
  assert.equal((await db.run(ctx => ctx.db.query("executionEvidence").take(2))).length, 1);
});

test("an empty complete history and flat portfolio are unknown, never proof of non-placement", async t => {
  const { seed, config } = setup(t); await seed("unknown");
  const result = await reconcileExecution({ ...config, fetchImpl: async url => response(String(url).includes("history") ? { items: [], nextPagePath: null } : []) });
  assert.equal(result.classification, "unknown"); assert.equal(result.reason, "not-found");
  assert.equal(result.positionQuantity, 0); assert.equal(result.canClearFence, false);
});

test("pending partial orders remain partial even if a later portfolio read is flat", async t => {
  const { seed, config } = setup(t); await seed();
  let requests = 0;
  const result = await reconcileExecution({ ...config, fetchImpl: async url => {
    requests++; assert.ok(!String(url).includes("history"));
    return response(String(url).includes("portfolio") ? [] : [{ ...order, status: "PARTIALLY_FILLED", filledQuantity: 0.5 }]);
  } });
  assert.equal(requests, 2); assert.equal(result.classification, "partial");
  assert.equal(result.filledQuantity, 0.5); assert.equal(result.canClearFence, false);
});

test("reconciliation observations never release a BUY's daily reservation", async t => {
  const { seed, config, db } = setup(t); await seed("filled", true, 1);
  const result = await reconcileExecution({ ...config, fetchImpl: async url => response(String(url).includes("history") ?
    { items: [{ order: { ...order, side: "BUY" }, fill }], nextPagePath: null } : []) });
  assert.equal(result.classification, "filled");
  assert.equal(result.canClearFence, false);
  const reservations = await db.run(ctx => ctx.db.query("executionEntries").take(2));
  assert.equal(reservations.length, 1); assert.equal(reservations[0].released, false);
});

test("GET rate-limit retries each consume another durable reconciliation admission", async t => {
  const { seed, config, db } = setup(t); await seed();
  let requests = 0;
  const result = await reconcileExecution({ ...config, fetchImpl: async url => {
    requests++;
    if (requests === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "0.001" } });
    return response(String(url).includes("history") ? { items: [], nextPagePath: null } : []);
  } });
  assert.equal(requests, 4); assert.equal(result.canClearFence, false);
  assert.equal((await db.run(ctx => ctx.db.query("executionEvidence").take(1)))[0].readRequests, 4);
});

test("history pagination is bounded and never follows a provider host or arbitrary path", async t => {
  for (const path of ["https://evil.invalid/steal", "//evil.invalid/steal", "/\\evil.invalid/api/v0/equity/history/orders?cursor=1", "/equity/portfolio?cursor=1",
    "/api/v0/equity/history/orders?cursor=1&ticker=OTHER_US_EQ", "/api/v0/equity/history/orders?cursor=1&cursor=2"]) {
    assert.equal(nextHistoryCursor(path, expected.ticker), null);
  }
  const { seed, config } = setup(t); await seed();
  let pages = 0;
  const result = await reconcileExecution({ ...config, fetchImpl: async url => {
    if (String(url).includes("history")) { pages++; return response({ items: [], nextPagePath: `/api/v0/equity/history/orders?cursor=${pages}` }); }
    return response([]);
  } });
  assert.equal(pages, 3); assert.equal(result.historyComplete, false);
  assert.equal(result.reason, "history-incomplete"); assert.equal(result.canClearFence, false);
});

test("expired reconciliation GETs can be recovered but their late completion cannot affect the next reader", async t => {
  const { seed, store, db, setTime } = setup(t); const operationId = await seed();
  const { generation, operationId: target } = await store.claim(identity);
  const first = { ...identity, generation, operationId: target };
  const read = await store.begin({ ...first, kind: "portfolio" });
  setTime(Date.now() + 60_001);
  const nextIdentity = { ...identity, owner: "reconcile/next" };
  const claimed = await store.claim(nextIdentity);
  const next = { ...nextIdentity, generation: claimed.generation, operationId: claimed.operationId };
  const nextRead = await store.begin({ ...next, kind: "pending" });
  await assert.rejects(store.settle({ ...first, operationId: read.readId, outcome: "read-completed" }), /Stale/);
  const account = (await db.run(ctx => ctx.db.query("executionAccounts").take(1)))[0];
  assert.equal(account.activeWrite, operationId);
  assert.deepEqual(account.activeReads, [nextRead.readId]);
});

test("reconciliation admits only bounded reads, persists its budget and works while writes are drained", async t => {
  const { seed, db, store } = setup(t); await seed();
  await db.mutation(api.drain, { token, env: identity.env, account: identity.account, draining: true });
  const claimed = await store.claim(identity);
  const lease = { ...identity, generation: claimed.generation, operationId: claimed.operationId };
  await assert.rejects(db.mutation(reconciliation.begin, { ...lease, token, kind: "write" }), /Validator/);
  await assert.rejects(store.begin({ ...lease, kind: "history", cursor: -1 }), /cursor/);
  for (let n = 0; n < 8; n++) {
    const read = await store.begin({ ...lease, kind: "pending" });
    await assert.rejects(store.begin({ ...lease, kind: "portfolio" }), /read active/);
    await store.settle({ ...lease, operationId: read.readId, outcome: "read-completed" });
  }
  await assert.rejects(store.begin({ ...lease, kind: "portfolio" }), /budget/);
  assert.equal((await db.mutation(api.drain, { token, env: identity.env, account: identity.account, draining: true })).quiescent, false);
});

test("evidence cannot finish before reads or with stale/inconsistent fields; completed receipts are immutable on retry", async t => {
  const { seed, store, db } = setup(t); await seed();
  const claimed = await store.claim(identity);
  const lease = { ...identity, generation: claimed.generation, operationId: claimed.operationId };
  const evidence = { classification: "unknown" as const, historyComplete: false, matchedFillCount: 0, reason: "history-incomplete" as const };
  await assert.rejects(store.finish({ ...lease, observedAt: Date.now(), evidence }), /Invalid/);
  for (const kind of ["pending", "portfolio"] as const) {
    const read = await store.begin({ ...lease, kind });
    await store.settle({ ...lease, operationId: read.readId, outcome: "read-completed" });
  }
  await assert.rejects(store.finish({ ...lease, observedAt: Date.now() - 120_001, evidence }), /Invalid/);
  await assert.rejects(store.finish({ ...lease, observedAt: Date.now(), evidence: { ...evidence, classification: "filled", filledQuantity: 0 } }), /Inconsistent/);
  const first = await store.finish({ ...lease, observedAt: Date.now(), evidence });
  const repeated = await store.finish({ ...lease, observedAt: Date.now(), evidence: { ...evidence, positionQuantity: 123 } });
  assert.equal(first.receiptId, repeated.receiptId);
  assert.equal(repeated.canClearFence, false);
  assert.equal((await db.run(ctx => ctx.db.query("executionEvidence").take(1)))[0].evidence.positionQuantity, undefined);
});

test("provider failure and malformed bodies never release the order or leak response text", async t => {
  for (const variant of ["network", "body", "json", "status"] as const) await t.test(variant, async t => {
    const { seed, config, db } = setup(t); const operationId = await seed();
    await assert.rejects(reconcileExecution({ ...config, fetchImpl: async () => {
      if (variant === "network") throw new Error("private-key");
      if (variant === "body") return { ok: true, text: async () => { throw new Error("private-key"); } } as unknown as Response;
      return variant === "json" ? new Response("private-key{") : response({ private: "private-key" }, 500);
    } }), err => { assert.ok(err instanceof Error); assert.ok(!err.message.includes("private-key")); return true; });
    assert.equal((await db.run(ctx => ctx.db.query("executionAccounts").take(1)))[0].activeWrite, operationId);
  });
});

test("evidence parser refuses mismatched orders and conflicting fill IDs without inferring position closure", t => {
  t.mock.method(Date, "now", () => expected.startedAt + 60_000);
  for (const changed of [{ ...order, side: "BUY" }, { ...order, quantity: 2 }, { ...order, instrument: { ticker: "OTHER_US_EQ" } },
    { ...order, createdAt: "2026-11-16T15:00:00Z" }]) {
    assert.equal(classifyOrderEvidence(expected, [], [{ order: changed, fill }], true, []).classification, "unknown");
  }
  const conflicted = classifyOrderEvidence(expected, [], [{ order, fill }, { order, fill: { ...fill, price: 99 } }], true, []);
  assert.equal(conflicted.classification, "unknown");
  const duplicate = classifyOrderEvidence(expected, [], [{ order, fill }, { order, fill }], true, []);
  assert.equal(duplicate.classification, "filled"); assert.equal(duplicate.matchedFillCount, 1);
});
