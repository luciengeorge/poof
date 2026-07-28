import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Memory,
  memoryFromEnv,
  type ConvexLike,
  type TradeRecord,
} from "./memory.ts";

const TOKEN = "test-shared-secret";

function fakeClient() {
  const calls: { kind: "mutation" | "query"; args: Record<string, unknown> }[] =
    [];
  const client: ConvexLike = {
    async mutation(_ref, args) {
      calls.push({ kind: "mutation", args });
      return "id_1";
    },
    async query(_ref, args) {
      calls.push({ kind: "query", args });
      return { cycles: [], trades: [], riskState: null };
    },
  };
  return { client, calls };
}

const trade: TradeRecord = {
  env: "demo",
  ticker: "AAPL_US_EQ",
  side: "BUY",
  notional: 4,
  price: 100,
  quantity: 0.0395,
  dryRun: true,
  thesis: "test thesis",
  status: "dry-run",
};

test("recordTrade issues a mutation with the trade args and the token", async () => {
  const { client, calls } = fakeClient();
  await new Memory(client, TOKEN).recordTrade(trade);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, { token: TOKEN, ...trade });
});

test("recordCycle and saveRiskState are mutations; getRiskState/recallRecent are queries", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  await m.recordCycle({
    env: "demo",
    equity: 50,
    freeCash: 50,
    decision: "no-trade",
    rationale: "stale catalysts",
  });
  await m.saveRiskState({
    env: "demo",
    peakEquity: 50,
    dayStartEquity: 50,
    dayStartDate: "2026-06-25",
    consecutiveLossDays: 0,
    haltState: "none",
  });
  await m.getRiskState("demo");
  await m.recallRecent("demo", { cycleLimit: 3 });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["mutation", "mutation", "query", "query"],
  );
  assert.deepEqual(calls[3].args, { token: TOKEN, env: "demo", cycleLimit: 3 });
});

test("every Memory method includes the token in its args", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  await m.recordTrade(trade);
  await m.closeTrade({ tradeId: "t1", pnl: 1 });
  await m.openBuys("demo");
  await m.saveBenchmark({
    env: "demo",
    inceptionEquity: 50,
    inceptionSpyPrice: 500,
    inceptionDate: "2026-06-25",
  });
  await m.getBenchmark("demo");
  await m.saveLessons("demo", "lesson text");
  await m.getLessons("demo");
  await m.recordCycle({
    env: "demo",
    equity: 50,
    freeCash: 50,
    decision: "no-trade",
    rationale: "stale catalysts",
  });
  await m.saveRiskState({
    env: "demo",
    peakEquity: 50,
    dayStartEquity: 50,
    dayStartDate: "2026-06-25",
    consecutiveLossDays: 0,
    haltState: "none",
  });
  await m.recordMessage({ env: "demo", role: "user", text: "hi" });
  await m.getRiskState("demo");
  await m.recallRecent("demo");
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.args.token, TOKEN);
  }
});

test("recordCronRun issues a mutation with the cron run args and the token", async () => {
  const { client, calls } = fakeClient();
  const cronRun = {
    schedule: "cycle",
    firedAt: 123,
    marketOpen: true,
    dispatched: true,
  };
  await new Memory(client, TOKEN).recordCronRun(cronRun);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, { token: TOKEN, ...cronRun });
});

test("latestCronRun issues a query with the token and schedule", async () => {
  const { client, calls } = fakeClient();
  await new Memory(client, TOKEN).latestCronRun("scorecard");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "query");
  assert.deepEqual(calls[0].args, { token: TOKEN, schedule: "scorecard" });
});

test("recordOrderIntent issues a mutation; hasOrderIntent issues a query returning a boolean", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  await m.recordOrderIntent("live", "2026-07-15:AAPL_US_EQ:BUY:500");
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, {
    token: TOKEN,
    env: "live",
    key: "2026-07-15:AAPL_US_EQ:BUY:500",
  });

  client.query = async () => true;
  const result = await m.hasOrderIntent("live", "2026-07-15:AAPL_US_EQ:BUY:500");
  assert.equal(result, true);
});

test("external-holding methods carry the token; list returns [] when memory is empty", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  const holding = {
    env: "live" as const,
    ticker: "SHOP",
    shares: 83.03770915,
    costBasisGbp: 9982.65,
    currency: "USD",
    accountLabel: "external brokerage",
    taxable: true,
    intent: "exit" as const,
  };
  await m.upsertExternalHolding(holding);
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, { token: TOKEN, ...holding });

  await m.removeExternalHolding("live", "SHOP");
  assert.equal(calls[1].kind, "mutation");
  assert.deepEqual(calls[1].args, {
    token: TOKEN,
    env: "live",
    ticker: "SHOP",
  });

  // A null/absent result must degrade to an empty list, not blow up the advisory step.
  client.query = async () => null;
  assert.deepEqual(await m.listExternalHoldings("live"), []);
});

test("memoryFromEnv throws when CONVEX_URL is unset", () => {
  const prevUrl = process.env.CONVEX_URL;
  const prevSecret = process.env.CONVEX_APP_SECRET;
  delete process.env.CONVEX_URL;
  process.env.CONVEX_APP_SECRET = TOKEN;
  try {
    assert.throws(() => memoryFromEnv(), /CONVEX_URL/);
  } finally {
    if (prevUrl !== undefined) process.env.CONVEX_URL = prevUrl;
    else delete process.env.CONVEX_URL;
    if (prevSecret !== undefined) process.env.CONVEX_APP_SECRET = prevSecret;
    else delete process.env.CONVEX_APP_SECRET;
  }
});

test("memoryFromEnv throws when CONVEX_APP_SECRET is unset", () => {
  const prevSecret = process.env.CONVEX_APP_SECRET;
  delete process.env.CONVEX_APP_SECRET;
  try {
    assert.throws(() => memoryFromEnv(), /CONVEX_APP_SECRET/);
  } finally {
    if (prevSecret !== undefined) process.env.CONVEX_APP_SECRET = prevSecret;
    else delete process.env.CONVEX_APP_SECRET;
  }
});

test("memoryFromEnv uses an injected client when provided", () => {
  const prevSecret = process.env.CONVEX_APP_SECRET;
  process.env.CONVEX_APP_SECRET = TOKEN;
  try {
    const { client } = fakeClient();
    const m = memoryFromEnv(client);
    assert.ok(m instanceof Memory);
  } finally {
    if (prevSecret !== undefined) process.env.CONVEX_APP_SECRET = prevSecret;
    else delete process.env.CONVEX_APP_SECRET;
  }
});
