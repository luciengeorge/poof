import { test } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
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

test("closedBuys issues a query to memory:closedBuys with the token and env", async () => {
  // Records the function name too: the shared fake ignores the ref, so a facade pointing at a
  // misspelt function would pass there and fail only against a real deployment.
  const calls: { kind: "mutation" | "query"; name: string; args: Record<string, unknown> }[] = [];
  const client: ConvexLike = {
    async mutation(ref, args) {
      calls.push({ kind: "mutation", name: getFunctionName(ref), args });
      return null;
    },
    async query(ref, args) {
      calls.push({ kind: "query", name: getFunctionName(ref), args });
      return [];
    },
  };
  await new Memory(client, TOKEN).closedBuys("live");
  assert.deepEqual(calls, [
    { kind: "query", name: "memory:closedBuys", args: { token: TOKEN, env: "live", limit: undefined } },
  ]);
});

test("recordCycle and saveRiskState are mutations; getRiskState/recallRecent are queries", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  await m.recordCycle({
    env: "demo",
    equity: 50,
    freeCash: 50,
    fxRate: 0.75094,
    fxSource: "live",
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
  await m.closedBuys("demo");
  await m.saveBenchmark({
    env: "demo",
    inceptionEquity: 50,
    inceptionSpyPrice: 500,
    inceptionDate: "2026-06-25",
  });
  await m.overwriteBenchmark({
    env: "demo",
    inceptionEquity: 252.17,
    inceptionSpyPrice: 754.81,
    inceptionDate: "2026-07-15",
  });
  await m.getBenchmark("demo");
  await m.saveLessons("demo", "lesson text");
  await m.getLessons("demo");
  await m.recordCycle({
    env: "demo",
    equity: 50,
    freeCash: 50,
    fxRate: 0.75094,
    fxSource: "live",
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

test("recordCoreOrder issues a mutation carrying the token and the whole row", async () => {
  const { client, calls } = fakeClient();
  const row = {
    env: "live" as const,
    action: "sweep" as const,
    status: "placed",
    quantity: 1.5,
    priceGbp: 100,
    notionalGbp: 150,
    dryRun: false,
    detail: "swept",
    orderId: 42,
  };
  await new Memory(client, TOKEN).recordCoreOrder(row);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "mutation");
  assert.deepEqual(calls[0].args, { token: TOKEN, ...row });
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

test("cycle-trace methods carry the token and the (env, session, turn) key", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  const key = { env: "live" as const, sessionId: "s1", turnId: "t1" };

  await m.startCycleTrace(key);
  assert.deepEqual(calls[0], { kind: "mutation", args: { token: TOKEN, ...key } });

  await m.appendCycleTraceTool(key, "submit_orders", "call_7");
  assert.deepEqual(calls[1].args, {
    token: TOKEN,
    ...key,
    toolName: "submit_orders",
    callId: "call_7", // the idempotency key must reach Convex, or dedupe cannot happen
  });

  await m.saveCycleTraceContext(key, { accountValueGbp: 248.16, reportText: "£248.16" });
  assert.deepEqual(calls[2].args, {
    token: TOKEN,
    ...key,
    accountValueGbp: 248.16,
    reportText: "£248.16",
  });

  await m.finishCycleTrace(key, {
    invariants: [{ name: "cycle-recorded", status: "fail", detail: "never ran" }],
  });
  assert.equal(calls[3].kind, "mutation");
  // The violations count is derived server-side from the invariants, never sent by the client.
  assert.equal(calls[3].args.violations, undefined);
  assert.deepEqual(calls[3].args, {
    token: TOKEN,
    ...key,
    invariants: [{ name: "cycle-recorded", status: "fail", detail: "never ran" }],
  });

  assert.deepEqual(
    calls.map((c) => c.kind),
    ["mutation", "mutation", "mutation", "mutation"],
  );
});

test("cycle-trace reads are queries and degrade to null / [] when memory is empty", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);
  client.query = async () => null;

  assert.equal(await m.getCycleTrace({ env: "demo", sessionId: "s1", turnId: "t1" }), null);
  assert.deepEqual(await m.recentCycleTraces("demo", 5), []);
  assert.deepEqual(calls, []); // the stubbed query replaced the recorder, so nothing was pushed
});

test("getCycleTraceById uses the secret-gated trace lookup", async () => {
  const { client, calls } = fakeClient();
  const m = new Memory(client, TOKEN);

  await m.getCycleTraceById("real-cycle-id");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: "query",
    args: { token: TOKEN, cycleId: "real-cycle-id" },
  });
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

// Convex's argument validator prints the whole argument object, token included. Captured on the
// dev deployment with a fake token; this value is fake too.
const FAKE_SECRET = "FAKE_TOKEN_abc123XYZ_not_a_real_secret";
const VALIDATOR_ERROR = [
  "ArgumentValidationError: Object is missing the required field `schedule`. Consider wrapping the field validator in `v.optional(...)` if this is expected.",
  "",
  `Object: {token: "${FAKE_SECRET}"}`,
  "Validator: v.object({schedule: v.string(), token: v.string()})",
].join("\n");

class FakeConvexError extends Error {
  readonly data: { code: string };
  constructor(message: string, data: { code: string }) {
    super(message);
    this.name = "FakeConvexError";
    this.data = data;
  }
}

function failingClient(reason: unknown): ConvexLike {
  return {
    async mutation() {
      throw reason;
    },
    async query() {
      throw reason;
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to reject");
}

function assertRedacted(err: unknown): void {
  assert.ok(err instanceof Error, `expected an Error, got ${typeof err}`);
  assert.equal(err.message.includes(FAKE_SECRET), false, err.message);
  assert.match(err.message, /ArgumentValidationError/);
  assert.match(err.message, /^Validator: v\.object/m);
}

async function withAppSecret(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.CONVEX_APP_SECRET;
  if (value === undefined) delete process.env.CONVEX_APP_SECRET;
  else process.env.CONVEX_APP_SECRET = value;
  try {
    await fn();
  } finally {
    if (prev !== undefined) process.env.CONVEX_APP_SECRET = prev;
    else delete process.env.CONVEX_APP_SECRET;
  }
}

test("a failing query rejects with the token redacted from the Convex validator error", async () => {
  await withAppSecret(FAKE_SECRET, async () => {
    const m = new Memory(failingClient(new Error(VALIDATOR_ERROR)), FAKE_SECRET);
    assertRedacted(await rejection(m.openBuys("live")));
  });
});

test("a failing query is redacted by the token-field pattern when CONVEX_APP_SECRET is unset", async () => {
  await withAppSecret(undefined, async () => {
    const m = new Memory(failingClient(new Error(VALIDATOR_ERROR)), FAKE_SECRET);
    assertRedacted(await rejection(m.openBuys("live")));
  });
});

test("a failing mutation rejects with the token redacted", async () => {
  await withAppSecret(undefined, async () => {
    const m = new Memory(failingClient(new Error(VALIDATOR_ERROR)), FAKE_SECRET);
    assertRedacted(await rejection(m.recordTrade(trade)));
  });
});

test("a redacted Convex error is the same object, class and fields intact, with its stack redacted too", async () => {
  await withAppSecret(undefined, async () => {
    const thrown = new FakeConvexError(VALIDATOR_ERROR, { code: "BadArgs" });
    assert.ok(thrown.stack?.includes(FAKE_SECRET)); // or the stack check below proves nothing
    const m = new Memory(failingClient(thrown), FAKE_SECRET);

    const caught = await rejection(m.openBuys("live"));

    assert.equal(caught, thrown);
    assert.ok(caught instanceof FakeConvexError);
    assert.deepEqual(caught.data, { code: "BadArgs" });
    assertRedacted(caught);
    assert.equal(typeof caught.stack, "string");
    assert.equal(caught.stack?.includes(FAKE_SECRET), false, caught.stack);
    assert.match(caught.stack ?? "", /ArgumentValidationError/);
  });
});

test("a non-Error rejection is rethrown as an Error with the token redacted", async () => {
  await withAppSecret(undefined, async () => {
    const m = new Memory(failingClient(VALIDATOR_ERROR), FAKE_SECRET);
    assertRedacted(await rejection(m.openBuys("live")));
    assertRedacted(await rejection(m.recordTrade(trade)));
  });
});

test("a successful call resolves with the client's value and sends { token, ...args } unchanged", async () => {
  // The secret is set to the very token sent, so redacting args or results would show here.
  await withAppSecret(TOKEN, async () => {
    const queried = [{ _id: "t1", note: `token: "${TOKEN}"` }];
    const calls: { kind: "mutation" | "query"; args: Record<string, unknown> }[] = [];
    const client: ConvexLike = {
      async mutation(_ref, args) {
        calls.push({ kind: "mutation", args });
        return TOKEN;
      },
      async query(_ref, args) {
        calls.push({ kind: "query", args });
        return queried;
      },
    };
    const m = new Memory(client, TOKEN);

    assert.equal(await m.openBuys("live"), queried);
    assert.deepEqual(queried, [{ _id: "t1", note: `token: "${TOKEN}"` }]);
    assert.equal(await m.recordTrade(trade), TOKEN);
    assert.deepEqual(calls, [
      { kind: "query", args: { token: TOKEN, env: "live" } },
      { kind: "mutation", args: { token: TOKEN, ...trade } },
    ]);
  });
});
