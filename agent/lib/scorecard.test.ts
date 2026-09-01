import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../schedules/scorecard.ts", import.meta.url), "utf8");

test("the scorecard passes a cycle id, not an embedded ground-truth payload, to the judge", () => {
  assert.match(source, /Give its message the `cycleId` and `reportText`/);
  assert.match(source, /get_cycle_ground_truth/);
  assert.doesNotMatch(source, /whole `groundTruth` object/);
  assert.doesNotMatch(source, /groundTruth:\s*judgeGroundTruth/);
});

test("the scorecard records unavailable ground truth as UNJUDGEABLE without a score", () => {
  assert.match(source, /status: unjudgeable/);
  assert.match(source, /unjudgeableReason/);
  assert.match(source, /NO `verdict`/);
  assert.match(source, /not grounding=3/);
});
