import { test } from "node:test";
import assert from "node:assert/strict";
// The rule lives in convex/ so the mutation can enforce it too (the Convex typecheck cannot
// resolve .ts specifiers into agent/). The test lives here because that is where the glob looks.
import {
  admitEdits,
  CLASS_CAPS,
  decayed,
  MAX_EDITS_PER_CYCLE,
  OBSERVATION_TTL_MS,
  type Edit,
  type MemoryRow,
} from "../../convex/memoryPolicy.ts";

const NOW = 1_785_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: over.id ?? "r1",
    class: over.class ?? "lesson",
    category: over.category ?? "execution",
    condition: over.condition ?? "IF a full close is rejected",
    action: over.action ?? "prefer a partial de-risk",
    provenance: over.provenance ?? "agent",
    confidence: over.confidence ?? 0.8,
    createdAt: over.createdAt ?? NOW - DAY,
    lastConfirmedAt: over.lastConfirmedAt ?? NOW - DAY,
    ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
  };
}

let nextId = 0;
const add = (over: Partial<Extract<Edit, { op: "add" }>> = {}): Edit => ({
  op: "add",
  id: `m${(nextId += 1)}`,
  class: "lesson",
  category: "execution",
  condition: "IF a stock is above $300",
  action: "do not open a tiny position in it",
  provenance: "agent",
  reason: "the ORCL sizing attempt failed on minimum quantity",
  ...over,
});

/** Which policy rule rejected this edit, or "admitted". */
function verdict(decisions: ReturnType<typeof admitEdits>, index = 0): string {
  const d = decisions[index];
  assert.ok(d, `expected a decision at ${index}`);
  return d.admitted ? "admitted" : (d.rule ?? "rejected-without-rule");
}

// --- the budget: atomic edits, never a rewrite ---

test("a normal atomic add is admitted", () => {
  assert.equal(verdict(admitEdits([], [add()], NOW)), "admitted");
});

test("REGRESSION: more than three edits in one cycle is a rewrite in disguise", () => {
  // The whole point of the redesign. SHARP's ablation: free-form full rewrites score -12.1%
  // where bounded atomic edits score +33.2%, because credit cannot be assigned to a rewrite.
  const edits = Array.from({ length: MAX_EDITS_PER_CYCLE + 2 }, (_, i) =>
    add({ condition: `IF condition number ${i}` }),
  );
  const decisions = admitEdits([], edits, NOW);
  assert.equal(decisions.filter((d) => d.admitted).length, MAX_EDITS_PER_CYCLE);
  assert.equal(verdict(decisions, MAX_EDITS_PER_CYCLE), "edit-budget");
});

test("every edit must carry a reason, so a change is always attributable", () => {
  assert.equal(verdict(admitEdits([], [add({ reason: "  " })], NOW)), "reason-required");
});

// --- provenance precedence: "user statement > agent inference" ---

test("the agent cannot invent a directive: those are Lucien's or a hard constraint", () => {
  assert.equal(
    verdict(admitEdits([], [add({ class: "directive", provenance: "agent" })], NOW)),
    "directive-needs-user",
  );
});

test("a user-sourced directive IS admitted", () => {
  assert.equal(
    verdict(admitEdits([], [add({ class: "directive", provenance: "user" })], NOW)),
    "admitted",
  );
});

test("the agent cannot retire a directive, however much it dislikes it", () => {
  const existing = [row({ id: "d1", class: "directive", provenance: "user" })];
  const decisions = admitEdits(
    existing,
    [{ op: "retire", id: "d1", reason: "it blocked a trade I wanted" }],
    NOW,
  );
  assert.equal(verdict(decisions), "directive-needs-user");
});

test("a lesson that contradicts a directive loses to the directive", () => {
  const existing = [
    row({
      id: "d1",
      class: "directive",
      provenance: "user",
      condition: "IF the instrument is a US-domiciled ETF",
      action: "never buy it",
    }),
  ];
  const decisions = admitEdits(
    existing,
    [
      add({
        class: "lesson",
        condition: "IF the instrument is a US-domiciled ETF",
        action: "buy it when momentum is strong",
      }),
    ],
    NOW,
  );
  assert.equal(verdict(decisions), "conflicts-with-directive");
});

// --- caps, with forced parsimony instead of silent eviction ---

test("at the lesson cap, an add is refused unless the same batch retires one", () => {
  const full = Array.from({ length: CLASS_CAPS.lesson }, (_, i) =>
    row({ id: `l${i}`, condition: `IF case ${i}` }),
  );
  assert.equal(verdict(admitEdits(full, [add()], NOW)), "class-cap");

  const withRetire = admitEdits(
    full,
    [{ op: "retire", id: "l0", reason: "it misfired on three separate cycles" }, add()],
    NOW,
  );
  assert.equal(verdict(withRetire, 0), "admitted");
  assert.equal(verdict(withRetire, 1), "admitted");
});

test("a directive at cap is never silently evicted to make room", () => {
  const full = Array.from({ length: CLASS_CAPS.directive }, (_, i) =>
    row({ id: `d${i}`, class: "directive", provenance: "user", condition: `IF rule ${i}` }),
  );
  const decisions = admitEdits(
    full,
    [add({ class: "directive", provenance: "user", condition: "IF something new" })],
    NOW,
  );
  assert.equal(verdict(decisions), "class-cap");
});

// --- dedupe and computed statistics ---

test("an exact duplicate is refused rather than stored twice", () => {
  const existing = [row({ condition: "IF a full close is rejected", action: "prefer a partial de-risk" })];
  const decisions = admitEdits(
    existing,
    [add({ condition: "if a FULL close is rejected  ", action: "Prefer a partial de-risk." })],
    NOW,
  );
  assert.equal(verdict(decisions), "duplicate");
});

test("REGRESSION: computed statistics may never occupy a memory slot", () => {
  // A slot was previously wasted restating per-tag numbers that `review_performance` recomputes
  // and passes in fresh every cycle. Durable memory is for rules, not for arithmetic.
  for (const text of [
    "other = 6W/5L, 50% win rate across 12 closed trades",
    "the win rate is currently 50 percent",
    "total P&L is GBP 1.92 over 12 closed trades",
  ]) {
    assert.equal(
      verdict(admitEdits([], [add({ action: text })], NOW)),
      "computed-stat",
      `should refuse: ${text}`,
    );
  }
});

test("a rule that merely mentions a number is not mistaken for a statistic", () => {
  assert.equal(
    verdict(admitEdits([], [add({ action: "do not open a position above $300" })], NOW)),
    "admitted",
  );
});

// --- editing and retiring by id ---

test("modifying or retiring an unknown id is refused, not silently ignored", () => {
  assert.equal(
    verdict(admitEdits([], [{ op: "retire", id: "nope", reason: "stale" }], NOW)),
    "unknown-target",
  );
  assert.equal(
    verdict(admitEdits([], [{ op: "modify", id: "nope", action: "x", reason: "y" }], NOW)),
    "unknown-target",
  );
});

// --- decay and expiry: an unconfirmed belief must not harden into a fact ---

test("an observation expires on its own, so one regime does not become permanent", () => {
  const fresh = row({ class: "observation", createdAt: NOW - DAY, lastConfirmedAt: NOW - DAY });
  const old = row({
    id: "o2",
    class: "observation",
    createdAt: NOW - OBSERVATION_TTL_MS - DAY,
    lastConfirmedAt: NOW - OBSERVATION_TTL_MS - DAY,
  });
  const live = decayed([fresh, old], NOW);
  assert.deepEqual(live.active.map((r) => r.id), ["r1"]);
  assert.deepEqual(live.expired.map((r) => r.id), ["o2"]);
});

test("a directive never expires, however long it sits unconfirmed", () => {
  const ancient = row({
    id: "d1",
    class: "directive",
    provenance: "user",
    createdAt: NOW - 400 * DAY,
    lastConfirmedAt: NOW - 400 * DAY,
  });
  const live = decayed([ancient], NOW);
  assert.deepEqual(live.active.map((r) => r.id), ["d1"]);
  assert.equal(live.active[0]?.confidence, ancient.confidence, "and its confidence is untouched");
});

test("a lesson's confidence decays while unconfirmed, but it is not deleted", () => {
  const stale = row({ confidence: 0.9, lastConfirmedAt: NOW - 60 * DAY });
  const live = decayed([stale], NOW);
  assert.equal(live.expired.length, 0);
  assert.ok(
    (live.active[0]?.confidence ?? 1) < 0.9,
    "an unreconfirmed lesson should weaken rather than stand as fact",
  );
});

test("reconfirmation restores a lesson's standing", () => {
  const confirmed = decayed([row({ confidence: 0.9, lastConfirmedAt: NOW })], NOW);
  assert.equal(confirmed.active[0]?.confidence, 0.9);
});

test("an added memory needs a stable semantic id, and cannot reuse one", () => {
  const existing = [row({ id: "broker_min_position" })];
  assert.equal(
    verdict(admitEdits(existing, [add({ id: "broker_min_position" })], NOW)),
    "duplicate-id",
  );
  assert.equal(verdict(admitEdits([], [add({ id: "  " })], NOW)), "duplicate-id");
});
