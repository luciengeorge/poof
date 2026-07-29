import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, violatedInvariants } from "./invariants.ts";
// The rule under test lives in convex/ so the Convex mutation can import it (the Convex
// typecheck config cannot resolve `.ts` specifiers into agent/). The test lives here only
// because that is where the test-runner glob looks.
import { decideAppend, MAX_TOOL_SEQUENCE } from "../../convex/traceAppend.ts";

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

test("re-delivering submit_orders no longer false-trips single-submit", () => {
  // This is the whole point: without dedupe the sequence would hold two submits and the
  // invariant would report a violation that never happened, which erodes trust in every alert.
  const first = apply({ toolSequence: [], callIds: [] }, "submit_orders", "call_0");
  const redelivered = apply(first, "submit_orders", "call_0");
  assert.deepEqual(redelivered.toolSequence, ["submit_orders"]);
  const results = checkInvariants(redelivered.toolSequence);
  assert.equal(
    violatedInvariants(results).some((r) => r.name === "single-submit"),
    false,
  );

  // A genuinely different call (its own callId) IS still recorded and still trips the guard.
  const genuine = apply(first, "submit_orders", "call_1");
  assert.deepEqual(genuine.toolSequence, ["submit_orders", "submit_orders"]);
  assert.ok(
    violatedInvariants(checkInvariants(genuine.toolSequence)).some(
      (r) => r.name === "single-submit",
    ),
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
