import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkInvariants, violatedInvariants } from "./invariants.ts";
import { checkReportNumbers } from "./report-check.ts";
import { buildRiskSnapshot } from "./execution.ts";
import { validateOrders, DEFAULT_LIMITS } from "./risk.ts";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import type { CashBalance, T212Order, T212Position } from "./t212.ts";

// --- OBSERVER REGRESSION TESTS ---
//
// INTENT (do not "fix" this by wiring the two together): the online evals exist to WATCH the
// agent, never to steer it. A behavioural invariant is a heuristic over a tool sequence and the
// report check is a heuristic over prose; if either could halt, resize, or reroute a trade, a
// false positive in an observability heuristic would become a trading incident, and the risk
// gate would no longer be the single authority on what may execute.
//
// So: an invariant violation and a report finding may ONLY log and alert. These tests pin that
// property both behaviourally (identical gate verdicts and identical broker calls whether or
// not the observers are failing) and structurally (the trading path never mentions them).

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
/** A report claiming the account is worth GBP 282 when it holds GBP 248: the real incident. */
const LYING_REPORT = "Bottom line: your account is worth about £282.00 today.";
const TRUTH = { accountValueGbp: 248.16, cashGbp: 248.16, deployedGbp: 0 };

test("the observers really are failing in these tests (the guard cannot go vacuous)", () => {
  // All five: no earnings check, no red team, no exits, no record_cycle, and a double submit.
  assert.equal(violatedInvariants(checkInvariants(VIOLATING_SEQUENCE)).length, 5);
  assert.equal(checkReportNumbers(LYING_REPORT, TRUTH).pass, false);
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
  assert.ok(violatedInvariants(invariants).length > 0);
  assert.equal(report.pass, false);

  const afterObserving = validateOrders(proposals, snapshot, DEFAULT_LIMITS);
  assert.deepEqual(afterObserving, control);
  // And the healthy proposal still executes: observing did not turn the gate risk-off.
  assert.deepEqual(
    afterObserving.accepted.map((p) => p.ticker),
    ["NKE_US_EQ"],
  );
});

test("REGRESSION: a failing invariant and a report finding do not block or resize an order", async () => {
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

  // Same execution, with both observers reporting failure first. `evaluateAndExecute` takes no
  // invariant or report input at all, which is exactly why this cannot differ.
  assert.ok(violatedInvariants(checkInvariants(VIOLATING_SEQUENCE)).length > 0);
  assert.equal(checkReportNumbers(LYING_REPORT, TRUTH).pass, false);
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
  const pattern = /invariant|report-check|checkReportNumbers|cycleTrace|cycle-trace/i;
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

test("REGRESSION: the online-eval modules never import the trading path", () => {
  // The other direction: an observer that reached into orders/risk could develop a side effect.
  // report-check and invariants must stay pure functions of their arguments.
  const forbidden = /from "\.\/(orders|risk|risk-runtime|t212|execution)\.ts"/;
  for (const rel of ["./invariants.ts", "./report-check.ts"]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.equal(forbidden.test(source), false, `${rel} must not import the trading path`);
  }
});
