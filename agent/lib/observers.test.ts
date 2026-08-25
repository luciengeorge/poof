import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkInvariants, violatedInvariants } from "./invariants.ts";
import { checkReportNumbers } from "./report-check.ts";
import { aggregateEvalHealth, formatEvalHealth } from "./eval-health.ts";
import { judgeAlertReasons, parseJudgeVerdict } from "./report-judge.ts";
import { buildRiskSnapshot } from "./execution.ts";
import { validateOrders, DEFAULT_LIMITS } from "./risk.ts";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import type { CashBalance, T212Order, T212Position } from "./t212.ts";

// --- OBSERVER REGRESSION TESTS ---
//
// INTENT (do not "fix" this by wiring them together): the online evals exist to WATCH the
// agent, never to steer it. There are now four of them, and every one is a HEURISTIC: a
// behavioural invariant over a tool sequence, a numeric check over prose, an LLM-as-judge score
// over prose, and a weekly aggregate of all three. If any could halt, resize, or reroute a
// trade, a false positive in an observability heuristic would become a trading incident, and the
// risk gate would no longer be the single authority on what may execute. The judge is the
// starkest case: it is a MODEL grading a report that was already sent days earlier, so letting
// it reach the order path would put one model's opinion of another model's prose upstream of
// real money.
//
// So: an invariant violation, a report finding, a judge verdict and an eval-health aggregate may
// ONLY log and alert. These tests pin that property both behaviourally (identical gate verdicts
// and identical broker calls whether or not the observers are failing) and structurally (the
// trading path never mentions them).

function cash(over: Partial<CashBalance> = {}): CashBalance {
  return {
    total: 0,
    free: 0,
    blocked: 0,
    invested: 0,
    pieCash: 0,
    result: 0,
    ppl: 0,
    ...over,
  };
}

/** A tool sequence that violates every submit-gated invariant: a buy with no guards at all. */
const VIOLATING_SEQUENCE = ["submit_orders", "submit_orders"];
/** The same instrument sent to the broker twice, which is what `no-duplicate-orders` catches. */
const DUPLICATE_ORDERS = [
  { ticker: "KO_US_EQ", side: "BUY", status: "placed" },
  { ticker: "KO_US_EQ", side: "BUY", status: "placed" },
];
const VIOLATING_OPTS = { orders: DUPLICATE_ORDERS };
/** A report claiming the account is worth GBP 282 when it holds GBP 248: the real incident. */
const LYING_REPORT = "Bottom line: your account is worth about £282.00 today.";
const TRUTH = { accountValueGbp: 248.16, cashGbp: 248.16, deployedGbp: 0 };

/** The worst judge verdict there is: bottom marks on every dimension, grounding included. */
const DAMNING_VERDICT = parseJudgeVerdict({
  grounding: 1,
  consistency: 1,
  calibration: 1,
  completeness: 1,
  overall: 1,
  findings: ["the account value in the prose appears in no tool output"],
});

/** A week in which a guard was violated, every other guard went vacuous, and quality collapsed. */
const SICK_WINDOW = [
  {
    sessionId: "s1",
    turnId: "t1",
    completedAt: 1,
    toolSequence: VIOLATING_SEQUENCE,
    invariants: checkInvariants(VIOLATING_SEQUENCE, VIOLATING_OPTS),
    reportScore: {
      status: "judged",
      grounding: 1,
      consistency: 1,
      calibration: 1,
      completeness: 1,
      overall: 1,
      findings: [],
    },
  },
];

test("the observers really are failing in these tests (the guard cannot go vacuous)", () => {
  // All five: no earnings check, no red team, no exits, no record_cycle, and one instrument
  // sent to the broker twice.
  assert.equal(violatedInvariants(checkInvariants(VIOLATING_SEQUENCE, VIOLATING_OPTS)).length, 5);
  assert.equal(checkReportNumbers(LYING_REPORT, TRUTH).pass, false);
  // Both judge thresholds tripped: overall below 3 and grounding below 4.
  assert.equal(judgeAlertReasons(DAMNING_VERDICT).length, 2);
  // And the weekly aggregate is reporting the damage rather than a clean bill.
  const health = aggregateEvalHealth(SICK_WINDOW);
  assert.ok(health.violations.length > 0);
  assert.equal(health.reportQuality.lowGrounding.length, 1);
  assert.ok(formatEvalHealth(health).length > 0);
});

test("REGRESSION: a failing invariant does not change the risk gate's verdict", () => {
  const snapshot = buildRiskSnapshot({
    cash: cash({ free: 248.16 }),
    positions: [],
    fxRate: 1,
    peakEquity: 248.16,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  const proposals = [
    { ticker: "NKE_US_EQ", side: "BUY" as const, notional: 50, price: 100 },
    { ticker: "XOM_US_EQ", side: "BUY" as const, notional: 5_000, price: 100 },
  ];

  const control = validateOrders(proposals, snapshot, DEFAULT_LIMITS);

  // Run every observer, at full failure, between the two identical gate calls. If any of them
  // could reach the gate (shared mutable state, a thrown control-flow shortcut, a patched
  // limit), the second verdict would differ.
  const invariants = checkInvariants(VIOLATING_SEQUENCE);
  const report = checkReportNumbers(LYING_REPORT, TRUTH);
  const judged = judgeAlertReasons(DAMNING_VERDICT);
  const health = aggregateEvalHealth(SICK_WINDOW);
  assert.ok(violatedInvariants(invariants).length > 0);
  assert.equal(report.pass, false);
  assert.ok(judged.length > 0);
  assert.ok(health.violations.length > 0);

  const afterObserving = validateOrders(proposals, snapshot, DEFAULT_LIMITS);
  assert.deepEqual(afterObserving, control);
  // And the healthy proposal still executes: observing did not turn the gate risk-off.
  assert.deepEqual(
    afterObserving.accepted.map((p) => p.ticker),
    ["NKE_US_EQ"],
  );
});

test("REGRESSION: no failing observer blocks or resizes an order", async () => {
  async function execute(): Promise<{
    placedAtBroker: { ticker: string; quantity: number }[];
    placedCount: number;
  }> {
    const placedAtBroker: { ticker: string; quantity: number }[] = [];
    const client: OrderExecClient = {
      async getCash() {
        return cash({ total: 10_000, free: 10_000 });
      },
      async getPortfolio() {
        return [] as T212Position[];
      },
      async getPendingOrders() {
        return [] as T212Order[];
      },
      async placeMarketOrder(input) {
        placedAtBroker.push(input);
        return { id: 1, ...input } as T212Order;
      },
    };
    const proposals: Proposal[] = [
      { ticker: "NKE_US_EQ", side: "BUY", notional: 500, price: 100, thesis: "yes" },
    ];
    const result = await evaluateAndExecute(proposals, {
      client,
      fxRate: 1,
      dryRun: false,
      resolveRiskState: async () => ({
        peakEquity: 0,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
      resolvePrice: async () => 100,
    });
    return { placedAtBroker, placedCount: result.placed.length };
  }

  const control = await execute();

  // Same execution, with every observer reporting failure first. `evaluateAndExecute` takes no
  // invariant, report, judge or eval-health input at all, which is exactly why this cannot differ.
  assert.ok(violatedInvariants(checkInvariants(VIOLATING_SEQUENCE)).length > 0);
  assert.equal(checkReportNumbers(LYING_REPORT, TRUTH).pass, false);
  assert.ok(judgeAlertReasons(DAMNING_VERDICT).length > 0);
  assert.ok(aggregateEvalHealth(SICK_WINDOW).violations.length > 0);
  const observed = await execute();

  assert.deepEqual(observed, control);
  assert.deepEqual(
    observed.placedAtBroker.map((o) => o.ticker),
    ["NKE_US_EQ"],
  );
  assert.equal(observed.placedAtBroker[0].quantity, control.placedAtBroker[0].quantity);
});

test("the observers are pure: grading twice gives the same answer and mutates no input", () => {
  const sequence = [...VIOLATING_SEQUENCE];
  assert.deepEqual(checkInvariants(sequence), checkInvariants(sequence));
  assert.deepEqual(sequence, VIOLATING_SEQUENCE);
  const truth = { ...TRUTH, externalGbpValues: [7912.44] };
  assert.deepEqual(
    checkReportNumbers(LYING_REPORT, truth),
    checkReportNumbers(LYING_REPORT, truth),
  );
  assert.deepEqual(truth.externalGbpValues, [7912.44]);
  assert.deepEqual(judgeAlertReasons(DAMNING_VERDICT), judgeAlertReasons(DAMNING_VERDICT));
  assert.deepEqual(aggregateEvalHealth(SICK_WINDOW), aggregateEvalHealth(SICK_WINDOW));
});

test("THE FAIL-SAFE: an unusable judge response can never become a passing observation", () => {
  // The judge is a MODEL, so it can answer with something unusable at any time. Pinned here,
  // next to the isolation guarantees, because a "5" invented from a non-answer would make the
  // whole judging layer decoration and the weekly report would call the cycle verified.
  for (const raw of [undefined, null, "looks fine", { grounding: 5 }, [], 5]) {
    assert.equal(parseJudgeVerdict(raw).status, "unjudged");
  }
  const health = aggregateEvalHealth([
    {
      sessionId: "s1",
      turnId: "t1",
      completedAt: 1,
      toolSequence: [],
      invariants: [],
      reportScore: { status: "unjudged", warning: "no usable verdict" },
    },
  ]);
  assert.equal(health.reportQuality.judged, 0);
  assert.equal(health.reportQuality.unjudged.length, 1);
  assert.equal(health.reportQuality.averages, null);
});

// The behavioural tests above compare pure functions given identical inputs, so they cannot
// catch contamination added at a CALL SITE: e.g. submit_orders.ts refusing to place when an
// invariant fails, or risk-runtime.ts folding a report finding into the halt state. This guard
// closes that gap structurally by asserting the trading path never mentions the concept.
//
// INTENT: a future refactor that wires an online-eval verdict into any of these files should
// fail HERE, deliberately and immediately, with this comment as the explanation. If you are
// reading this because the test just failed: that is the point. These checks are heuristics for
// a human to read; the risk gate stays the single authority on what may execute. Put the
// reaction in the alert (agent/lib/alert.ts), not in the order path.
const TRADING_PATH_FILES = [
  "./execution.ts",
  "./orders.ts",
  "./risk.ts",
  "./risk-runtime.ts",
  "./positions.ts",
  "./exits.ts",
  "../tools/submit_orders.ts",
  "../tools/manage_positions.ts",
  "../tools/get_account.ts",
];

test("REGRESSION: no trading-path source file references the online-eval observers", () => {
  const pattern =
    /invariant|report-check|checkReportNumbers|cycleTrace|cycle-trace|report-judge|report_judge|reportJudge|reportScore|judgeAlert|eval-health|evalHealth/i;
  for (const rel of TRADING_PATH_FILES) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.equal(
      pattern.test(source),
      false,
      `${rel} must not reference the online-eval observers: they may only log and alert. ` +
        "See the comment above TRADING_PATH_FILES.",
    );
  }
});

test("the trading-path guard list actually resolves (the guard cannot go vacuous)", () => {
  // Without this, a renamed or moved file would make the guard above silently pass on nothing.
  assert.equal(TRADING_PATH_FILES.length, 9);
  for (const rel of TRADING_PATH_FILES) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(source.length > 0, `${rel} must exist and be non-empty`);
  }
});

/** Every pure online-eval module. All five must stay functions of their arguments only. */
const OBSERVER_FILES = [
  "./invariants.ts",
  "./report-check.ts",
  "./report-judge.ts",
  "./eval-health.ts",
  // The extraction layer: it reads TOOL RESULTS from the trading tools, which is exactly why it
  // must not import those tools' modules. It parses their output shapes structurally instead.
  "./cycle-trace.ts",
];

test("REGRESSION: the online-eval modules never import the trading path", () => {
  // The other direction: an observer that reached into orders/risk could develop a side effect.
  const forbidden = /from "\.\/(orders|risk|risk-runtime|t212|execution|exits|positions)\.ts"/;
  for (const rel of OBSERVER_FILES) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.equal(forbidden.test(source), false, `${rel} must not import the trading path`);
  }
});

test("the observer guard list actually resolves (the guard cannot go vacuous)", () => {
  assert.equal(OBSERVER_FILES.length, 5);
  for (const rel of OBSERVER_FILES) {
    assert.ok(readFileSync(new URL(rel, import.meta.url), "utf8").length > 0);
  }
});

test("REGRESSION: the expanded ground truth is captured by the HOOK, not by a trading tool", () => {
  // The judge needed far more ground truth than six GBP numbers, and the cheap way to get it
  // would have been to make submit_orders / manage_positions report themselves to the trace. That
  // would put an observer's storage call inside the order path, where a Convex hiccup could
  // become a trading failure. Instead the hook reads the SAME tool results after the fact.
  const hook = readFileSync(new URL("../hooks/trace-cycle.ts", import.meta.url), "utf8");
  for (const extractor of [
    "ordersFrom",
    "exitsFrom",
    "positionsFrom",
    "quotesFrom",
    "postTradeTruthFrom",
    "externalHoldingsFrom",
  ]) {
    assert.match(hook, new RegExp(extractor), `the hook must be the one calling ${extractor}`);
  }
});

test("REGRESSION: account-value reconciliation uses the established completed-cycle alert path", () => {
  const hook = readFileSync(new URL("../hooks/trace-cycle.ts", import.meta.url), "utf8");
  assert.match(hook, /accountValueAlertFrom\(output\)/);
  assert.match(hook, /accountValueAlerts: \[accountValueAlert\]/);
  assert.match(hook, /poof ACCOUNT VALUE RECONCILIATION/);
  assert.match(hook, /await alert\(/);
});

test("REGRESSION: record_cycle reports the SAME figures it wrote, and still swallows failures", () => {
  // It runs last and refetches, so its equity and free cash are the only post-trade snapshot in
  // the cycle. Two properties must hold: the returned figures are the very ones written to the
  // cycles table (not a second read that could disagree with the durable record), and a broker or
  // memory failure still returns {recorded:false} rather than failing the cycle. Structural,
  // because the tool itself needs live credentials to run.
  const source = readFileSync(new URL("../tools/record_cycle.ts", import.meta.url), "utf8");
  assert.match(source, /const accountValueReconciliation = reconcileAccountValueGbp\(/);
  assert.match(source, /const equity = accountValueReconciliation\.accountValueGbp/);
  assert.match(source, /const freeCash = cash\.free/);
  assert.match(source, /recordCycle\(\{[\s\S]*?\bequity,[\s\S]*?\bfreeCash,/);
  assert.match(source, /accountValueGbp: equity/);
  assert.match(source, /cashGbp: freeCash/);
  assert.match(source, /accountValueReconciliation,/);
  assert.match(source, /catch[\s\S]*?recorded: false/);
});

test("REGRESSION: the judge runs from a SCHEDULE, never inline in the trace hook", () => {
  // A model call from a hook would stall a LIVE trading cycle for tens of seconds, on the very
  // turn that is placing orders: eve hooks execute inline in the event pipeline, which is why a
  // thrown hook escalates to turn.failed and why the online evals needed fetch timeouts at all.
  // If you are reading this because the test just failed: that is the point. Keep the
  // deterministic numeric check in the hook and the judge in agent/schedules/scorecard.ts.
  const hook = readFileSync(new URL("../hooks/trace-cycle.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hook, /report_judge|report-judge|reportJudge|saveReportScore/);
  const schedule = readFileSync(new URL("../schedules/scorecard.ts", import.meta.url), "utf8");
  assert.match(schedule, /report_judge/);
  assert.match(schedule, /review_eval_health/);
});
