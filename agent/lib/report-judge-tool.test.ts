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
  });

  assert.deepEqual(result, {
    status: "unjudgeable",
    reason:
      "ground truth is unavailable for this cycle id, so this report is UNJUDGEABLE and must not receive a score",
  });
});
