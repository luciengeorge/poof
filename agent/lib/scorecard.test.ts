import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../schedules/judge.ts", import.meta.url), "utf8");
const scorecard = readFileSync(new URL("../schedules/scorecard.ts", import.meta.url), "utf8");

test("the judge pass passes a cycle id, not an embedded ground-truth payload, to the judge", () => {
  assert.match(source, /Give its message the `cycleId` and `reportText`/);
  assert.match(source, /get_cycle_ground_truth/);
  assert.doesNotMatch(source, /whole `groundTruth` object/);
  assert.doesNotMatch(source, /groundTruth:\s*judgeGroundTruth/);
});

test("the judge pass records unavailable ground truth as UNJUDGEABLE without a score", () => {
  assert.match(source, /status: unjudgeable/);
  assert.match(source, /unjudgeableReason/);
  assert.match(source, /NO `verdict`/);
  assert.match(source, /not grounding=3/);
});

test("the judge pass runs in its OWN schedule, before the scorecard, so a failed grading turn cannot sink the report", () => {
  assert.match(source, /cron: "0 19 \* \* 5"/);
  assert.match(scorecard, /cron: "0 21 \* \* 5"/);
  assert.match(source, /message: JUDGE_PASS,/);
  assert.match(scorecard, /message: SCORECARD,/);
  assert.doesNotMatch(scorecard, /list_unjudged_cycles|report_judge|save_report_score/);
  assert.match(scorecard, /review_eval_health/);
});
