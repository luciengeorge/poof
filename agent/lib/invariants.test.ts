import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkInvariants,
  INVARIANT_NAMES,
  invariantByName,
  vacuousInvariants,
  violatedInvariants,
  type InvariantResult,
} from "./invariants.ts";

/** Status of one named invariant, for terse assertions. */
function status(results: InvariantResult[], name: string): string {
  const found = invariantByName(results, name);
  assert.ok(found, `expected an invariant named ${name}`);
  return found.status;
}

// A complete, well-behaved cycle: recall -> exits -> review -> signal -> earnings -> red team
// -> submit -> external advice -> record -> learn.
const GOOD_CYCLE = [
  "recall_memory",
  "manage_positions",
  "review_performance",
  "get_news",
  "get_prices",
  "get_earnings_calendar",
  "red_team",
  "submit_orders",
  "review_external_holdings",
  "record_cycle",
  "update_lessons",
];

test("every invariant is reported exactly once, in a stable order", () => {
  const results = checkInvariants(GOOD_CYCLE);
  assert.deepEqual(
    results.map((r) => r.name),
    [...INVARIANT_NAMES],
  );
});

test("a complete, well-ordered cycle passes every invariant", () => {
  const results = checkInvariants(GOOD_CYCLE);
  for (const r of results) {
    assert.equal(r.status, "pass", `${r.name} should pass: ${r.detail ?? ""}`);
  }
  assert.deepEqual(violatedInvariants(results), []);
  assert.deepEqual(vacuousInvariants(results), []);
});

// --- the three submit-gated invariants, in all three states ---

const GATED = [
  { name: "earnings-before-buy", prerequisite: "get_earnings_calendar" },
  { name: "red-team-before-buy", prerequisite: "red_team" },
  { name: "exits-before-entries", prerequisite: "manage_positions" },
] as const;

for (const { name, prerequisite } of GATED) {
  test(`${name}: passes when ${prerequisite} precedes submit_orders`, () => {
    const results = checkInvariants([prerequisite, "submit_orders"]);
    assert.equal(status(results, name), "pass");
  });

  test(`${name}: fails when ${prerequisite} never happened`, () => {
    const results = checkInvariants(["recall_memory", "submit_orders"]);
    assert.equal(status(results, name), "fail");
    assert.match(invariantByName(results, name)!.detail ?? "", /never/);
  });

  test(`${name}: fails when ${prerequisite} happened AFTER submit_orders (ordering, not presence)`, () => {
    const results = checkInvariants(["submit_orders", prerequisite]);
    assert.equal(status(results, name), "fail");
    assert.match(invariantByName(results, name)!.detail ?? "", /after|later/i);
  });

  test(`${name}: not-applicable when the cycle never submitted an order`, () => {
    const results = checkInvariants(["recall_memory", prerequisite, "record_cycle"]);
    assert.equal(status(results, name), "not-applicable");
  });

  test(`${name}: the FIRST submit_orders is what must be guarded`, () => {
    // Prerequisite sits between two submits: the first submit was unguarded, so this fails.
    const results = checkInvariants(["submit_orders", prerequisite, "submit_orders"]);
    assert.equal(status(results, name), "fail");
  });

  test(`${name}: an EARLIER ${prerequisite} guards a later repeat`, () => {
    const results = checkInvariants([prerequisite, "submit_orders", prerequisite]);
    assert.equal(status(results, name), "pass");
  });
}

// --- cycle-recorded: always applicable, never vacuous ---

test("cycle-recorded: passes when record_cycle appears", () => {
  assert.equal(status(checkInvariants(["record_cycle"]), "cycle-recorded"), "pass");
});

test("cycle-recorded: fails when record_cycle is absent, even on a no-trade cycle", () => {
  const results = checkInvariants(["recall_memory", "manage_positions", "review_performance"]);
  assert.equal(status(results, "cycle-recorded"), "fail");
});

test("cycle-recorded: fails on an empty tool sequence and is never not-applicable", () => {
  const results = checkInvariants([]);
  assert.equal(status(results, "cycle-recorded"), "fail");
  for (const seq of [[], ["submit_orders"], GOOD_CYCLE]) {
    assert.notEqual(status(checkInvariants(seq), "cycle-recorded"), "not-applicable");
  }
});

// --- single-submit ---

test("single-submit: passes on exactly one submit_orders", () => {
  assert.equal(status(checkInvariants(["submit_orders"]), "single-submit"), "pass");
});

test("single-submit: fails on two submit_orders in one cycle", () => {
  const results = checkInvariants(["submit_orders", "submit_orders"]);
  assert.equal(status(results, "single-submit"), "fail");
  assert.match(invariantByName(results, "single-submit")!.detail ?? "", /2/);
});

test("single-submit: not-applicable when nothing was submitted", () => {
  assert.equal(status(checkInvariants(["record_cycle"]), "single-submit"), "not-applicable");
});

// --- vacuity tracking: the whole point of the not-applicable status ---

test("a no-trade cycle is green but reports THREE vacuous guards, not three verified ones", () => {
  const results = checkInvariants([
    "recall_memory",
    "manage_positions",
    "review_performance",
    "get_news",
    "record_cycle",
  ]);
  assert.deepEqual(violatedInvariants(results), []); // nothing broken
  assert.deepEqual(vacuousInvariants(results).map((r) => r.name), [
    "earnings-before-buy",
    "red-team-before-buy",
    "exits-before-entries",
    "single-submit",
  ]);
});

test("a not-applicable invariant always explains why it did not apply", () => {
  for (const r of vacuousInvariants(checkInvariants(["record_cycle"]))) {
    assert.match(r.detail ?? "", /submit_orders/);
  }
});

test("violatedInvariants counts only failures, never vacuous ones", () => {
  const results = checkInvariants(["submit_orders"]); // no earnings, no red team, no exits, no record
  assert.deepEqual(violatedInvariants(results).map((r) => r.name), [
    "earnings-before-buy",
    "red-team-before-buy",
    "exits-before-entries",
    "cycle-recorded",
  ]);
  assert.deepEqual(vacuousInvariants(results), []);
});

// --- input hygiene ---

test("checkInvariants does not mutate the sequence it is given", () => {
  const sequence = [...GOOD_CYCLE];
  checkInvariants(sequence);
  assert.deepEqual(sequence, GOOD_CYCLE);
});

test("unknown tool names are ignored rather than treated as violations", () => {
  const results = checkInvariants(["exa_search", "get_account", "record_cycle"]);
  assert.deepEqual(violatedInvariants(results), []);
});

test("invariantByName returns undefined for a name that is not an invariant", () => {
  assert.equal(invariantByName(checkInvariants([]), "not-a-real-invariant"), undefined);
});
