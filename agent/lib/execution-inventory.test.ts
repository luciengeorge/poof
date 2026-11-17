import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";

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
const identity = { token: "inventory-test-only", env: "demo" as const, account: "inventory-test" };
const ticker = "AAPL_US_EQ";
const position = { ticker, quantity: 1, averagePrice: 100 };
const fill = (id: number, quantity: number, realizedPnlGbp: number, price = 110) =>
  ({ id, quantity, price, filledAt: Date.now(), walletCurrency: "GBP", realizedPnlGbp });
function setup(t: TestContext) {
  for (const [key, value] of Object.entries({ APP_SHARED_SECRET: identity.token, EXECUTION_ACCOUNT_ID: identity.account, EXECUTION_COORDINATION_ENABLED: "true" })) {
    const old = process.env[key]; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }); process.env[key] = value;
  }
  let now = Date.parse("2026-11-17T15:00:00Z"), serial = 0;
  t.mock.method(Date, "now", () => now);
  const db = convexTest(schema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./executionCoordination.ts": () => import(new URL("executionCoordination.ts", root).href),
    "./executionReconciliation.ts": () => import(new URL("executionReconciliation.ts", root).href),
    "./executionInventory.ts": () => import(new URL("executionInventory.ts", root).href),
  });
  const owner = { ...identity, owner: "root/turn" };
  const lease = async () => ({ ...owner, ...await db.mutation(api.claim, owner) });
  async function baseline(positions = [position]) {
    const current = await lease();
    return db.mutation(inventory.baseline, { ...current, positions, positionsReadAt: now, pendingReadAt: now, pendingCount: 0 });
  }
  async function order(quantity: number) {
    const current = await lease(); serial++;
    const op = await db.mutation(api.begin, { ...current, key: `order-${serial}`, kind: "write", ticker, quantity, entryLimit: 4 });
    await db.mutation(api.settle, { ...current, operationId: op.operationId, outcome: "pending", brokerOrderId: 1000 + serial });
    return { operationId: op.operationId, quantity };
  }
  async function evidence(target: { operationId: string; quantity: number }, filledQuantity: number, residual: number, fills: ReturnType<typeof fill>[], complete = true) {
    now += 60_001; serial++;
    const readOwner = { ...identity, owner: `reconcile/${serial}` };
    const claimed = await db.mutation(recon.claim, readOwner);
    assert.equal(claimed.operationId, target.operationId);
    const readLease = { ...readOwner, generation: claimed.generation, operationId: claimed.operationId };
    for (const kind of ["history", "portfolio"] as const) {
      const read = await db.mutation(recon.begin, { ...readLease, kind });
      await db.mutation(api.settle, { ...readOwner, generation: claimed.generation, operationId: read.readId, outcome: "read-completed" });
    }
    const receipt = await db.mutation(recon.finish, { ...readLease, observedAt: now, evidence: {
      classification: filledQuantity === 0 ? "rejected" : filledQuantity === Math.abs(target.quantity) ? "filled" : "partial",
      filledQuantity, positionQuantity: residual, matchedFillCount: fills.length, historyComplete: complete, reason: "matched-history",
    }, ...(complete ? { fills } : {}) });
    return receipt.receiptId;
  }
  // Fixture the later reviewed fence-clear protocol, which this slice DOES NOT implement.
  // This lets the generation tests model another order without inventing a public bypass.
  async function nextOrderFixture() {
    await db.run(async ctx => { const a = (await ctx.db.query("executionAccounts").take(1))[0];
      await ctx.db.patch(a._id, { activeWrite: undefined, owner: "", leaseUntil: 0 }); });
  }
  const apply = (evidenceId: string) => db.mutation(inventory.apply, { ...identity, evidenceId });
  const generations = () => db.run(ctx => ctx.db.query("positionGenerations").take(10));
  return { db, lease, baseline, order, evidence, apply, generations, nextOrderFixture, advance: (ms: number) => { now += ms; } };
}

test("broker baseline requires ownership, freshness and no pending orders; it never invents an opening date", async t => {
  const { db, lease, baseline, generations } = setup(t);
  const current = await lease();
  const args = { ...current, positions: [position], positionsReadAt: Date.now(), pendingReadAt: Date.now(), pendingCount: 0 };
  await assert.rejects(db.mutation(inventory.baseline, { ...args, token: "wrong" }), /Unauthenticated/);
  await assert.rejects(db.mutation(inventory.baseline, { ...args, owner: "other" }), /quiescent/);
  await assert.rejects(db.mutation(inventory.baseline, { ...args, pendingCount: 1 }), /unavailable/);
  await assert.rejects(db.mutation(inventory.baseline, { ...args, pendingReadAt: Date.now() - 120_001 }), /stale/);
  await assert.rejects(db.mutation(inventory.baseline, { ...args, positions: [position, position] }), /Invalid/);
  assert.equal((await baseline()).canDispatch, false);
  const rows = await generations(); assert.equal(rows.length, 1); assert.equal(rows[0].openedAt, undefined);
  assert.equal(rows[0].origin, "broker-baseline"); assert.equal(rows[0].quantity, 1);
  assert.equal((await db.query(inventory.positions, { ...identity, env: "live" })).positions.length, 0);
  await assert.rejects(db.mutation(inventory.baseline, { ...args, positions: [{ ...position, quantity: 2 }] }), /manual audit/);
  process.env.EXECUTION_COORDINATION_ENABLED = "false";
  await assert.rejects(db.mutation(inventory.baseline, args), /unavailable/);
  assert.equal((await db.query(inventory.positions, identity)).positions.length, 1);
});

test("a partial exit preserves its generation; only confirmed flat closes it, and same-day re-entry gets a new generation", async t => {
  const { db, baseline, order, evidence, apply, generations, nextOrderFixture } = setup(t); await baseline();
  const first = await order(-0.75); const a = fill(1, 0.75, 7.5);
  const receipt = await evidence(first, 0.75, 0.25, [a]);
  const concurrent = await Promise.all([apply(receipt), apply(receipt)]);
  assert.deepEqual(concurrent.map(r => r.appliedFills).sort(), [0, 1]);
  assert.ok(concurrent.every(r => r.canClearFence === false));
  const repeated = await apply(receipt); assert.equal(repeated.replayed, true); assert.equal(repeated.appliedFills, 0);
  let rows = await generations(); assert.equal(rows[0].quantity, 0.25); assert.equal(rows[0].status, "open"); assert.equal(rows[0].realizedPnlGbp, 7.5);
  assert.equal((await db.run(ctx => ctx.db.query("executionAccounts").take(1)))[0].activeWrite, first.operationId);
  await nextOrderFixture();
  const second = await order(-0.25); const b = fill(2, 0.25, 2.5);
  await apply(await evidence(second, 0.25, 0, [b]));
  rows = await generations(); assert.equal(rows[0].status, "closed"); assert.equal(rows[0].realizedPnlGbp, 10);
  const closedId = rows[0]._id;
  await nextOrderFixture();
  const third = await order(1); const c = fill(3, 1, 0, 120);
  await apply(await evidence(third, 1, 1, [c]));
  rows = await generations(); assert.equal(rows.length, 2);
  const latest = rows.find(g => g.generation === 2)!;
  assert.notEqual(latest._id, closedId); assert.equal(latest.quantity, 1); assert.equal(latest.realizedPnlGbp, 0);
  assert.equal(rows.find(g => g._id === closedId)!.realizedPnlGbp, 10);
  for (const table of ["trades", "cycles", "riskState", "messages"] as const)
    assert.equal((await db.run(ctx => ctx.db.query(table).take(1))).length, 0);
});

test("progressive partial fills apply only novel IDs and cannot reapply profit or roll a quantity back", async t => {
  const { db, baseline, order, evidence, apply, generations } = setup(t); await baseline();
  const target = await order(-1), a = fill(10, 0.4, 3);
  const first = await evidence(target, 0.4, 0.6, [a]); await apply(first);
  await assert.rejects(db.mutation(inventory.apply, { ...identity, evidenceId: first, fills: [{ ...a, price: 999 }] }), /Validator/);
  const b = fill(11, 0.6, 5); const second = await evidence(target, 1, 0, [b, a]);
  const result = await apply(second); assert.equal(result.appliedFills, 1);
  await apply(first);
  const row = (await generations())[0]; assert.equal(row.quantity, 0); assert.equal(row.status, "closed"); assert.equal(row.realizedPnlGbp, 8);
});

test("bookkeeping cannot infer an inventory baseline from a post-order snapshot", async t => {
  const { db, order, evidence, apply, generations } = setup(t);
  const target = await order(1), a = fill(20, 1, 0);
  const receipt = await evidence(target, 1, 1, [a]);
  await assert.rejects(apply(receipt), /fresh owned/);
  assert.equal((await generations()).length, 0);
  assert.equal((await db.run(ctx => ctx.db.query("reconciledFills").take(1))).length, 0);
});

test("a residual mismatch or incomplete history cannot change inventory or its order fence", async t => {
  const { db, baseline, order, evidence, apply, generations } = setup(t); await baseline();
  const target = await order(-0.5), a = fill(30, 0.5, 1);
  await assert.rejects(apply(await evidence(target, 0.5, 1, [a])), /residual/);
  await assert.rejects(apply(await evidence(target, 0.5, 0.5, [a], false)), /Sealed/);
  assert.equal((await generations())[0].quantity, 1);
  assert.equal((await db.run(ctx => ctx.db.query("reconciledFills").take(1))).length, 0);
  assert.equal((await db.run(ctx => ctx.db.query("executionAccounts").take(1)))[0].activeWrite, target.operationId);
});

test("BUY top-ups keep the generation and weighted basis; reused fill IDs across orders fail closed and reservations remain held", async t => {
  const { db, baseline, order, evidence, apply, generations, nextOrderFixture } = setup(t); await baseline();
  const first = await order(1), a = fill(40, 1, 0, 120);
  await apply(await evidence(first, 1, 2, [a]));
  let row = (await generations())[0]; assert.equal(row.generation, 1); assert.equal(row.quantity, 2); assert.equal(row.averagePrice, 110);
  const reservations = await db.run(ctx => ctx.db.query("executionEntries").take(2)); assert.equal(reservations[0].released, false);
  await nextOrderFixture();
  const second = await order(1);
  const reused = { ...a, filledAt: Date.now() };
  await assert.rejects(apply(await evidence(second, 1, 3, [reused])), /identity conflict/);
  row = (await generations())[0]; assert.equal(row.quantity, 2); assert.equal(row.averagePrice, 110);
});

test("a positive broker residual, however small, never closes the position generation", async t => {
  const { baseline, order, evidence, apply, generations } = setup(t); await baseline();
  const target = await order(-1), a = fill(50, 1, 1);
  await apply(await evidence(target, 1, 1e-10, [a]));
  const row = (await generations())[0]; assert.equal(row.status, "open"); assert.equal(row.quantity, 1e-10); assert.equal(row.closedAt, undefined);
});

test("fractional top-up refresh compares broker basis observations without replacing the fill-derived basis", async t => {
  const { baseline, order, evidence, apply, generations, nextOrderFixture } = setup(t); await baseline();
  const quantity = 0.333333333, residual = 1 + quantity, price = 120.1234567;
  const target = await order(quantity);
  await apply(await evidence(target, quantity, residual, [fill(80, quantity, 0, price)]));
  const computed = (100 + quantity * price) / residual;
  let row = (await generations())[0];
  assert.equal(row.averagePrice, computed); assert.equal(row.brokerAveragePrice, undefined);
  await nextOrderFixture();
  const broker = { ticker, quantity: residual, averagePrice: 105.0309 };
  assert.equal((await baseline([broker])).canDispatch, false);
  await baseline([broker]);
  row = (await generations())[0];
  assert.equal(row.averagePrice, computed); assert.equal(row.brokerAveragePrice, broker.averagePrice);
  assert.equal(row.generation, 1); assert.equal(row.realizedPnlGbp, 0); assert.equal(row.openedAt, undefined);
  await assert.rejects(baseline([{ ...broker, quantity: residual + 1e-10 }]), /manual audit/);
  await assert.rejects(baseline([{ ...broker, averagePrice: broker.averagePrice + 1 }]), /manual audit/);
  assert.deepEqual((await generations())[0], row);
});

test("a new BUY's rounded broker basis is confirmed separately and survives a partial SELL", async t => {
  const { baseline, order, evidence, apply, generations, nextOrderFixture } = setup(t); await baseline([]);
  const target = await order(0.3), price = 101.123456;
  await apply(await evidence(target, 0.3, 0.3, [fill(90, 0.3, 0, price)]));
  await nextOrderFixture();
  const broker = { ticker, quantity: 0.3, averagePrice: 101.1235 };
  await baseline([broker]);
  let row = (await generations())[0];
  assert.equal(row.origin, "reconciled-buy"); assert.equal(row.averagePrice, price);
  assert.equal(row.brokerAveragePrice, broker.averagePrice);
  const sell = await order(-0.1);
  await apply(await evidence(sell, 0.1, 0.2, [fill(91, 0.1, 1)]));
  await nextOrderFixture();
  await baseline([{ ...broker, quantity: 0.2 }]);
  row = (await generations())[0];
  assert.equal(row.status, "open"); assert.equal(row.generation, 1); assert.equal(row.quantity, 0.2);
  assert.equal(row.averagePrice, price); assert.equal(row.brokerAveragePrice, broker.averagePrice);
  assert.equal(row.realizedPnlGbp, 1);
});

test("realized loss uses the broker's GBP amount rather than a guessed native-price conversion", async t => {
  const { baseline, order, evidence, apply, generations } = setup(t); await baseline();
  const target = await order(-1), a = fill(60, 1, -7, 90);
  await apply(await evidence(target, 1, 0, [a]));
  const row = (await generations())[0]; assert.equal(row.realizedPnlGbp, -7);
  assert.equal(row.instrumentCurrency, "USD"); assert.equal(row.averagePrice, 100); assert.equal(row.status, "closed");
});

test("foreign currency, duplicate fills, synthetic BUY profit and stale evidence cannot alter the ledger", async t => {
  const { db, baseline, order, evidence, apply, generations, advance } = setup(t); await baseline();
  const target = await order(1), a = fill(70, 1, 0);
  await assert.rejects(evidence(target, 1, 2, [{ ...a, walletCurrency: "USD" }]), /Validator/);
  await assert.rejects(evidence(target, 1, 2, [a, a]), /Incomplete|Invalid/);
  await assert.rejects(evidence(target, 1, 2, [{ ...a, realizedPnlGbp: 1 }]), /Invalid/);
  const receipt = await evidence(target, 1, 2, [a]);
  advance(120_001);
  await assert.rejects(apply(receipt), /fresh owned/);
  assert.equal((await generations())[0].quantity, 1);
  assert.equal((await db.run(ctx => ctx.db.query("reconciledFills").take(1))).length, 0);
});
