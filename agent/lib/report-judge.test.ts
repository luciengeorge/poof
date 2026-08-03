import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JUDGE_THRESHOLDS,
  JUDGE_DIMENSIONS,
  alertReasonsForStoredVerdict,
  MAX_FINDINGS,
  MAX_FINDING_CHARS,
  judgeAlertReasons,
  judgeGroundTruth,
  judgeThresholdsFromEnv,
  parseJudgeVerdict,
  summarizeJudgeVerdict,
  type JudgeTrace,
} from "./report-judge.ts";
import { checkReportNumbers, parseGbpFigures } from "./report-check.ts";

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

test("a verdict that was NOT persisted never alerts", () => {
  // Alerting on a score that is not in the database points a human at a record they cannot look
  // at, and on already-judged would double-page on a cycle an earlier pass already handled.
  const bad = parseJudgeVerdict({ ...GOOD, grounding: 1, overall: 1 });
  assert.equal(alertReasonsForStoredVerdict(bad, "stored").length, 2);
  assert.deepEqual(alertReasonsForStoredVerdict(bad, "already-judged"), []);
  assert.deepEqual(alertReasonsForStoredVerdict(bad, "no-such-trace"), []);
});

test("a stored but healthy verdict still does not alert", () => {
  assert.deepEqual(alertReasonsForStoredVerdict(parseJudgeVerdict(GOOD), "stored"), []);
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

// --- THE GROUND TRUTH THE JUDGE IS GIVEN ---
//
// Three defects made `grounding` essentially unwinnable on any cycle that traded, so the judge
// alerted on every weekly pass and the alert became noise:
//   (A) STALENESS: `cashGbp` was captured from review_performance, which runs EARLY, while the
//       report correctly states cash AFTER the day's trades. Every trading cycle therefore
//       produced a guaranteed false "the cash figure is misstated" finding.
//   (B) INCOMPLETENESS: the whole ground truth was six numbers, so a correctly sourced order,
//       exit, holding or price was unverifiable from the judge's seat and read as invented.
//   (C) MISREAD ALLOW-LIST: `externalGbpValues` is the magnitude allow-list for
//       report-check.ts, and the judge read it as a required-content checklist, penalising the
//       report for "omitting" a cost basis it was never required to quote.
//
// The fixtures below are the real live cycle that produced the false alert.

/** Cash BEFORE the day's orders, from review_performance early in the cycle. */
const PRE_TRADE_CASH = 129.99;
/** The one order that cycle placed: GBP 15 of Amazon. */
const AMZN_NOTIONAL = 15;
/** Cash AFTER it, from record_cycle's fresh broker fetch at the end of the cycle. */
const POST_TRADE_CASH = 114.99;

function trace(over: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    accountValueGbp: 148.2,
    cashGbp: PRE_TRADE_CASH,
    deployedGbp: 18.21,
    toolSequence: ["review_performance", "submit_orders", "record_cycle"],
    invariants: [],
    ...over,
  };
}

test("REGRESSION (defect A): the judge is given POST-TRADE cash, not the stale pre-trade figure", () => {
  // The arithmetic that proves the reports were right all along: the "misstated" cash was
  // simply the pre-trade figure minus the order the same cycle placed.
  assert.equal(Math.round((PRE_TRADE_CASH - AMZN_NOTIONAL) * 100) / 100, POST_TRADE_CASH);

  const truth = judgeGroundTruth(
    trace({
      postTradeAccountValueGbp: 148.05,
      postTradeCashGbp: POST_TRADE_CASH,
      orders: [
        { ticker: "AMZN_US_EQ", side: "BUY", notionalGbp: AMZN_NOTIONAL, status: "placed" },
      ],
    }),
  );

  assert.equal(truth.cashGbp, POST_TRADE_CASH);
  assert.equal(truth.accountValueGbp, 148.05);
  assert.equal(truth.snapshotStage, "post-trade");
  // The report's own figure now MATCHES the ground truth, so there is nothing to contradict.
  const stated = parseGbpFigures("£114.99 is spare after today's £15 Amazon purchase.");
  assert.ok(stated.includes(POST_TRADE_CASH));
  // And the pre-trade figure is still there, LABELLED as pre-trade, so a difference between the
  // two reads as the day's spending rather than as a lie.
  assert.equal(truth.preTradeCashGbp, PRE_TRADE_CASH);
  assert.ok(
    truth.coverage.some((line) => /post-trade/i.test(line) && /not a contradiction/i.test(line)),
  );
});

test("falls back to the pre-trade figures when record_cycle did not run", () => {
  // A cycle that died before record_cycle still gets graded, against the only snapshot there is,
  // and the stage says which one it is rather than implying it is post-trade.
  const truth = judgeGroundTruth(trace({ toolSequence: ["review_performance"] }));
  assert.equal(truth.cashGbp, PRE_TRADE_CASH);
  assert.equal(truth.accountValueGbp, 148.2);
  assert.equal(truth.snapshotStage, "pre-trade");
  assert.ok(truth.coverage.some((line) => /pre-trade/i.test(line)));
});

test("REGRESSION (defect B): orders, exits, positions and quotes reach the judge", () => {
  const truth = judgeGroundTruth(
    trace({
      orders: [
        {
          ticker: "SBUX_US_EQ",
          side: "BUY",
          notionalGbp: 20,
          status: "placed",
          strategyTag: "news-catalyst",
        },
        { ticker: "KO_US_EQ", side: "BUY", notionalGbp: 15, status: "rejected", detail: "cap" },
      ],
      exits: [{ ticker: "CVS_US_EQ", reason: "trailing-stop", detail: "-8.1% from peak" }],
      positionTickers: ["AMZN_US_EQ", "SBUX_US_EQ", "KO_US_EQ"],
      positionCount: 10,
      quotes: { SBUX: 96.4, KO: 71.2 },
    }),
  );

  assert.equal(truth.orders?.length, 2);
  assert.equal(truth.orders?.[0].strategyTag, "news-catalyst");
  assert.deepEqual(
    truth.exits?.map((exit) => exit.ticker),
    ["CVS_US_EQ"],
  );
  // The count is the whole position list, even when only the first tickers were recorded, so
  // "10 stocks" in a report is checkable.
  assert.equal(truth.positionCount, 10);
  assert.deepEqual(truth.positionTickers, ["AMZN_US_EQ", "SBUX_US_EQ", "KO_US_EQ"]);
  assert.equal(truth.quotes?.KO, 71.2);
});

test("REGRESSION (defect C): external holdings arrive LABELLED, not as a bare magnitude list", () => {
  const truth = judgeGroundTruth(
    trace({
      externalAdvisoryHoldings: [
        {
          ticker: "SHOP",
          currentValueGbp: 7629.26,
          costBasisGbp: 9982.65,
          unrealisedPnlGbp: -2353.39,
        },
      ],
    }),
  );
  assert.deepEqual(truth.externalAdvisoryHoldings, [
    {
      ticker: "SHOP",
      currentValueGbp: 7629.26,
      costBasisGbp: 9982.65,
      unrealisedPnlGbp: -2353.39,
    },
  ]);
  // The bare allow-list array is report-check.ts's input and is NOT handed to the judge as a
  // checklist of figures the report owes the reader.
  assert.equal("externalGbpValues" in truth, false);
  assert.equal("externalAdvisoryGbpValues" in truth, false);
});

test("the bare allow-list still drives the DETERMINISTIC check, untouched by the judge's copy", () => {
  // Both forms come off the same trace row and neither replaces the other: the magnitude rule
  // needs plain numbers, the judge needs labels.
  const report =
    "Your account is worth £148.20. Your other account holds SHOP worth £7,629.26, " +
    "against a £9,982.65 cost.";
  assert.equal(
    checkReportNumbers(report, {
      accountValueGbp: 148.2,
      cashGbp: PRE_TRADE_CASH,
      deployedGbp: 18.21,
      externalGbpValues: [7629.26, 9982.65, -2353.39],
    }).pass,
    true,
  );
});

test("a category that was NOT captured is omitted and said so, never read as an invention", () => {
  // An older deploy, or a cycle that skipped the tool, records nothing for a category. Absence
  // of data is not evidence of a fabricated claim, so it is stated instead of implied.
  const truth = judgeGroundTruth(trace());
  assert.equal(truth.orders, undefined);
  assert.equal(truth.exits, undefined);
  assert.equal(truth.quotes, undefined);
  assert.ok(truth.coverage.some((line) => /orders/i.test(line) && /not captured/i.test(line)));
  assert.ok(truth.coverage.some((line) => /quoted prices/i.test(line) && /not captured/i.test(line)));
});

test("an empty captured collection means NONE happened, which IS adjudicable", () => {
  const truth = judgeGroundTruth(trace({ orders: [], exits: [] }));
  assert.deepEqual(truth.orders, []);
  assert.deepEqual(truth.exits, []);
  assert.ok(truth.coverage.some((line) => /no orders/i.test(line)));
  assert.ok(truth.coverage.some((line) => /no exits/i.test(line)));
});

test("every truncated collection is surfaced LOUDLY in the coverage notes", () => {
  const truth = judgeGroundTruth(
    trace({
      orders: [{ ticker: "AMZN_US_EQ", side: "BUY", notionalGbp: 15, status: "placed" }],
      ordersTruncated: true,
      exits: [{ ticker: "CVS_US_EQ", reason: "trailing-stop" }],
      exitsTruncated: true,
      positionTickers: ["AMZN_US_EQ"],
      positionCount: 40,
      positionsTruncated: true,
      quotes: { AMZN: 231.4 },
      quotesTruncated: true,
      externalAdvisoryHoldings: [{ ticker: "SHOP", currentValueGbp: 7629.26 }],
      externalAdvisoryHoldingsTruncated: true,
      truncated: true,
    }),
  );
  for (const category of [
    /orders/i,
    /exits/i,
    /positions/i,
    /quoted prices/i,
    /external/i,
    /tool sequence/i,
  ]) {
    assert.ok(
      truth.coverage.some((line) => category.test(line) && /TRUNCATED/.test(line)),
      `a truncated ${category} must be surfaced in the coverage notes`,
    );
  }
});

test("the numeric check's own verdict travels with the ground truth", () => {
  const truth = judgeGroundTruth(
    trace({
      reportPass: false,
      reportFindings: [{ rule: "account-value-present", detail: "never stated" }],
    }),
  );
  assert.equal(truth.numericSelfConsistencyPass, false);
  assert.equal(truth.numericSelfConsistencyFindings?.length, 1);
});

test("assembling the ground truth is pure and mutates no input", () => {
  const input = trace({ orders: [], positionTickers: ["AMZN_US_EQ"] });
  const snapshot = JSON.stringify(input);
  assert.deepEqual(judgeGroundTruth(input), judgeGroundTruth(input));
  assert.equal(JSON.stringify(input), snapshot);
});
