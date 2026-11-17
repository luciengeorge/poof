import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { createExecutionStore } from "./execution-store.ts";
import { createReconciliationStore } from "./reconciliation-store.ts";
import { createInventoryStore } from "./inventory-store.ts";
import { runExecutionScope } from "./execution-context.ts";
import { T212Client, T212Error } from "./t212.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".js"]) if (existsSync(new URL(base.href + ext))) return next(base.href + ext, context);
  }
  return next(specifier, context);
} });
const root = new URL("../../convex/", import.meta.url);
const schema = (await import(new URL("schema.ts", root).href)).default;
const api = anyApi.executionCoordination, recon = anyApi.executionReconciliation, inventory = anyApi.executionInventory;
const identity = { token: "resolution-test-only", env: "demo" as const, account: "12345" };
const ticker = "AAPL_US_EQ";
const now = Date.parse("2026-11-17T15:00:00Z");
const iso = new Date(now).toISOString();

interface Broker { info: unknown; pending: unknown[][]; portfolio: unknown[][]; history: unknown[]; order: Record<string, unknown> }
function brokerFetch(state: Broker, calls: string[]): typeof fetch {
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const next = (queue: unknown[][]) => queue.length > 1 ? queue.shift()! : queue[0];
  return (async (url: string | URL, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(String(url));
    const path = pathname.replace(/^\/api\/v0/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/equity/account/info") return json(state.info);
    if (path === "/equity/orders") return json(next(state.pending));
    if (path === "/equity/portfolio") return json(next(state.portfolio));
    if (path === "/equity/account/cash") return json({ free: 10, total: 110 });
    if (path === "/equity/orders/market") return json(state.order);
    if (path === "/equity/history/orders" && searchParams.get("ticker") === ticker && searchParams.get("limit") === "50")
      return json({ items: state.history, nextPagePath: null });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const held = (quantity: number) => ({ ticker, quantity, averagePrice: 100, currentPrice: 100 });
const historyRow = (status: string, filledQuantity: number, fillId?: number) => ({
  order: { id: 77, ticker, side: "BUY", quantity: 1, filledQuantity, status, createdAt: iso },
  ...(fillId ? { fill: { id: fillId, quantity: filledQuantity, price: 100, filledAt: iso, type: "TRADE",
    walletImpact: { currency: "GBP", realisedProfitLoss: null } } } : {}),
});
const filledBroker = (): Broker => ({ info: { id: 12345, currencyCode: "GBP" }, pending: [[]], portfolio: [[], [held(1)]],
  history: [historyRow("FILLED", 1, 501)], order: { id: 77, ticker, side: "BUY", quantity: 1, filledQuantity: 0, status: "NEW" } });

function setup(t: TestContext) {
  for (const [key, value] of Object.entries({ APP_SHARED_SECRET: identity.token, EXECUTION_COORDINATION_ENABLED: "true",
    EXECUTION_ACCOUNT_ID: identity.account, DRY_RUN: "false", TRADING_MAX_NEW_POSITIONS_PER_DAY: "4" })) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = value;
  }
  t.mock.method(Date, "now", () => now);
  const db = convexTest(schema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./executionCoordination.ts": () => import(new URL("executionCoordination.ts", root).href),
    "./executionReconciliation.ts": () => import(new URL("executionReconciliation.ts", root).href),
    "./executionInventory.ts": () => import(new URL("executionInventory.ts", root).href),
  });
  const store = createExecutionStore((name, args) => db.query(api[name], { token: identity.token, ...args }),
    (name, args) => db.mutation(api[name], { token: identity.token, ...args }));
  const reconciliation = createReconciliationStore((namespace, name, args) =>
    db.mutation(anyApi[namespace][name], { token: identity.token, ...args }));
  const inventoryStore = createInventoryStore((name, args) => db.query(inventory[name], { token: identity.token, ...args }),
    (name, args) => db.mutation(inventory[name], { token: identity.token, ...args }));
  const run = <T>(fn: () => Promise<T>, owner = "session/turn", callId = "call") => runExecutionScope({
    identity: { env: identity.env, account: identity.account, owner }, callId, store, reconciliation,
    inventory: inventoryStore, wait: async () => {} }, fn);
  const client = (state: Broker, calls: string[]) =>
    new T212Client({ apiKey: "fake", apiSecret: "fake", env: "demo", fetchImpl: brokerFetch(state, calls) });
  const accountRow = () => db.run(ctx => ctx.db.query("executionAccounts").first());
  const entries = () => db.run(ctx => ctx.db.query("executionEntries").collect());
  const generations = () => db.run(ctx => ctx.db.query("positionGenerations").collect());
  return { db, run, client, accountRow, entries, generations };
}

test("an acknowledged BUY is reconciled, booked and unfenced before the caller sees it; the slot stays consumed", async t => {
  const { run, client, accountRow, entries, generations } = setup(t);
  const calls: string[] = [];
  const state = filledBroker();
  const broker = client(state, calls);
  const order = await run(() => broker.placeMarketOrder({ ticker, quantity: 1 }));
  assert.equal(order.status, "FILLED");
  assert.equal(order.filledQuantity, 1);
  assert.deepEqual(calls.slice(0, 4), ["GET /equity/account/info", "GET /equity/orders", "GET /equity/portfolio", "POST /equity/orders/market"]);
  assert.equal((await accountRow())!.activeWrite, undefined);
  const [generation] = await generations();
  assert.equal(generation.quantity, 1);
  assert.equal(generation.origin, "reconciled-buy");
  assert.deepEqual((await entries()).map(e => e.released), [false]);
  // The account is usable again in the same scope.
  await run(() => broker.getCash({ fresh: true }));
  // A later tool call re-confirms inventory but not the (rate-limited) account identity.
  const before = calls.length;
  state.portfolio = [[held(1)], [held(2)]];
  state.order = { ...state.order, id: 78 };
  state.history = [{ ...historyRow("FILLED", 1, 502), order: { ...historyRow("FILLED", 1).order, id: 78 } }];
  await run(() => broker.placeMarketOrder({ ticker, quantity: 1 }), "session/turn", "call-2");
  assert.ok(!calls.slice(before).includes("GET /equity/account/info"));
  assert.ok(calls.slice(before).includes("GET /equity/orders"));
  assert.equal((await generations())[0].quantity, 2);
  assert.deepEqual((await entries()).map(e => e.released), [false, false]);
});

test("an accepted order that ends with no fill releases its fence and slot and surfaces as a broker rejection", async t => {
  const { run, client, accountRow, entries, generations } = setup(t);
  const state = { ...filledBroker(), portfolio: [[]], history: [historyRow("CANCELLED", 0)] };
  const calls: string[] = [];
  await assert.rejects(run(() => client(state, calls).placeMarketOrder({ ticker, quantity: 1 })),
    (e: unknown) => e instanceof T212Error && e.status === 400 && /without a fill/.test(e.body));
  assert.equal((await accountRow())!.activeWrite, undefined);
  assert.deepEqual((await entries()).map(e => e.released), [true]);
  assert.equal((await generations()).length, 0);
});

test("an unverified broker account or a pending broker order blocks the send entirely", async t => {
  const { run, client, accountRow } = setup(t);
  for (const state of [{ ...filledBroker(), info: { id: 99999, currencyCode: "GBP" } },
    { ...filledBroker(), info: { id: 12345, currencyCode: "USD" } },
    { ...filledBroker(), pending: [[{ id: 5 }]] }]) {
    const calls: string[] = [];
    await assert.rejects(run(() => client(state, calls).placeMarketOrder({ ticker, quantity: 1 })), /unverified|unavailable or stale/);
    assert.ok(!calls.includes("POST /equity/orders/market"));
  }
  assert.equal((await accountRow())!.activeWrite, undefined);
});

test("a still-pending order keeps the account fenced; a later fill is never auto-released outside the sending call", async t => {
  const { run, client, accountRow, generations } = setup(t);
  const state = { ...filledBroker(), pending: [[], [{ id: 77 }]], history: [] as unknown[] };
  const calls: string[] = [];
  await assert.rejects(run(() => client(state, calls).placeMarketOrder({ ticker, quantity: 1 })), /stays fenced/);
  assert.ok((await accountRow())!.activeWrite);
  // Fenced: a different owner cannot read the account until the order resolves.
  await assert.rejects(run(() => client(state, []).getCash({ fresh: true }), "session/next"), /stays fenced/);
  state.pending = [[]];
  state.history = [historyRow("FILLED", 1, 501)];
  state.portfolio = [[held(1)]];
  const later: string[] = [];
  await assert.rejects(run(() => client(state, later).getCash({ fresh: true }), "session/later"), /manual audit/);
  assert.ok(!later.includes("GET /equity/account/cash"));
  assert.ok((await accountRow())!.activeWrite);
  assert.equal((await generations()).length, 0);
});

test("a later zero-fill end is recovered automatically before the next scope's broker request", async t => {
  const { run, client, accountRow, entries } = setup(t);
  const state = { ...filledBroker(), pending: [[], [{ id: 77 }]], history: [] as unknown[] };
  await assert.rejects(run(() => client(state, []).placeMarketOrder({ ticker, quantity: 1 })), /stays fenced/);
  state.pending = [[]];
  state.history = [historyRow("CANCELLED", 0)];
  state.portfolio = [[]];
  const later: string[] = [];
  await run(() => client(state, later).getCash({ fresh: true }), "session/later");
  assert.equal(later.at(-1), "GET /equity/account/cash");
  assert.equal((await accountRow())!.activeWrite, undefined);
  assert.deepEqual((await entries()).map(e => e.released), [true]);
});

test("a terminal partial fill is never auto-released, even once booked; it needs manual audit", async t => {
  const { db, run, client, accountRow, generations } = setup(t);
  const state = { ...filledBroker(), portfolio: [[], [held(0.5)]], history: [historyRow("CANCELLED", 0.5, 501)] };
  await assert.rejects(run(() => client(state, []).placeMarketOrder({ ticker, quantity: 1 })), /stays fenced/);
  assert.ok((await accountRow())!.activeWrite);
  assert.equal((await generations()).length, 0);
  const evidence = await db.run(ctx => ctx.db.query("executionEvidence").first());
  assert.equal(evidence!.evidence.classification, "partial");
  await db.mutation(inventory.apply, { ...identity, evidenceId: evidence!._id });
  assert.equal((await generations())[0].quantity, 0.5);
  await assert.rejects(db.mutation(api.resolve, { ...identity, evidenceId: evidence!._id }), /not terminal/);
  assert.ok((await accountRow())!.activeWrite);
});

test("handoff only from the live sending owner; resolve refuses evidence that is not booked", async t => {
  const { db, run, client } = setup(t);
  const state = { ...filledBroker(), pending: [[], [{ id: 77 }]], history: [] as unknown[] };
  await assert.rejects(run(() => client(state, []).placeMarketOrder({ ticker, quantity: 1 })), /stays fenced/);
  await assert.rejects(db.mutation(recon.claim, { ...identity, owner: "reconcile/x", handoff: { owner: "session/other", generation: 1 } }),
    /Stale reconciliation handoff/);
  const evidence = await db.run(ctx => ctx.db.query("executionEvidence").first());
  await assert.rejects(db.mutation(api.resolve, { ...identity, evidenceId: evidence!._id }), /current reconciled evidence|not terminal/);
});
