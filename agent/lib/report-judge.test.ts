import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JUDGE_THRESHOLDS,
  JUDGE_DIMENSIONS,
  MAX_FINDINGS,
  MAX_FINDING_CHARS,
  judgeAlertReasons,
  judgeThresholdsFromEnv,
  parseJudgeVerdict,
  summarizeJudgeVerdict,
} from "./report-judge.ts";

/** A well-formed verdict, exactly the shape the judge subagent is asked to return. */
const GOOD = {
  grounding: 5,
  consistency: 4,
  calibration: 4,
  completeness: 5,
  overall: 4,
  findings: ["States the account value verbatim from the tool output."],
};

// --- the happy path ---

test("a well-formed verdict parses into a judged score", () => {
  const verdict = parseJudgeVerdict(GOOD);
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.status === "judged" && verdict.score.grounding, 5);
  assert.equal(verdict.status === "judged" && verdict.score.overall, 4);
  assert.deepEqual(
    verdict.status === "judged" ? verdict.score.findings : null,
    GOOD.findings,
  );
});

test("a fractional score inside the range is kept rather than voiding a real verdict", () => {
  // A judge that answers 4.5 has still graded the report. Discarding that as "unjudged"
  // would lose a usable verdict over a formatting nit and make the weekly report noisier.
  const verdict = parseJudgeVerdict({ ...GOOD, overall: 4.5 });
  assert.equal(verdict.status === "judged" && verdict.score.overall, 4.5);
});

test("numeric strings are accepted", () => {
  const verdict = parseJudgeVerdict({
    grounding: "5",
    consistency: "4",
    calibration: "4",
    completeness: "5",
    overall: "4",
    findings: [],
  });
  assert.equal(verdict.status, "judged");
  assert.equal(verdict.status === "judged" && verdict.score.grounding, 5);
});

test("a JSON string is parsed, plain and inside a code fence", () => {
  assert.equal(parseJudgeVerdict(JSON.stringify(GOOD)).status, "judged");
  assert.equal(
    parseJudgeVerdict("```json\n" + JSON.stringify(GOOD) + "\n```").status,
    "judged",
  );
});

// --- the fail-safe: an unusable response is "unjudged", NEVER a passing score ---

test("THE FAIL-SAFE: nothing unusable is ever recorded as a judged score", () => {
  const unusable: unknown[] = [
    undefined,
    null,
    "",
    "   ",
    "the report looks fine to me",
    // A judge that ignored the instruction and rewrote the report instead of grading it.
    "Here is a corrected report: your account is worth £248.16.",
    42,
    true,
    [],
    [GOOD],
    {},
    { grounding: 5 },
    { ...GOOD, overall: undefined },
    { ...GOOD, grounding: null },
    { ...GOOD, consistency: "excellent" },
    { ...GOOD, calibration: 0 },
    { ...GOOD, completeness: 6 },
    { ...GOOD, overall: -1 },
    { ...GOOD, overall: Number.NaN },
    { ...GOOD, overall: Number.POSITIVE_INFINITY },
    "{ not json at all",
  ];
  for (const raw of unusable) {
    const verdict = parseJudgeVerdict(raw);
    assert.equal(
      verdict.status,
      "unjudged",
      `${JSON.stringify(raw) ?? String(raw)} must be unjudged, never judged`,
    );
    assert.ok(
      verdict.status === "unjudged" && verdict.warning.length > 0,
      "an unjudged verdict must carry a warning explaining why",
    );
  }
});

test("the warning names which dimensions were unusable", () => {
  const verdict = parseJudgeVerdict({ ...GOOD, grounding: 9, overall: "n/a" });
  assert.equal(verdict.status, "unjudged");
  assert.match(verdict.status === "unjudged" ? verdict.warning : "", /grounding/);
  assert.match(verdict.status === "unjudged" ? verdict.warning : "", /overall/);
});

test("the warning is bounded, so a rambling judge response cannot bloat the row", () => {
  const verdict = parseJudgeVerdict("x".repeat(50_000));
  assert.equal(verdict.status, "unjudged");
  assert.ok(verdict.status === "unjudged" && verdict.warning.length < 500);
});

// --- findings ---

test("missing or malformed findings do not void an otherwise valid verdict", () => {
  for (const findings of [undefined, null, "one finding", 7, {}]) {
    const verdict = parseJudgeVerdict({ ...GOOD, findings });
    assert.equal(verdict.status, "judged");
    assert.deepEqual(verdict.status === "judged" ? verdict.score.findings : null, []);
  }
});

test("non-string findings are dropped rather than stored", () => {
  const verdict = parseJudgeVerdict({ ...GOOD, findings: ["real", 3, null, "also real"] });
  assert.deepEqual(
    verdict.status === "judged" ? verdict.score.findings : null,
    ["real", "also real"],
  );
});

test("findings are capped in count and length", () => {
  const verdict = parseJudgeVerdict({
    ...GOOD,
    findings: [...Array(MAX_FINDINGS + 5)].map(() => "y".repeat(MAX_FINDING_CHARS + 100)),
  });
  const findings = verdict.status === "judged" ? verdict.score.findings : [];
  assert.equal(findings.length, MAX_FINDINGS);
  for (const finding of findings) assert.ok(finding.length <= MAX_FINDING_CHARS);
});

test("blank findings are dropped", () => {
  const verdict = parseJudgeVerdict({ ...GOOD, findings: ["", "   ", "real"] });
  assert.deepEqual(verdict.status === "judged" ? verdict.score.findings : null, ["real"]);
});

// --- alerting ---

test("a healthy verdict raises no alert", () => {
  assert.deepEqual(judgeAlertReasons(parseJudgeVerdict(GOOD)), []);
});

test("overall below the threshold alerts", () => {
  const reasons = judgeAlertReasons(parseJudgeVerdict({ ...GOOD, overall: 2 }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /overall/);
});

test("overall exactly at the threshold does not alert", () => {
  assert.deepEqual(judgeAlertReasons(parseJudgeVerdict({ ...GOOD, overall: 3 })), []);
});

test("grounding below 4 alerts even when everything else is perfect", () => {
  // Grounding is the class that produced the GBP 282 incident, so it gets a stricter bar.
  const reasons = judgeAlertReasons(
    parseJudgeVerdict({ ...GOOD, grounding: 3, overall: 5 }),
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /grounding/);
});

test("grounding exactly at 4 does not alert", () => {
  assert.deepEqual(judgeAlertReasons(parseJudgeVerdict({ ...GOOD, grounding: 4 })), []);
});

test("both thresholds can fire on one verdict", () => {
  const reasons = judgeAlertReasons(
    parseJudgeVerdict({ ...GOOD, grounding: 1, overall: 1 }),
  );
  assert.equal(reasons.length, 2);
});

test("an unjudged verdict is a WARNING, not an alert", () => {
  // A judge that failed to answer is an observability problem, not a report defect. It is
  // surfaced in the weekly eval-health section instead of paging on a formatting failure.
  assert.deepEqual(judgeAlertReasons(parseJudgeVerdict("garbage")), []);
});

test("thresholds are configurable in both directions", () => {
  // Stricter: the same verdict that passes the defaults now alerts on overall=4.
  const strict = { overallBelow: 5, groundingBelow: 4 };
  const stricter = judgeAlertReasons(parseJudgeVerdict(GOOD), strict);
  assert.equal(stricter.length, 1);
  assert.match(stricter[0], /overall/);
  // Looser: a verdict that alerts on the defaults can be silenced.
  const loose = { overallBelow: 1, groundingBelow: 1 };
  assert.deepEqual(
    judgeAlertReasons(parseJudgeVerdict({ ...GOOD, grounding: 2, overall: 2 }), loose),
    [],
  );
});

test("judgeThresholdsFromEnv defaults, overrides, and ignores junk", () => {
  assert.deepEqual(judgeThresholdsFromEnv({}), DEFAULT_JUDGE_THRESHOLDS);
  assert.deepEqual(
    judgeThresholdsFromEnv({
      REPORT_JUDGE_ALERT_OVERALL_BELOW: "4",
      REPORT_JUDGE_ALERT_GROUNDING_BELOW: "5",
    }),
    { overallBelow: 4, groundingBelow: 5 },
  );
  assert.deepEqual(
    judgeThresholdsFromEnv({
      REPORT_JUDGE_ALERT_OVERALL_BELOW: "",
      REPORT_JUDGE_ALERT_GROUNDING_BELOW: "not-a-number",
    }),
    DEFAULT_JUDGE_THRESHOLDS,
  );
});

// --- shape and purity ---

test("the rubric has exactly the four dimensions plus overall", () => {
  assert.deepEqual(JUDGE_DIMENSIONS, [
    "grounding",
    "consistency",
    "calibration",
    "completeness",
    "overall",
  ]);
});

test("summarizeJudgeVerdict is a one-liner for both statuses", () => {
  assert.match(summarizeJudgeVerdict(parseJudgeVerdict(GOOD)), /grounding=5/);
  assert.match(summarizeJudgeVerdict(parseJudgeVerdict(null)), /unjudged/);
});

test("parsing is pure: same input, same answer, and the input is not mutated", () => {
  const input = { ...GOOD, findings: [...GOOD.findings] };
  assert.deepEqual(parseJudgeVerdict(input), parseJudgeVerdict(input));
  assert.deepEqual(input, { ...GOOD, findings: [...GOOD.findings] });
});
