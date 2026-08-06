import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, violatedInvariants } from "./invariants.ts";
// The rule under test lives in convex/ so the Convex mutation can import it (the Convex
// typecheck config cannot resolve `.ts` specifiers into agent/). The test lives here only
// because that is where the test-runner glob looks.
import {
  decideAppend,
  mergeEventRows,
  mergeQuoteMap,
  MAX_TOOL_SEQUENCE,
  MAX_TRACE_EVENT_ROWS,
  MAX_TRACE_QUOTES,
} from "../../convex/traceAppend.ts";

/** A trace that has already recorded `names` under matching callIds. */
function trace(names: string[]): { toolSequence: string[]; callIds: string[] } {
  return { toolSequence: names, callIds: names.map((_n, i) => `call_${i}`) };
}

/** Apply a decision, the way the mutation does, so a sequence of appends can be simulated. */
function apply(
  existing: { toolSequence: string[]; callIds: string[] },
  toolName: string,
  callId: string,
): { toolSequence: string[]; callIds: string[]; truncated: boolean } {
  const decision = decideAppend(existing, toolName, callId);
  if (decision.kind === "append") {
    return {
      toolSequence: decision.toolSequence,
      callIds: decision.callIds,
      truncated: false,
    };
  }
  return { ...existing, truncated: decision.kind === "truncated" };
}

// --- idempotency on callId ---

test("a fresh callId appends the tool and records the key", () => {
  const decision = decideAppend({ toolSequence: [], callIds: [] }, "recall_memory", "call_0");
  assert.deepEqual(decision, {
    kind: "append",
    toolSequence: ["recall_memory"],
    callIds: ["call_0"],
  });
});

test("THE RESUME CASE: a re-delivered action result is a duplicate, not a second tool call", () => {
  const existing = trace(["submit_orders"]);
  assert.deepEqual(decideAppend(existing, "submit_orders", "call_0"), { kind: "duplicate" });
});

test("re-delivering submit_orders does not record a second tool call", () => {
  // Without dedupe the sequence would hold two submits off one real call. The ordering invariants
  // read the FIRST submit, so a phantom extra one distorts what they are grading.
  const first = apply({ toolSequence: [], callIds: [] }, "submit_orders", "call_0");
  const redelivered = apply(first, "submit_orders", "call_0");
  assert.deepEqual(redelivered.toolSequence, ["submit_orders"]);

  // A genuinely different call (its own callId) IS still recorded.
  const genuine = apply(first, "submit_orders", "call_1");
  assert.deepEqual(genuine.toolSequence, ["submit_orders", "submit_orders"]);
});

// --- mergeEventRows: orders and exits ACCUMULATE across a cycle's several tool calls ---

const ORDER = (ticker: string) => ({ ticker, side: "SELL", status: "placed" });

test("REGRESSION: a later batch of orders does not erase an earlier one", () => {
  // The live bug. Three energy sells went out across two submit_orders calls; the stored orders
  // were overwritten by the last call, so the trace held 2 of 3 while claiming to be COMPLETE.
  // The judge, reading a complete list that lacked a real order, would score an accurate report
  // as a fabrication.
  const first = mergeEventRows(undefined, [ORDER("OXY_US_EQ")]);
  const second = mergeEventRows(first.rows, [ORDER("COP_US_EQ"), ORDER("LNG_US_EQ")]);
  assert.deepEqual(
    second.rows.map((r) => r.ticker),
    ["OXY_US_EQ", "COP_US_EQ", "LNG_US_EQ"],
  );
  assert.equal(second.truncated, false);
});

test("merging is bounded, and reports the drop rather than losing it silently", () => {
  const full = Array.from({ length: MAX_TRACE_EVENT_ROWS }, (_, i) => ORDER(`T${i}`));
  const merged = mergeEventRows(full, [ORDER("ONE_TOO_MANY")]);
  assert.equal(merged.rows.length, MAX_TRACE_EVENT_ROWS);
  assert.equal(merged.truncated, true);
});

test("merging is pure and mutates neither side", () => {
  const existing = [ORDER("KO_US_EQ")];
  const incoming = [ORDER("PEP_US_EQ")];
  mergeEventRows(existing, incoming);
  assert.equal(existing.length, 1);
  assert.equal(incoming.length, 1);
});

test("WHY THE CALLER MUST SKIP A DUPLICATE: merging cannot dedupe by value", () => {
  // Two identical placed orders are a REAL duplicate send, which is precisely what
  // `no-duplicate-orders` exists to catch, so the merge must not collapse them. That makes
  // re-delivery the caller's problem: it is handled by callId, upstream, where "the same event
  // twice" can still be told apart from "the same order twice".
  const batch = [ORDER("COP_US_EQ")];
  const doubled = mergeEventRows(mergeEventRows(undefined, batch).rows, batch);
  assert.equal(doubled.rows.length, 2);
  assert.equal(
    violatedInvariants(
      checkInvariants(["submit_orders"], { orders: doubled.rows }),
    ).some((r) => r.name === "no-duplicate-orders"),
    true,
    "a double-merged batch looks exactly like a duplicate send, which is why the hook must " +
      "skip the context save when the append reports a duplicate",
  );
});

test("a duplicate is detected wherever it sits in the history, not just at the end", () => {
  const existing = trace(["recall_memory", "manage_positions", "review_performance"]);
  assert.deepEqual(decideAppend(existing, "recall_memory", "call_0"), { kind: "duplicate" });
});

test("an empty callId is appended rather than dropped, and never dedupes another", () => {
  // Losing a real tool call would itself produce a false verdict, so an unkeyable result is
  // recorded; it simply cannot be deduplicated.
  const once = apply({ toolSequence: [], callIds: [] }, "get_prices", "");
  assert.deepEqual(once.toolSequence, ["get_prices"]);
  assert.deepEqual(once.callIds, []);
  const twice = apply(once, "get_news", "");
  assert.deepEqual(twice.toolSequence, ["get_prices", "get_news"]);
  assert.deepEqual(twice.callIds, []);
});

test("the same tool name under different callIds is two real calls", () => {
  const first = apply({ toolSequence: [], callIds: [] }, "get_prices", "call_a");
  const second = apply(first, "get_prices", "call_b");
  assert.deepEqual(second.toolSequence, ["get_prices", "get_prices"]);
  assert.deepEqual(second.callIds, ["call_a", "call_b"]);
});

test("decideAppend does not mutate the trace it is given", () => {
  const existing = trace(["recall_memory"]);
  decideAppend(existing, "manage_positions", "call_9");
  assert.deepEqual(existing.toolSequence, ["recall_memory"]);
  assert.deepEqual(existing.callIds, ["call_0"]);
});

// --- the cap is reported, never silent ---

test("at the cap the decision is TRUNCATED, so the caller can mark the trace", () => {
  const full = {
    toolSequence: Array.from({ length: MAX_TOOL_SEQUENCE }, () => "get_prices"),
    callIds: Array.from({ length: MAX_TOOL_SEQUENCE }, (_v, i) => `call_${i}`),
  };
  assert.deepEqual(decideAppend(full, "record_cycle", "call_new"), { kind: "truncated" });
});

test("one below the cap still appends", () => {
  const nearlyFull = {
    toolSequence: Array.from({ length: MAX_TOOL_SEQUENCE - 1 }, () => "get_prices"),
    callIds: Array.from({ length: MAX_TOOL_SEQUENCE - 1 }, (_v, i) => `call_${i}`),
  };
  const decision = decideAppend(nearlyFull, "record_cycle", "call_new");
  assert.equal(decision.kind, "append");
  assert.equal(decision.kind === "append" && decision.toolSequence.length, MAX_TOOL_SEQUENCE);
});

test("a dropped record_cycle past the cap must NOT be reported as a violation", () => {
  // The end-to-end shape of fix 3: the cap swallows record_cycle, the trace is marked
  // truncated, and checkInvariants downgrades the absence to not-applicable.
  let current = {
    toolSequence: Array.from({ length: MAX_TOOL_SEQUENCE }, () => "get_prices"),
    callIds: Array.from({ length: MAX_TOOL_SEQUENCE }, (_v, i) => `call_${i}`),
    truncated: false,
  };
  current = apply(current, "record_cycle", "call_new");
  assert.equal(current.truncated, true);
  assert.equal(current.toolSequence.includes("record_cycle"), false);

  const graded = checkInvariants(current.toolSequence, { truncated: current.truncated });
  assert.deepEqual(violatedInvariants(graded), []);
  // Same trace WITHOUT the truncation flag is a false violation: the flag is what prevents it.
  assert.ok(
    violatedInvariants(checkInvariants(current.toolSequence)).some(
      (r) => r.name === "cycle-recorded",
    ),
  );
});

test("a duplicate is recognised even at the cap, so the cap cannot mask a re-delivery", () => {
  const full = {
    toolSequence: Array.from({ length: MAX_TOOL_SEQUENCE }, () => "get_prices"),
    callIds: Array.from({ length: MAX_TOOL_SEQUENCE }, (_v, i) => `call_${i}`),
  };
  assert.deepEqual(decideAppend(full, "get_prices", "call_5"), { kind: "duplicate" });
});

test("the cap is a bound a real cycle never approaches", () => {
  // A cycle makes a few dozen tool calls; the cap exists for a runaway turn, not normal use.
  assert.ok(MAX_TOOL_SEQUENCE >= 100);
});

// --- the quoted-price map: merged across calls, and BOUNDED ---
//
// A cycle calls get_prices several times, so the stored map has to accumulate rather than
// overwrite: a report quoting a price fetched in the first batch must still be checkable after
// the third. Cumulative growth is exactly why the cap lives here, next to the tool-sequence cap,
// where the existing state is visible.

test("quotes from a later call merge into the ones already recorded", () => {
  const first = mergeQuoteMap(undefined, { AMZN: 231.4 });
  assert.deepEqual(first, { quotes: { AMZN: 231.4 }, truncated: false });
  assert.deepEqual(mergeQuoteMap(first.quotes, { KO: 71.2, SBUX: 96.4 }), {
    quotes: { AMZN: 231.4, KO: 71.2, SBUX: 96.4 },
    truncated: false,
  });
});

test("a re-quoted ticker takes the latest price rather than duplicating", () => {
  assert.deepEqual(mergeQuoteMap({ AMZN: 231.4 }, { AMZN: 232.9 }), {
    quotes: { AMZN: 232.9 },
    truncated: false,
  });
});

test("the map is capped, and a dropped quote is reported rather than silently lost", () => {
  const full = Object.fromEntries(
    Array.from({ length: MAX_TRACE_QUOTES }, (_v, i) => [`T${i}`, i + 1]),
  );
  const merged = mergeQuoteMap(full, { LATE: 99 });
  assert.equal(Object.keys(merged.quotes).length, MAX_TRACE_QUOTES);
  assert.equal(merged.quotes.LATE, undefined);
  assert.equal(merged.truncated, true);
});

test("at the cap, updating a ticker already in the map still works", () => {
  // It cannot grow the document, and refusing it would leave a stale price in the ground truth.
  const full = Object.fromEntries(
    Array.from({ length: MAX_TRACE_QUOTES }, (_v, i) => [`T${i}`, i + 1]),
  );
  const merged = mergeQuoteMap(full, { T0: 1_000 });
  assert.equal(merged.quotes.T0, 1_000);
  assert.equal(merged.truncated, false);
});

test("merging quotes is pure and mutates neither side", () => {
  const existing = { AMZN: 231.4 };
  const incoming = { KO: 71.2 };
  mergeQuoteMap(existing, incoming);
  assert.deepEqual(existing, { AMZN: 231.4 });
  assert.deepEqual(incoming, { KO: 71.2 });
});
