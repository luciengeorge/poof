import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCycleGroundTruth } from "../subagents/report_judge/tools/get_cycle_ground_truth.ts";
import type { StoredCycleTrace } from "./memory.ts";

const REAL_CYCLE_ID = "real-cycle-id";

const TRACE: StoredCycleTrace = {
  _id: REAL_CYCLE_ID,
  env: "live",
  sessionId: "session-1",
  turnId: "turn-1",
  toolSequence: ["review_performance", "record_cycle"],
  callIds: [],
  invariants: [],
  violations: 0,
  accountValueGbp: 248.16,
  cashGbp: 12.4,
  deployedGbp: 235.76,
  positionTickers: ["MOD", "AMD"],
  positionCount: 2,
  startedAt: 1,
  completedAt: 2,
};

test("the judge tool returns ground truth and coverage for its requested cycle id", async () => {
  let requestedId: string | undefined;
  const result = await loadCycleGroundTruth(REAL_CYCLE_ID, {
    async getCycleTraceById(cycleId) {
      requestedId = cycleId;
      return TRACE;
    },
    async recentCycleTraces() {
      return [];
    },
  });

  assert.equal(requestedId, REAL_CYCLE_ID);
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.groundTruth.accountValueGbp, 248.16);
    assert.deepEqual(result.groundTruth.positionTickers, ["MOD", "AMD"]);
    assert.ok(result.groundTruth.coverage.length > 0);
    assert.match(result.groundTruth.coverage.join("\n"), /cashGbp/i);
  }
});

test("the judge tool explicitly returns UNJUDGEABLE when its cycle id has no trace", async () => {
  const result = await loadCycleGroundTruth(REAL_CYCLE_ID, {
    async getCycleTraceById() {
      return null;
    },
    async recentCycleTraces() {
      return [];
    },
  });

  assert.deepEqual(result, {
    status: "unjudgeable",
    reason:
      "ground truth is unavailable for this cycle id, so this report is UNJUDGEABLE and must not receive a score",
  });
});

function traceAt(startedAt: number, over: Partial<StoredCycleTrace> = {}): StoredCycleTrace {
  return { ...TRACE, _id: `t${startedAt}`, startedAt, completedAt: startedAt + 1, ...over };
}

/** Honours env and limit like the Convex query (newest first by completedAt). */
function recentFrom(rows: StoredCycleTrace[]) {
  return async (env: string, limit?: number) =>
    rows
      .filter((t) => t.env === env)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, limit ?? 10);
}

test("REGRESSION: the previous cycle's recorded value reaches the judge, so \"last recorded\" is checkable", async () => {
  const current = traceAt(500, { postTradeAccountValueGbp: 241.11 });
  const rows = [
    traceAt(100, { postTradeAccountValueGbp: 239.0 }),
    traceAt(400, { postTradeAccountValueGbp: 242.46 }),
    traceAt(450), // an ad-hoc turn with no post-trade figure: skipped
    traceAt(480, { env: "demo", postTradeAccountValueGbp: 999 }),
    current,
    traceAt(600, { postTradeAccountValueGbp: 240.11 }), // a LATER cycle is never "previous"
  ];
  const result = await loadCycleGroundTruth("t500", {
    async getCycleTraceById() {
      return current;
    },
    recentCycleTraces: recentFrom(rows),
  });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.groundTruth.previousAccountValueGbp, 242.46);
    assert.ok(result.groundTruth.coverage.some((l) => /^previousAccountValueGbp/.test(l)));
  }
});

test("a failed previous-value lookup leaves the claim unverifiable, never fails the grade", async () => {
  const result = await loadCycleGroundTruth("t500", {
    async getCycleTraceById() {
      return traceAt(500);
    },
    async recentCycleTraces() {
      throw new Error("convex unavailable");
    },
  });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.groundTruth.previousAccountValueGbp, undefined);
    assert.ok(result.groundTruth.coverage.some((l) => /unverifiable and costs nothing/.test(l)));
  }
});
