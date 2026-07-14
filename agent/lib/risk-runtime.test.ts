import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRiskState } from "./risk-runtime.ts";
import { memoryFromEnv, type ConvexLike } from "./memory.ts";
import { etDateString } from "./clock.ts";
import type { StoredRiskState } from "./state.ts";

const todayET = etDateString(new Date());

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

test("resolveRiskState fails open: getRiskState throwing returns the neutral zero state", async () => {
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
  const memory = memoryFromEnv(client);

  const fields = await resolveRiskState(9999, memory);

  assert.deepEqual(fields, {
    peakEquity: 0,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  assert.equal(mutationCalls.length, 0);
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
