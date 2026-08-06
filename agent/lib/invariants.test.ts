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
  "memory_gate",
  "amend_memory",
];

/**
 * One clean order, for the cases whose subject is ORDERING rather than duplication. Without it
 * `no-duplicate-orders` is correctly not-applicable (submits happened but no orders were
 * observed), which would make these assertions about a different thing than they intend.
 */
const ONE_CLEAN_ORDER = [{ ticker: "KO_US_EQ", side: "BUY", status: "placed" }];

test("every invariant is reported exactly once, in a stable order", () => {
  const results = checkInvariants(GOOD_CYCLE);
  assert.deepEqual(
    results.map((r) => r.name),
    [...INVARIANT_NAMES],
  );
});

test("a complete, well-ordered cycle passes every invariant", () => {
  const results = checkInvariants(GOOD_CYCLE, { orders: ONE_CLEAN_ORDER });
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

// --- no-duplicate-orders ---
//
// This replaced a count of submit_orders calls. The REGRESSION tests below pin the live cycle
// that proved the count wrong: multiple submits with no duplicate send is correct behaviour and
// must not alert.

const SENT = (ticker: string, side: string) => ({ ticker, side, status: "placed" });

test("no-duplicate-orders: passes when each instrument was sent once", () => {
  const results = checkInvariants(["submit_orders"], {
    orders: [SENT("COP_US_EQ", "SELL"), SENT("LNG_US_EQ", "SELL")],
  });
  assert.equal(status(results, "no-duplicate-orders"), "pass");
});

test("no-duplicate-orders: fails when the same instrument and side reached the broker twice", () => {
  const results = checkInvariants(["submit_orders"], {
    orders: [SENT("COP_US_EQ", "SELL"), SENT("COP_US_EQ", "SELL")],
  });
  assert.equal(status(results, "no-duplicate-orders"), "fail");
  assert.match(invariantByName(results, "no-duplicate-orders")!.detail ?? "", /COP_US_EQ SELL/);
});

test("REGRESSION: several submit_orders calls are NOT a violation on their own", () => {
  // The old invariant counted calls and failed this. The agent submits sells and buys separately,
  // so a cycle like this is routine and correct.
  const results = checkInvariants(["submit_orders", "submit_orders", "submit_orders"], {
    orders: [SENT("OXY_US_EQ", "SELL"), SENT("COP_US_EQ", "SELL"), SENT("LNG_US_EQ", "SELL")],
  });
  assert.equal(status(results, "no-duplicate-orders"), "pass");
});

test("REGRESSION: a rejected attempt then a placed retry of the same name is NOT a duplicate", () => {
  // The exact live shape: full close rejected on the broker's minimum-position rule, then a
  // workable partial placed. One order was sent, not two.
  const results = checkInvariants(["submit_orders", "submit_orders"], {
    orders: [
      { ticker: "OXY_US_EQ", side: "SELL", status: "rejected" },
      SENT("OXY_US_EQ", "SELL"),
    ],
  });
  assert.equal(status(results, "no-duplicate-orders"), "pass");
});

test("no-duplicate-orders: a skipped order never counts as sent", () => {
  const results = checkInvariants(["submit_orders"], {
    orders: [
      { ticker: "SHOP_US_EQ", side: "BUY", status: "skipped" },
      { ticker: "SHOP_US_EQ", side: "BUY", status: "skipped" },
    ],
  });
  assert.equal(status(results, "no-duplicate-orders"), "pass");
});

test("no-duplicate-orders: opposite sides of one instrument are not duplicates", () => {
  const results = checkInvariants(["submit_orders"], {
    orders: [SENT("KO_US_EQ", "BUY"), SENT("KO_US_EQ", "SELL")],
  });
  assert.equal(status(results, "no-duplicate-orders"), "pass");
});

test("no-duplicate-orders: not-applicable when nothing was submitted", () => {
  assert.equal(status(checkInvariants(["record_cycle"]), "no-duplicate-orders"), "not-applicable");
});

test("no-duplicate-orders: not-applicable when orders were not recorded at all", () => {
  // Absence of order data is an observability gap, never proof of a clean cycle OR a dirty one.
  const results = checkInvariants(["submit_orders"]);
  assert.equal(status(results, "no-duplicate-orders"), "not-applicable");
  assert.match(invariantByName(results, "no-duplicate-orders")!.detail ?? "", /not recorded/);
});

test("no-duplicate-orders: a TRUNCATED order list cannot convict", () => {
  const results = checkInvariants(["submit_orders"], {
    orders: [SENT("COP_US_EQ", "SELL"), SENT("COP_US_EQ", "SELL")],
    ordersTruncated: true,
  });
  assert.equal(status(results, "no-duplicate-orders"), "not-applicable");
});

test("a duplicate send is still a violation on a truncated TOOL sequence", () => {
  // Truncation of the tool sequence says nothing about the orders, which were fully observed.
  const results = checkInvariants(["submit_orders"], {
    truncated: true,
    orders: [SENT("COP_US_EQ", "SELL"), SENT("COP_US_EQ", "SELL")],
  });
  assert.equal(status(results, "no-duplicate-orders"), "fail");
});

// --- vacuity tracking: the whole point of the not-applicable status ---

test("a no-trade cycle is green but reports FIVE vacuous guards, not five verified ones", () => {
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
    "no-duplicate-orders",
    "memory-gate-before-amend",
  ]);
});

test("a not-applicable invariant always explains why it did not apply", () => {
  // Each guard names the TOOL that would have exercised it, which differs per guard: the trading
  // guards wait on submit_orders, the memory guard on amend_memory. What matters is that a vacuous
  // result is never silent about which path was not reached.
  for (const r of vacuousInvariants(checkInvariants(["record_cycle"]))) {
    assert.match(r.detail ?? "", /submit_orders|amend_memory/);
    assert.match(r.detail ?? "", /never exercised|not recorded/);
  }
});

test("violatedInvariants counts only failures, never vacuous ones", () => {
  // Orders supplied so the duplicate guard is decided rather than vacuous: the subject here is
  // which ORDERING failures are counted.
  const results = checkInvariants(["submit_orders"], { orders: ONE_CLEAN_ORDER });
  assert.deepEqual(violatedInvariants(results).map((r) => r.name), [
    "earnings-before-buy",
    "red-team-before-buy",
    "exits-before-entries",
    "cycle-recorded",
  ]);
  // The memory guard is vacuous here: this cycle never touched memory, which is not a fault.
  assert.deepEqual(vacuousInvariants(results).map((r) => r.name), ["memory-gate-before-amend"]);
});

// --- truncation: an UNKNOWN must never masquerade as a violation ---

test("a truncated trace turns absence-based failures into not-applicable, not fail", () => {
  // record_cycle runs at the very end of a cycle, so it is exactly the tool a cap would drop.
  const truncated = checkInvariants(["submit_orders"], {
    truncated: true,
    orders: ONE_CLEAN_ORDER,
  });
  assert.deepEqual(violatedInvariants(truncated), []);
  assert.deepEqual(vacuousInvariants(truncated).map((r) => r.name), [
    "earnings-before-buy",
    "red-team-before-buy",
    "exits-before-entries",
    "cycle-recorded",
    "memory-gate-before-amend",
  ]);
  // The same sequence WITHOUT truncation is four real violations: truncation is the only
  // difference, so a cap can no longer silently change a verdict into a false alert.
  assert.equal(
    violatedInvariants(checkInvariants(["submit_orders"], { orders: ONE_CLEAN_ORDER })).length,
    4,
  );
});

test("a truncated trace still fails an OBSERVED ordering violation", () => {
  // Positive evidence, not absence: the earnings check demonstrably ran after the submit. A
  // truncated tail cannot undo something already recorded, so this must stay a violation.
  const results = checkInvariants(["submit_orders", "get_earnings_calendar"], {
    truncated: true,
  });
  assert.equal(status(results, "earnings-before-buy"), "fail");
});

test("a truncated trace still fails an OBSERVED duplicate send", () => {
  const results = checkInvariants(["submit_orders"], {
    truncated: true,
    orders: [
      { ticker: "COP_US_EQ", side: "SELL", status: "placed" },
      { ticker: "COP_US_EQ", side: "SELL", status: "placed" },
    ],
  });
  assert.equal(status(results, "no-duplicate-orders"), "fail");
});

test("a truncated trace still passes what it positively observed", () => {
  const results = checkInvariants(
    [
      "manage_positions",
      "get_earnings_calendar",
      "red_team",
      "submit_orders",
      "record_cycle",
      "memory_gate",
      "amend_memory",
    ],
    { truncated: true, orders: ONE_CLEAN_ORDER },
  );
  for (const r of results) {
    assert.equal(r.status, "pass", `${r.name}: ${r.detail ?? ""}`);
  }
});

test("every truncation-degraded result SAYS it was truncated, so it is never silent", () => {
  const truncated = checkInvariants([], { truncated: true });
  for (const r of vacuousInvariants(truncated)) {
    assert.match(r.detail ?? "", /TRUNCATED/);
  }
});

test("truncated defaults to false, so existing callers are unaffected", () => {
  assert.deepEqual(checkInvariants(["submit_orders"]), checkInvariants(["submit_orders"], {}));
  assert.deepEqual(
    checkInvariants(["submit_orders"]),
    checkInvariants(["submit_orders"], { truncated: false }),
  );
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
