import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRiskState } from "./risk-runtime.ts";
import { memoryFromEnv, type ConvexLike } from "./memory.ts";
import { etDateString } from "./clock.ts";
import { resolveLimits, type StoredRiskState } from "./state.ts";
import {
  checkHalt,
  validateOrders,
  type PortfolioSnapshot,
  type ProposedOrder,
} from "./risk.ts";

const todayET = etDateString(new Date());

/** Run `fn` with TRADING212_ENV pinned, restoring the prior value after. */
async function withTradingEnv(env: string, fn: () => Promise<void>) {
  const prev = process.env.TRADING212_ENV;
  process.env.TRADING212_ENV = env;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.TRADING212_ENV;
    else process.env.TRADING212_ENV = prev;
  }
}

function throwingMemory() {
  const mutationCalls: Record<string, unknown>[] = [];
  const client: ConvexLike = {
    async mutation(_ref, args) {
      mutationCalls.push(args);
      return "id_1";
    },
    async query() {
      throw new Error("convex unavailable");
    },
  };
  return { memory: memoryFromEnv(client), mutationCalls };
}

function fakeMemory(
  stored: StoredRiskState | null | (() => StoredRiskState | null),
) {
  const mutationCalls: Record<string, unknown>[] = [];
  const queryCalls: Record<string, unknown>[] = [];
  const client: ConvexLike = {
    async mutation(_ref, args) {
      mutationCalls.push(args);
      return "id_1";
    },
    async query(_ref, args) {
      queryCalls.push(args);
      if (typeof stored === "function") return stored();
      return stored;
    },
  };
  return { memory: memoryFromEnv(client), mutationCalls, queryCalls };
}

test("resolveRiskState happy path: derives fields from stored state and persists haltState", async () => {
  const stored: StoredRiskState = {
    peakEquity: 10000,
    dayStartEquity: 10000,
    dayStartDate: todayET,
    consecutiveLossDays: 0,
  };
  const { memory, mutationCalls } = fakeMemory(stored);

  const fields = await resolveRiskState(10000, memory);

  assert.deepEqual(fields, {
    peakEquity: 10000,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].haltState, "none");
  assert.equal(mutationCalls[0].peakEquity, 10000);
  assert.equal(mutationCalls[0].dayStartEquity, 10000);
});

test("resolveRiskState fails open on demo: getRiskState throwing returns the neutral zero state", async () => {
  await withTradingEnv("demo", async () => {
    const { memory, mutationCalls } = throwingMemory();

    const fields = await resolveRiskState(9999, memory);

    assert.deepEqual(fields, {
      peakEquity: 0,
      dayPnl: 0,
      newPositionsToday: 0,
      consecutiveLossDays: 0,
    });
    assert.equal(mutationCalls.length, 0);
    // Fail-open is real: the neutral state does not trip the gate on demo.
    const halt = checkHalt(
      { equity: 9999, cash: 9999, positions: [], ...fields },
      resolveLimits(),
    );
    assert.equal(halt.halted, false);
  });
});

test("resolveRiskState fails CLOSED on live: throwing halts BUYs while SELLs still pass", async () => {
  await withTradingEnv("live", async () => {
    const { memory, mutationCalls } = throwingMemory();

    const fields = await resolveRiskState(10000, memory);
    const limits = resolveLimits();

    // Live fallback trips the consecutive-loss-days circuit breaker (derived from limits).
    assert.equal(fields.consecutiveLossDays, limits.maxConsecutiveLossDays);
    assert.equal(mutationCalls.length, 0);

    const snapshot: PortfolioSnapshot = {
      equity: 10000,
      cash: 5000,
      positions: [{ ticker: "AAPL_US_EQ", value: 1000 }],
      ...fields,
    };
    const buy: ProposedOrder = {
      ticker: "MSFT_US_EQ",
      side: "BUY",
      notional: 500,
      price: 100,
    };
    const sell: ProposedOrder = {
      ticker: "AAPL_US_EQ",
      side: "SELL",
      notional: 1000,
      price: 100,
    };
    const { accepted, rejected } = validateOrders([buy, sell], snapshot, limits);

    assert.ok(
      accepted.some((o) => o.ticker === "AAPL_US_EQ" && o.side === "SELL"),
      "de-risking SELL is still accepted while halted",
    );
    assert.ok(
      !accepted.some((o) => o.side === "BUY"),
      "no BUY is accepted while halted",
    );
    assert.ok(
      rejected.some((r) => r.order.ticker === "MSFT_US_EQ"),
      "the BUY is rejected while halted",
    );
  });
});

test("resolveRiskState haltState: drawdown breach beyond the limit maps to circuit", async () => {
  const stored: StoredRiskState = {
    peakEquity: 100000,
    dayStartEquity: 80000,
    dayStartDate: todayET,
    consecutiveLossDays: 0,
  };
  const { memory, mutationCalls } = fakeMemory(stored);

  // drawdown = (100000 - 80000) / 100000 = 20% > default 10% maxDrawdownPct.
  await resolveRiskState(80000, memory);

  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].haltState, "circuit");
});

test("resolveRiskState haltState: daily-loss breach maps to daily", async () => {
  const stored: StoredRiskState = {
    peakEquity: 10000,
    dayStartEquity: 10000,
    dayStartDate: todayET,
    consecutiveLossDays: 0,
  };
  const { memory, mutationCalls } = fakeMemory(stored);

  // dayPnl = 9500 - 10000 = -500 <= -4% * 9500 (-380); drawdown = 5% is within limit.
  await resolveRiskState(9500, memory);

  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].haltState, "daily");
});

test("resolveRiskState haltState: no breach maps to none", async () => {
  const stored: StoredRiskState = {
    peakEquity: 10000,
    dayStartEquity: 10000,
    dayStartDate: todayET,
    consecutiveLossDays: 0,
  };
  const { memory, mutationCalls } = fakeMemory(stored);

  await resolveRiskState(10500, memory);

  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].haltState, "none");
});
