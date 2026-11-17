import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { publishConfirmedSnapshot } from "./confirmed-snapshot.ts";
import type { BrokerAccountSnapshot } from "./t212.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".js"]) if (existsSync(new URL(base.href + ext))) return next(base.href + ext, context);
  }
  return next(specifier, context);
} });
const root = new URL("../../convex/", import.meta.url);
const schema = (await import(new URL("schema.ts", root).href)).default;
const api = anyApi.operationalEvidence;
const token = "evidence-test-only";
function database() {
  return convexTest(schema, {
    "./_generated/server.js": () => import(new URL("_generated/server.js", root).href),
    "./operationalEvidence.ts": () => import(new URL("operationalEvidence.ts", root).href),
  });
}
test("confirmed snapshots authenticate, preserve immutable quantities, isolate environments and never imply execution readiness", async t => {
  const old = process.env.APP_SHARED_SECRET;
  t.after(() => { if (old === undefined) delete process.env.APP_SHARED_SECRET; else process.env.APP_SHARED_SECRET = old; });
  process.env.APP_SHARED_SECRET = token;
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const db = database();
  const args = { token, env: "live", observedAt: now - 1_000,
    positions: [{ ticker: "AAPL_US_EQ", quantity: 0.75, averagePrice: 100, currentPrice: 110 }] };
  await assert.rejects(db.mutation(api.recordSnapshot, { ...args, token: "wrong" }), /Unauthenticated/);
  const id = await db.mutation(api.recordSnapshot, args);
  assert.equal(await db.mutation(api.recordSnapshot, { ...args, positions: [{ ...args.positions[0], quantity: 99 }] }), id);
  const stored = await db.run(ctx => ctx.db.get(id));
  assert.equal(stored!.positions[0].quantity, 0.75);
  assert.equal((await db.query(api.status, { token, env: "demo" })).snapshot, null);
  const result = await db.query(api.status, { token, env: "live" });
  assert.equal(result.snapshot.pendingOrders, "unverified");
  assert.equal(result.snapshot.executionEligible, false);
  assert.ok(!JSON.stringify(result).includes("AAPL"));
  await assert.rejects(db.mutation(api.recordSnapshot, { ...args, observedAt: now - 120_001 }), /Invalid/);
  await assert.rejects(db.mutation(api.recordSnapshot, { ...args, observedAt: now + 1 }), /Invalid/);
  await assert.rejects(db.mutation(api.recordSnapshot, { ...args, positions: [{ ...args.positions[0], quantity: -1 }] }), /Invalid/);
  await assert.rejects(db.mutation(api.recordSnapshot, { ...args, positions: [...args.positions, ...args.positions] }), /Invalid/);
});

test("ambient receipts are idempotent and isolated from trading memory, including reordered delivery", async t => {
  const old = process.env.APP_SHARED_SECRET;
  t.after(() => { if (old === undefined) delete process.env.APP_SHARED_SECRET; else process.env.APP_SHARED_SECRET = old; });
  process.env.APP_SHARED_SECRET = token;
  const db = database();
  const key = { token, env: "live", sessionId: "session", turnId: "turn" };
  await assert.rejects(db.mutation(api.recordAmbient, { ...key, token: "wrong", phase: "received" }), /Unauthenticated/);
  await db.mutation(api.recordAmbient, { ...key, phase: "settled", outcome: "completed" });
  assert.equal((await db.query(api.status, { token, env: "live" })).ambient.received, 0);
  await db.mutation(api.recordAmbient, { ...key, phase: "received" });
  await db.mutation(api.recordAmbient, { ...key, phase: "received" });
  const result = await db.query(api.status, { token, env: "live" });
  assert.equal(result.ambient.sampled, 1);
  assert.equal(result.ambient.received, 1);
  assert.equal(result.ambient.completed, 1);
  assert.equal((await db.query(api.status, { token, env: "demo" })).ambient.sampled, 0);
  await db.run(async ctx => {
    for (const table of ["messages", "cycleTraces", "cycles", "trades"] as const) {
      assert.equal((await ctx.db.query(table).take(1)).length, 0);
    }
  });
});

test("snapshot publisher uses the existing broker read, skips simulation and absorbs observer failure", async () => {
  const account = { positionsReadAt: 123, positions: [{ ticker: "AAPL_US_EQ", quantity: 0.5,
    averagePrice: 100, currentPrice: 105, privateExtra: "omit" }] } as unknown as BrokerAccountSnapshot;
  const calls: unknown[] = [];
  const writer = { recordConfirmedSnapshot: async (data: unknown) => { calls.push(data); } };
  await publishConfirmedSnapshot(account, "live", writer, true);
  assert.equal(calls.length, 0);
  await publishConfirmedSnapshot(account, "live", writer, false);
  assert.deepEqual(calls, [{ env: "live", observedAt: 123, positions: [{ ticker: "AAPL_US_EQ", quantity: 0.5, averagePrice: 100, currentPrice: 105 }] }]);
  await publishConfirmedSnapshot(account, "live", { recordConfirmedSnapshot: async () => { throw new Error("private"); } }, false);
});
