import { test } from "node:test";
import assert from "node:assert/strict";
import { INVARIANT_NAMES } from "./invariants.ts";
import {
  EVAL_WINDOW_DAYS,
  SMALL_SAMPLE_CYCLES,
  aggregateEvalHealth,
  formatEvalHealth,
  invariantHealthByName,
  windowCoverage,
  withinWindow,
  type EvalHealthTrace,
} from "./eval-health.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 20, 21, 0, 0);

/** All five invariants at one status, which is what a real cycle row looks like. */
function invariants(
  overrides: Partial<Record<string, "pass" | "fail" | "not-applicable">> = {},
  base: "pass" | "not-applicable" = "pass",
): { name: string; status: string; detail?: string }[] {
  return INVARIANT_NAMES.map((name) => ({
    name,
    status: overrides[name] ?? base,
    detail: (overrides[name] ?? base) === "pass" ? undefined : "no submit_orders this cycle",
  }));
}

function trace(over: Partial<EvalHealthTrace> = {}): EvalHealthTrace {
  return {
    sessionId: "s1",
    turnId: "t1",
    completedAt: T0,
    toolSequence: ["recall_memory", "manage_positions", "record_cycle"],
    invariants: invariants(),
    ...over,
  };
}

/** N cycles, one per day, oldest first, all identical apart from their identity. */
function cycles(count: number, over: Partial<EvalHealthTrace> = {}): EvalHealthTrace[] {
  return [...Array(count)].map((_unused, i) =>
    trace({ sessionId: `s${i}`, turnId: `t${i}`, completedAt: T0 + i * DAY, ...over }),
  );
}

function lines(traces: EvalHealthTrace[]): string {
  return formatEvalHealth(aggregateEvalHealth(traces)).join("\n");
}

// --- the empty window ---

test("an empty window says so plainly rather than reporting everything healthy", () => {
  const health = aggregateEvalHealth([]);
  assert.equal(health.cycles, 0);
  assert.equal(health.violations.length, 0);
  const text = formatEvalHealth(health).join("\n");
  assert.match(text, /no completed cycles/i);
  assert.doesNotMatch(text, /healthy/i);
});

test("with no cycles every invariant is reported as unknown, not as passing", () => {
  const health = aggregateEvalHealth([]);
  assert.equal(health.invariants.length, INVARIANT_NAMES.length);
  for (const entry of health.invariants) {
    assert.equal(entry.pass, 0);
    assert.equal(entry.fail, 0);
    assert.equal(entry.recorded, 0);
    assert.match(entry.note, /not recorded/i);
  }
});

// --- THE VACUITY CASE: the confusion the 3-state design exists to prevent ---

test("THE ALL-VACUOUS CASE: 5 of 5 not-applicable reads as NEVER EXERCISED, not healthy", () => {
  const window = cycles(5, { invariants: invariants({}, "not-applicable") });
  const health = aggregateEvalHealth(window);
  const guard = invariantHealthByName(health, "earnings-before-buy");
  assert.ok(guard);
  assert.equal(guard.pass, 0);
  assert.equal(guard.fail, 0);
  assert.equal(guard.notApplicable, 5);
  assert.equal(guard.recorded, 5);
  assert.equal(guard.neverExercised, true);

  const text = formatEvalHealth(health).join("\n");
  assert.match(text, /earnings-before-buy: NEVER EXERCISED/);
  assert.match(text, /5 of 5/);
  assert.match(text, /UNVERIFIED/);
  // The exact confusion this must never produce.
  assert.doesNotMatch(text, /healthy/i);
  assert.doesNotMatch(text, /all guards? (pass|passed|passing)/i);
});

test("a guard that passed even once is not reported as never exercised", () => {
  const window = [
    ...cycles(4, { invariants: invariants({}, "not-applicable") }),
    trace({ sessionId: "sx", turnId: "tx", completedAt: T0 + 9 * DAY }),
  ];
  const guard = invariantHealthByName(
    aggregateEvalHealth(window),
    "earnings-before-buy",
  );
  assert.equal(guard?.neverExercised, false);
  assert.equal(guard?.pass, 1);
  assert.equal(guard?.notApplicable, 4);
});

test("the vacuity rate is explicit in the counts and in the wording", () => {
  const window = [
    ...cycles(2),
    ...cycles(3, { invariants: invariants({}, "not-applicable") }).map((t, i) => ({
      ...t,
      sessionId: `v${i}`,
    })),
  ];
  const guard = invariantHealthByName(aggregateEvalHealth(window), "no-duplicate-orders");
  assert.deepEqual(
    { pass: guard?.pass, fail: guard?.fail, notApplicable: guard?.notApplicable },
    { pass: 2, fail: 0, notApplicable: 3 },
  );
  assert.match(lines(window), /no-duplicate-orders: 2 passed, 0 failed, 3 not-applicable/);
});

// --- violations ---

test("a violation is listed with its cycle and its tool sequence", () => {
  const bad = trace({
    sessionId: "sBad",
    turnId: "tBad",
    toolSequence: ["submit_orders", "submit_orders"],
    invariants: invariants({ "no-duplicate-orders": "fail" }),
  });
  const health = aggregateEvalHealth([...cycles(3), bad]);
  assert.equal(health.violations.length, 1);
  assert.equal(health.violations[0].invariant, "no-duplicate-orders");
  assert.equal(health.violations[0].sessionId, "sBad");
  assert.equal(health.violations[0].turnId, "tBad");
  assert.equal(health.violations[0].toolSequence, "submit_orders -> submit_orders");

  const text = formatEvalHealth(health).join("\n");
  assert.match(text, /no-duplicate-orders/);
  assert.match(text, /sBad/);
  assert.match(text, /submit_orders -> submit_orders/);
});

test("a window with no violations says so without claiming the guards were exercised", () => {
  const text = lines(cycles(5));
  assert.match(text, /no invariant violations/i);
});

test("two violations in one cycle are both listed", () => {
  const bad = trace({
    invariants: invariants({ "no-duplicate-orders": "fail", "cycle-recorded": "fail" }),
  });
  assert.equal(aggregateEvalHealth([bad]).violations.length, 2);
});

// --- truncated, unfinished, unjudged: called out, never silently omitted ---

test("a truncated trace is called out", () => {
  const window = [...cycles(4), trace({ sessionId: "sT", turnId: "tT", truncated: true })];
  const health = aggregateEvalHealth(window);
  assert.equal(health.truncated.length, 1);
  assert.equal(health.truncated[0].sessionId, "sT");
  assert.match(formatEvalHealth(health).join("\n"), /truncated/i);
});

test("an unfinished trace is excluded from the tallies but reported", () => {
  // A cycle that died mid-way has an empty invariants array; counting it would dilute
  // every rate with a cycle that was never graded at all.
  const window = [
    ...cycles(3),
    { ...trace({ sessionId: "sU", turnId: "tU" }), completedAt: undefined, invariants: [] },
  ];
  const health = aggregateEvalHealth(window);
  assert.equal(health.cycles, 3);
  assert.equal(health.unfinished.length, 1);
  assert.equal(invariantHealthByName(health, "cycle-recorded")?.recorded, 3);
  assert.match(formatEvalHealth(health).join("\n"), /did not finish/i);
});

test("an unjudged cycle is called out and never counted as a good score", () => {
  const window = [
    ...cycles(4, {
      judgedAt: T0,
      reportScore: {
        status: "judged",
        grounding: 5,
        consistency: 5,
        calibration: 5,
        completeness: 5,
        overall: 5,
        findings: [],
      },
    }),
    trace({
      sessionId: "sN",
      turnId: "tN",
      judgedAt: T0,
      reportScore: { status: "unjudged", warning: "the judge returned no usable verdict" },
    }),
  ];
  const health = aggregateEvalHealth(window);
  assert.equal(health.reportQuality.judged, 4);
  assert.equal(health.reportQuality.unjudged.length, 1);
  assert.equal(health.reportQuality.unjudged[0].sessionId, "sN");
  assert.equal(health.reportQuality.averages?.overall, 5);
  assert.match(formatEvalHealth(health).join("\n"), /unjudged/i);
});

test("a cycle that was never judged at all is reported as not yet judged", () => {
  const health = aggregateEvalHealth(cycles(3));
  assert.equal(health.reportQuality.judged, 0);
  assert.equal(health.reportQuality.notJudged, 3);
  assert.match(formatEvalHealth(health).join("\n"), /not yet judged/i);
});

// --- report quality: averages, trend, low grounding ---

function judged(overall: number, grounding = 5) {
  return {
    judgedAt: T0,
    reportScore: {
      status: "judged",
      grounding,
      consistency: overall,
      calibration: overall,
      completeness: overall,
      overall,
      findings: [] as string[],
    },
  };
}

test("averages are computed over judged cycles only", () => {
  const window = [
    trace({ sessionId: "a", completedAt: T0, ...judged(3) }),
    trace({ sessionId: "b", completedAt: T0 + DAY, ...judged(5) }),
  ];
  const quality = aggregateEvalHealth(window).reportQuality;
  assert.equal(quality.averages?.overall, 4);
  assert.equal(quality.averages?.grounding, 5);
});

test("the trend needs enough judged cycles before it claims a direction", () => {
  const window = [
    trace({ sessionId: "a", completedAt: T0, ...judged(2) }),
    trace({ sessionId: "b", completedAt: T0 + DAY, ...judged(5) }),
  ];
  const health = aggregateEvalHealth(window);
  assert.equal(health.reportQuality.trend, "insufficient-data");
  assert.match(formatEvalHealth(health).join("\n"), /too few judged cycles/i);
});

test("an improving and a declining trend are both detected, oldest cycle first", () => {
  const improving = [
    trace({ sessionId: "a", completedAt: T0, ...judged(2) }),
    trace({ sessionId: "b", completedAt: T0 + DAY, ...judged(2) }),
    trace({ sessionId: "c", completedAt: T0 + 2 * DAY, ...judged(5) }),
    trace({ sessionId: "d", completedAt: T0 + 3 * DAY, ...judged(5) }),
  ];
  assert.equal(aggregateEvalHealth(improving).reportQuality.trend, "improving");
  // Same rows, reversed: recentCycleTraces returns newest first, so ordering must be
  // recovered from completedAt rather than from the array order.
  assert.equal(aggregateEvalHealth([...improving].reverse()).reportQuality.trend, "improving");
  const declining = improving.map((t, i) => ({
    ...t,
    ...judged(i < 2 ? 5 : 2),
    completedAt: t.completedAt,
  }));
  assert.equal(aggregateEvalHealth(declining).reportQuality.trend, "declining");
});

test("a flat trend is not dressed up as movement", () => {
  const flat = [...Array(6)].map((_unused, i) =>
    trace({ sessionId: `f${i}`, completedAt: T0 + i * DAY, ...judged(4) }),
  );
  assert.equal(aggregateEvalHealth(flat).reportQuality.trend, "flat");
});

test("low-grounding cycles are listed individually", () => {
  const window = [
    trace({ sessionId: "ok", completedAt: T0, ...judged(5, 5) }),
    trace({
      sessionId: "weak",
      completedAt: T0 + DAY,
      judgedAt: T0,
      reportScore: {
        status: "judged",
        grounding: 2,
        consistency: 4,
        calibration: 4,
        completeness: 4,
        overall: 4,
        findings: ["The 12 percent figure appears in no tool output."],
      },
    }),
  ];
  const health = aggregateEvalHealth(window);
  assert.equal(health.reportQuality.lowGrounding.length, 1);
  assert.equal(health.reportQuality.lowGrounding[0].sessionId, "weak");
  assert.equal(health.reportQuality.lowGrounding[0].grounding, 2);
  const text = formatEvalHealth(health).join("\n");
  assert.match(text, /grounding/i);
  assert.match(text, /12 percent figure appears in no tool output/);
});

// --- the small-sample honesty rule ---

test("a small window says the sample is too small instead of implying a trend", () => {
  const health = aggregateEvalHealth(cycles(2));
  assert.equal(health.smallSample, true);
  assert.match(formatEvalHealth(health).join("\n"), /sample is too small/i);
});

test("a full week of cycles is not flagged as a small sample", () => {
  const health = aggregateEvalHealth(cycles(SMALL_SAMPLE_CYCLES));
  assert.equal(health.smallSample, false);
  assert.doesNotMatch(formatEvalHealth(health).join("\n"), /sample is too small/i);
});

// --- the window ---

test("the window keeps recent cycles and drops older ones", () => {
  const now = T0 + 10 * DAY;
  const window = [
    trace({ sessionId: "old", completedAt: now - (EVAL_WINDOW_DAYS + 1) * DAY }),
    trace({ sessionId: "new", completedAt: now - DAY }),
  ];
  assert.deepEqual(
    withinWindow(window, now).map((t) => t.sessionId),
    ["new"],
  );
});

test("an unfinished trace is placed in the window by startedAt, never dropped for lack of one", () => {
  // A cycle that died part-way is the most interesting failure there is; losing it because it
  // has no completedAt would hide exactly what this read path exists to surface.
  const now = T0 + 10 * DAY;
  const unfinished = {
    ...trace({ sessionId: "dead" }),
    completedAt: undefined,
    startedAt: now - DAY,
  };
  assert.equal(withinWindow([unfinished], now).length, 1);
  assert.equal(
    withinWindow([{ ...unfinished, startedAt: now - 30 * DAY }], now).length,
    0,
  );
});

// --- the scan cap must never silently shrink the reported window ---

test("a window fully covered by the scan reports no coverage caveat", () => {
  const now = T0 + 10 * DAY;
  // Fewer rows came back than the cap, so the cap did not decide anything.
  const coverage = windowCoverage(12, 50, now - 6 * DAY, now, 7);
  assert.equal(coverage.truncatedByScanLimit, false);
  const text = formatEvalHealth(aggregateEvalHealth(cycles(5), { coverage })).join("\n");
  assert.doesNotMatch(text, /scan cap/i);
});

test("THE SILENT TRUNCATION: a window wider than the scan can cover says so, and by how much", () => {
  // 90 requested days against a 50-trace cap whose oldest row is only 9 days back: the data
  // stops well short of the question asked. Reporting the aggregate as if it covered 90 days
  // would change the conclusion (a violation 40 days ago would simply be invisible).
  const now = T0 + 100 * DAY;
  const coverage = windowCoverage(50, 50, now - 9 * DAY, now, 90);
  assert.equal(coverage.truncatedByScanLimit, true);
  assert.equal(coverage.requestedDays, 90);
  assert.equal(coverage.coveredDays, 9);
  const text = formatEvalHealth(aggregateEvalHealth(cycles(5), { coverage })).join("\n");
  assert.match(text, /scan cap/i);
  assert.match(text, /90/);
  assert.match(text, /9/);
  // And it must not be phrased as though the full window were covered.
  assert.match(text, /does NOT cover the full|only the last/i);
});

test("hitting the cap with the oldest row still older than the window is NOT truncation", () => {
  // The cap was reached, but the data already reaches past the window start, so the window is
  // fully covered and there is nothing to caveat.
  const now = T0 + 100 * DAY;
  const coverage = windowCoverage(50, 50, now - 20 * DAY, now, 7);
  assert.equal(coverage.truncatedByScanLimit, false);
});

test("an empty scan reports no coverage caveat, because the empty window already says it", () => {
  const now = T0 + 10 * DAY;
  const coverage = windowCoverage(0, 50, undefined, now, 90);
  assert.equal(coverage.truncatedByScanLimit, false);
  assert.match(formatEvalHealth(aggregateEvalHealth([], { coverage })).join("\n"), /no completed cycles/i);
});

test("coverage is carried on the aggregate so a caller can assert on it, not just read prose", () => {
  const now = T0 + 100 * DAY;
  const coverage = windowCoverage(50, 50, now - 9 * DAY, now, 90);
  assert.deepEqual(aggregateEvalHealth(cycles(5), { coverage }).coverage, coverage);
  // Absent by default, so existing callers are unaffected.
  assert.equal(aggregateEvalHealth(cycles(5)).coverage, undefined);
});

// --- robustness and purity ---

test("an invariant name from an older deploy is still reported, never dropped", () => {
  const window = [
    trace({ invariants: [...invariants(), { name: "legacy-guard", status: "fail" }] }),
  ];
  const health = aggregateEvalHealth(window);
  assert.ok(invariantHealthByName(health, "legacy-guard"));
  assert.equal(health.violations.some((v) => v.invariant === "legacy-guard"), true);
});

test("an unrecognised status is counted as unknown rather than as a pass", () => {
  const window = [trace({ invariants: [{ name: "no-duplicate-orders", status: "weird" }] })];
  const guard = invariantHealthByName(aggregateEvalHealth(window), "no-duplicate-orders");
  assert.deepEqual(
    { pass: guard?.pass, fail: guard?.fail, notApplicable: guard?.notApplicable },
    { pass: 0, fail: 0, notApplicable: 0 },
  );
  assert.equal(guard?.recorded, 1);
});

test("aggregation is pure: same input, same answer, and no input is mutated", () => {
  const window = cycles(3);
  const snapshot = structuredClone(window);
  assert.deepEqual(aggregateEvalHealth(window), aggregateEvalHealth(window));
  assert.deepEqual(window, snapshot);
});

test("the formatted block never contains an em-dash or a raw newline inside a line", () => {
  // Escaped rather than written literally so the character itself stays out of the repo.
  const emDash = /[\u2013\u2014]/;
  const block = formatEvalHealth(aggregateEvalHealth(cycles(5)));
  for (const line of block) {
    assert.doesNotMatch(line, emDash);
    assert.doesNotMatch(line, /\n/);
  }
});
