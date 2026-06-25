import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Memory,
  memoryFromEnv,
  type ConvexLike,
  type TradeRecord,
} from "./memory.ts";

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

test("recordTrade issues a mutation with the trade args", async () => {
  const { client, calls } = fakeClient();
  await new Memory(client).recordTrade(trade);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, { ...trade });
});

test("recordCycle and saveRiskState are mutations; getRiskState/recallRecent are queries", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client);
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
  assert.deepEqual(calls[3].args, { env: "demo", cycleLimit: 3 });
});

test("memoryFromEnv throws when CONVEX_URL is unset", () => {
  const prev = process.env.CONVEX_URL;
  delete process.env.CONVEX_URL;
  try {
    assert.throws(() => memoryFromEnv(), /CONVEX_URL/);
  } finally {
    if (prev !== undefined) process.env.CONVEX_URL = prev;
  }
});

test("memoryFromEnv uses an injected client when provided", () => {
  const { client } = fakeClient();
  const m = memoryFromEnv(client);
  assert.ok(m instanceof Memory);
});
