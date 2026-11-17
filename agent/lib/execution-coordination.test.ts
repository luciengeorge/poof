import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { createExecutionStore } from "./execution-store.ts";
import { runExecutionScope, withExecutionContext } from "./execution-context.ts";
import { T212Client, T212Error } from "./t212.ts";
import { Memory } from "./memory.ts";
import ownerHook from "../hooks/execution-owner.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".js"]) if (existsSync(new URL(base.href + ext))) return next(base.href + ext, context);
  }
  return next(specifier, context);
} });
const root = new URL("../../convex/", import.meta.url);
const schema = (await import(new URL("schema.ts", root).href)).default;
const { researchDay, researchSession } = await import(new URL("shadowCalendar.ts", root).href);
const { executionSessionOpen } = await import(new URL("executionCalendar.ts", root).href);
const api = anyApi.executionCoordination;
const accountIdentity = { token: "execution-test-only", env: "demo" as const, account: "test-account" };
const identity = { ...accountIdentity, owner: "session/turn" };

function setup(t: TestContext) {
  for (const [key, value] of Object.entries({ APP_SHARED_SECRET: identity.token,
    EXECUTION_COORDINATION_ENABLED: "true", EXECUTION_ACCOUNT_ID: identity.account, DRY_RUN: "false",
    TRADING_MAX_NEW_POSITIONS_PER_DAY: "4" })) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = value;
  }
  let now = Date.parse("2026-11-17T15:00:00Z");
  t.mock.method(Date, "now", () => now);
  const db = convexTest(schema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./executionCoordination.ts": () => import(new URL("executionCoordination.ts", root).href),
  });
  const store = createExecutionStore((name, args) => db.query(api[name], { token: identity.token, ...args }),
    (name, args) => db.mutation(api[name], { token: identity.token, ...args }));
  return { db, store, setTime: (value: number) => { now = value; },
    run: <T>(fn: () => T, callId = "call", owner = identity.owner) => runExecutionScope({
      identity: { ...identity, owner }, callId, store,
    }, fn) };
}
const read = { key: "read", kind: "read" as const, ticker: "", quantity: 0, entryLimit: 4 };
const write = { key: "write", kind: "write" as const, ticker: "AAPL_US_EQ", quantity: 1, entryLimit: 4 };
const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const order = { id: 123, ticker: write.ticker, quantity: 1, filledQuantity: 1, side: "BUY", status: "FILLED" };
function client(fetchImpl: typeof fetch) { return new T212Client({ apiKey: "fake", apiSecret: "fake", env: "demo", fetchImpl }); }

test("account claim authenticates, isolates environments and abandons expired GETs without accepting their late results", async t => {
  const { db, setTime } = setup(t);
  await assert.rejects(db.mutation(api.claim, { ...identity, token: "wrong" }), /Unauthenticated/);
  await assert.rejects(db.mutation(api.claim, { ...identity, account: "other" }), /unavailable/);
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  await assert.rejects(db.mutation(api.claim, { ...identity, owner: "other" }), /busy/);
  await db.mutation(api.claim, { ...identity, env: "live", owner: "other" });
  const active = await db.mutation(api.begin, { ...lease, ...read });
  setTime(Date.now() + 60_001);
  const next = { ...identity, owner: "other", ...await db.mutation(api.claim, { ...identity, owner: "other" }) };
  assert.ok(next.generation > lease.generation);
  assert.equal((await db.run(ctx => ctx.db.get(active.operationId)))!.state, "read-abandoned");
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write }), /Stale/);
  await assert.rejects(db.mutation(api.settle, { ...lease, operationId: active.operationId, outcome: "read-completed" }), /Stale/);
});

test("parallel same-owner reads block writes; drain permits settlement but blocks every new admission", async t => {
  const { db } = setup(t);
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  const reads = await Promise.all(["cash", "positions"].map(key => db.mutation(api.begin, { ...lease, ...read, key })));
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write }), /active/);
  assert.deepEqual(await db.mutation(api.drain, { ...accountIdentity, draining: true }), { quiescent: false });
  for (const item of reads) await db.mutation(api.settle, { ...lease, operationId: item.operationId, outcome: "read-completed" });
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write }), /Stale/);
  assert.deepEqual(await db.mutation(api.drain, { ...accountIdentity, draining: true }), { quiescent: true });
  assert.equal(await db.mutation(api.release, identity), true);
  await assert.rejects(db.mutation(api.claim, identity), /busy/);
  // Drain preparation and status work before the new mode is enabled; they do not fence legacy workers.
  process.env.EXECUTION_COORDINATION_ENABLED = "false";
  assert.equal((await db.query(api.status, accountIdentity)).draining, true);
  await assert.rejects(db.mutation(api.claim, identity), /unavailable/);
});

test("a GET that completes after expiry cannot return its stale result or clear the next owner's write", async t => {
  const { run, store, db, setTime } = setup(t);
  let started!: () => void, finish!: (response: Response) => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const responsePromise = new Promise<Response>(resolve => { finish = resolve; });
  const broker = client(async () => { started(); return responsePromise; });
  const oldRead = run(() => broker.getPendingOrders());
  const rejected = assert.rejects(oldRead, /Stale/);
  await startedPromise;
  setTime(Date.now() + 60_001);
  const nextIdentity = { ...identity, owner: "next/turn" };
  const lease = { ...nextIdentity, ...await store.claim(nextIdentity) };
  const nextWrite = await store.begin({ ...lease, ...write });
  finish(body([]));
  await rejected;
  const status = await db.query(api.status, accountIdentity);
  assert.equal(status.activeReads, 0);
  assert.equal(status.unresolvedWrite, true);
  assert.equal((await db.run(ctx => ctx.db.query("executionOperations").take(3))).find(op => op._id === nextWrite.operationId)!.state, "sending");
});

test("drain can recover a lost GET settlement after expiry while rejecting any late completion", async t => {
  const { db, setTime } = setup(t);
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  const active = await db.mutation(api.begin, { ...lease, ...read });
  await db.mutation(api.drain, { ...accountIdentity, draining: true });
  setTime(Date.now() + 60_001);
  assert.deepEqual(await db.mutation(api.drain, { ...accountIdentity, draining: true }), { quiescent: true });
  await assert.rejects(db.mutation(api.settle, { ...lease, operationId: active.operationId, outcome: "read-completed" }), /Stale/);
  await assert.rejects(db.mutation(api.claim, identity), /busy/);
});

test("account identity whitespace is normalized consistently for tool admission, backend auth and owner release", async t => {
  const { store, db } = setup(t);
  process.env.EXECUTION_ACCOUNT_ID = "  test-account\n";
  for (const [key, value] of Object.entries({ CONVEX_URL: "https://test.convex.cloud", CONVEX_APP_SECRET: identity.token, TRADING212_ENV: "demo" })) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    process.env[key] = value;
  }
  t.mock.method(Memory.prototype, "executionStore", () => store);
  const broker = client(async () => body([]));
  await withExecutionContext({ session: { id: "session", turn: { id: "turn" } }, callId: "normalized" }, () => broker.getPendingOrders());
  const release = ownerHook.events!["turn.settled"]!;
  await release({ data: { turnId: "turn" } } as Parameters<typeof release>[0],
    { session: { id: "session" } } as Parameters<typeof release>[1]);
  assert.equal((await db.query(api.status, accountIdentity)).leaseUntil, 0);
  process.env.EXECUTION_ACCOUNT_ID = " \n";
  await assert.rejects(db.mutation(api.claim, identity), /unavailable/);
});

test("all acknowledged, partial and unknown writes retain the account fence and entry reservation", async t => {
  for (const outcome of ["pending", "unknown", "filled"] as const) await t.test(outcome, async t => {
    const { db, setTime } = setup(t);
    const lease = { ...identity, ...await db.mutation(api.claim, identity) };
    const active = await db.mutation(api.begin, { ...lease, ...write });
    await db.mutation(api.settle, { ...lease, operationId: active.operationId, outcome, brokerOrderId: 123 });
    assert.equal(await db.mutation(api.release, identity), false);
    setTime(Date.now() + 600_000);
    await assert.rejects(db.mutation(api.claim, { ...identity, owner: "restart" }), /busy/);
    await assert.rejects(db.mutation(api.begin, { ...lease, ...write, key: "new", quantity: -1 }), /Stale/);
    await db.run(async ctx => assert.equal((await ctx.db.query("executionEntries").take(5))[0].released, false));
  });
});

test("only a definitive precision rejection allows one smaller same-direction replay", async t => {
  const { db } = setup(t);
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  const first = await db.mutation(api.begin, { ...lease, ...write, quantity: 1.234 });
  await db.mutation(api.settle, { ...lease, operationId: first.operationId, outcome: "rejected", retryableRejection: true });
  for (const quantity of [1.234, 2, -1]) await assert.rejects(db.mutation(api.begin, { ...lease, ...write, quantity }), /already/);
  const second = await db.mutation(api.begin, { ...lease, ...write, quantity: 1.23 });
  assert.equal(first.operationId, second.operationId);
  await db.mutation(api.settle, { ...lease, operationId: second.operationId, outcome: "rejected", retryableRejection: true });
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write, quantity: 1.2 }), /already/);
});

test("daily cap includes earlier serving-mode entries and concurrent callers cannot gain a second allowance", async t => {
  const { db } = setup(t);
  await db.run(async ctx => {
    for (let i = 0; i < 201; i++) await ctx.db.insert("trades", { env: "demo", ticker: "HISTORY_US_EQ", side: "BUY", notional: 100,
      price: 100, quantity: 1, dryRun: false, thesis: "test", status: "closed", createdAt: Date.now() - 48 * 3_600_000 });
    for (let i = 0; i < 3; i++) await ctx.db.insert("trades", { env: "demo", ticker: `OLD${i}_US_EQ`, side: "BUY", notional: 100,
      price: 100, quantity: 1, dryRun: false, thesis: "test", status: "closed", createdAt: Date.now() });
  });
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  const competing = await Promise.allSettled(["one", "two"].map(key => db.mutation(api.begin, { ...lease, ...write, key })));
  assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
  const first = competing.find(r => r.status === "fulfilled")! as PromiseFulfilledResult<{ operationId: string }>;
  await db.mutation(api.settle, { ...lease, operationId: first.value.operationId, outcome: "rejected" });
  // Proven rejection releases its reservation; an unresolved send does not.
  const next = await db.mutation(api.begin, { ...lease, ...write, key: "retry-new" });
  await db.mutation(api.settle, { ...lease, operationId: next.operationId, outcome: "unknown" });
  const reservations = await db.run(ctx => ctx.db.query("executionEntries").take(5));
  assert.equal(reservations.filter(r => !r.released).length, 1);
  // Simulate a later reconciler clearing the fence, without removing the durable reservation.
  // No public API in this slice can do this: it demonstrates the cap survives owner transfer.
  await db.run(async ctx => { const account = (await ctx.db.query("executionAccounts").take(1))[0];
    await ctx.db.patch(account._id, { activeWrite: undefined, owner: "", leaseUntil: 0 }); });
  const nextOwner = { ...identity, owner: "next-session" };
  const nextLease = { ...nextOwner, ...await db.mutation(api.claim, nextOwner) };
  await assert.rejects(db.mutation(api.begin, { ...nextLease, ...write, key: "fifth" }), /cap/);
});

test("an incomplete daily baseline cannot authorize a send", async t => {
  const { db } = setup(t);
  await db.run(async ctx => {
    for (let i = 0; i < 201; i++) await ctx.db.insert("trades", { env: "demo", ticker: "HISTORY_US_EQ", side: "BUY", notional: 100,
      price: 100, quantity: 1, dryRun: true, thesis: "test", status: "dry-run", createdAt: Date.now() });
  });
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write }), /baseline incomplete/);
  assert.equal((await db.query(api.status, accountIdentity)).unresolvedWrite, false);
});

test("the temporary all-BUY admission limit honors lower risk limits, freezes its basis and rejects unsupported increases", async t => {
  const { db } = setup(t);
  const lease = { ...identity, ...await db.mutation(api.claim, identity) };
  const admitted = await db.mutation(api.begin, { ...lease, ...write, entryLimit: 2 });
  await db.mutation(api.settle, { ...lease, operationId: admitted.operationId, outcome: "rejected" });
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write, key: "changed", entryLimit: 4 }), /policy changed/);
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write, key: "raised", entryLimit: 6 }), /Unsupported/);
  const day = await db.run(ctx => ctx.db.query("executionDays").take(1));
  assert.equal(day[0].entryLimit, 2);
  // Fixture a fully used two-slot baseline: the durable comparison must honor two,
  // not silently retain the old hard-coded four.
  await db.run(ctx => ctx.db.patch(day[0]._id, { baselineEntries: 2 }));
  await assert.rejects(db.mutation(api.begin, { ...lease, ...write, key: "exhausted", entryLimit: 2 }), /cap/);
});

test("the transport carries the application's resolved entry limit into the durable reservation", async t => {
  const { db, run } = setup(t);
  process.env.TRADING_MAX_NEW_POSITIONS_PER_DAY = "2";
  const broker = client(async () => body(order));
  await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: 1 })), /reconciliation/);
  assert.equal((await db.run(ctx => ctx.db.query("executionDays").take(1)))[0].entryLimit, 2);
});

test("stock and core dispatch respect distinct sessions, holidays, early closes and DST mismatch", () => {
  const open = (iso: string, ticker = "VUAGl_EQ") => executionSessionOpen(Date.parse(iso), ticker, researchSession(researchDay(Date.parse(iso))));
  assert.equal(open("2026-11-17T14:29:59Z", "AAPL_US_EQ"), false);
  assert.equal(open("2026-11-17T14:30:00Z", "AAPL_US_EQ"), true);
  assert.equal(open("2026-11-17T16:25:00Z"), false);
  assert.equal(open("2026-11-17T18:00:00Z", "AAPL_US_EQ"), true);
  assert.equal(open("2026-12-24T12:24:59Z"), true);
  assert.equal(open("2026-12-24T12:25:00Z"), false);
  assert.equal(open("2026-12-28T10:00:00Z"), false);
  assert.equal(open("2026-03-09T13:30:00Z", "AAPL_US_EQ"), true);
  assert.equal(open("2026-03-09T16:24:59Z"), true);
  assert.equal(open("2026-03-30T15:25:00Z"), false);
  assert.equal(open("2028-01-03T10:00:00Z"), false);
  assert.equal(open("2026-11-27T18:00:00Z", "AAPL_US_EQ"), false);
});

test("physical transport sends nothing without verified ownership, including SELLs", async t => {
  const { run, store } = setup(t);
  let sends = 0;
  const broker = client(async () => { sends++; return body(order); });
  await assert.rejects(broker.placeMarketOrder({ ticker: write.ticker, quantity: -1 }), /trusted/);
  for (const method of ["claim", "begin"] as const) {
    const stub = t.mock.method(store, method, async () => { throw new Error("store unavailable"); });
    for (const quantity of [-1, 1]) await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity })), /unavailable/);
    stub.mock.restore();
  }
  // An invalid nested/child context must clear an inherited root scope.
  await assert.rejects(run(() => withExecutionContext(undefined, () => broker.getPendingOrders())), /trusted/);
  await assert.rejects(run(() => withExecutionContext({ session: { id: "child", turn: { id: "turn" }, parent: {} }, callId: "child-call" },
    () => broker.placeMarketOrder({ ticker: write.ticker, quantity: -1 }))), /trusted/);
  process.env.DRY_RUN = "true";
  await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: -1 })), /DRY_RUN/);
  assert.equal(sends, 0);
});

test("ambiguous, malformed and acknowledged responses never replay POST or report completed bookkeeping", async t => {
  for (const variant of ["429", "network", "body", "invalid-json", "partial", "pending", "filled"] as const) await t.test(variant, async t => {
    const { run, db } = setup(t);
    let sends = 0;
    const broker = client(async () => {
      sends++;
      if (variant === "network") throw new Error("private network failure");
      if (variant === "body") return { ok: false, status: 429, headers: new Headers(), text: async () => { throw new Error("private body failure"); } } as unknown as Response;
      if (variant === "invalid-json") return new Response("{private");
      if (variant === "429") return body({ private: true }, 429);
      return body({ ...order, ...(variant === "partial" ? { status: "PARTIALLY_FILLED", filledQuantity: 0.5 } :
        variant === "pending" ? { status: "NEW", filledQuantity: 0 } : {}) });
    });
    await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: 1 })), /reconciliation/);
    await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: 1 })), /active/);
    assert.equal(sends, 1);
    assert.equal((await db.query(api.status, accountIdentity)).unresolvedWrite, true);
    await db.run(async ctx => {
      assert.equal((await ctx.db.query("trades").take(1)).length, 0);
      assert.equal((await ctx.db.query("cycles").take(1)).length, 0);
    });
  });
});

test("GET rate-limit retries each require renewed admission; ownership failure during backoff stops the next fetch", async t => {
  const { run, store, db } = setup(t);
  let sends = 0, claims = 0;
  const claim = store.claim;
  store.claim = async args => { claims++; if (claims === 2) throw new Error("owner lost"); return claim(args); };
  const broker = client(async () => { sends++; return new Response("{}", { status: 429, headers: { "Retry-After": "0.001" } }); });
  await assert.rejects(run(() => broker.getPendingOrders()), /owner lost/);
  assert.equal(sends, 1);
  assert.equal(claims, 2);
});

test("a definitive rejection is recorded before a precision retry can send", async t => {
  const { run, db } = setup(t);
  let sends = 0;
  const broker = client(async () => { sends++; return sends === 1 ? body({ detail: "invalid quantity precision 2" }, 400) : body({ ...order, quantity: 1.23, filledQuantity: 1.23 }); });
  await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: 1.234 })), T212Error);
  await assert.rejects(run(() => broker.placeMarketOrder({ ticker: write.ticker, quantity: 1.23 })), /reconciliation/);
  assert.equal(sends, 2);
  const operations = await db.run(ctx => ctx.db.query("executionOperations").take(5));
  assert.equal(operations.length, 1);
  assert.equal(operations[0].attempt, 2);
});

test("a pause across lease expiry or the core cutoff proves non-send and releases its reservation", async t => {
  for (const variant of ["expired", "core-close"] as const) await t.test(variant, async t => {
    const { run, store, db, setTime } = setup(t);
    if (variant === "core-close") setTime(Date.parse("2026-11-17T16:24:59Z"));
    const begin = store.begin;
    store.begin = async args => {
      const admitted = await begin(args);
      setTime(Date.now() + (variant === "expired" ? 60_001 : 1_000));
      return admitted;
    };
    let sends = 0;
    const broker = client(async () => { sends++; return body(order); });
    await assert.rejects(run(() => broker.placeMarketOrder({ ticker: variant === "expired" ? write.ticker : "VUAGl_EQ", quantity: 1 })), /not sent/);
    assert.equal(sends, 0);
    assert.equal((await db.query(api.status, accountIdentity)).unresolvedWrite, false);
    assert.equal(await store.release(identity), true);
  });
});
