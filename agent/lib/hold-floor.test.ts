import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_EXITS } from "./exits.ts";
import { applyHoldFloor, MIN_MAX_HOLD_DAYS } from "./hold-floor.ts";
import type { Proposal } from "./orders.ts";

const NOW = Date.parse("2026-09-17T14:00:00Z");
const DAY = 86_400_000;
const iso = (daysAhead: number) => new Date(NOW + daysAhead * DAY).toISOString().slice(0, 10);

function buy(over: Partial<Proposal> = {}): Proposal {
  return { ticker: "NVDA_US_EQ", side: "BUY", notional: 50, price: 100, thesis: "t", ...over };
}

test("a reflexive short hold with no earnings date is dropped so the default applies", () => {
  // The live pattern: 35 of 51 BUYs stamped 10 with no time-bound reason.
  const { proposals, notes } = applyHoldFloor([buy({ maxHoldDays: 10 })], NOW);
  assert.equal(proposals[0]?.maxHoldDays, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /dropped/);
  assert.match(notes[0] ?? "", new RegExp(`${DEFAULT_EXITS.defaultMaxHoldDays}-day default`));
});

test("a hold at or above the floor is left alone", () => {
  const { proposals, notes } = applyHoldFloor(
    [buy({ maxHoldDays: MIN_MAX_HOLD_DAYS }), buy({ maxHoldDays: 30 }), buy()],
    NOW,
  );
  assert.equal(proposals[0]?.maxHoldDays, MIN_MAX_HOLD_DAYS);
  assert.equal(proposals[1]?.maxHoldDays, 30);
  assert.equal(proposals[2]?.maxHoldDays, undefined);
  assert.deepEqual(notes, []);
});

test("an earnings print inside the window keeps a short hold that ends before it", () => {
  // Earnings in 8 days, hold of 6: legitimate, unchanged.
  const { proposals, notes } = applyHoldFloor(
    [buy({ maxHoldDays: 6, earningsDate: iso(8) })],
    NOW,
  );
  assert.equal(proposals[0]?.maxHoldDays, 6);
  assert.deepEqual(notes, []);
});

test("a short hold that would still run through the print is pulled to the session before", () => {
  const { proposals, notes } = applyHoldFloor(
    [buy({ maxHoldDays: 10, earningsDate: iso(8) })],
    NOW,
  );
  assert.equal(proposals[0]?.maxHoldDays, 7);
  assert.match(notes[0] ?? "", /session before earnings/);
});

test("an earnings date outside the default window does not justify a short hold", () => {
  // Earnings in 40 days is not the reason for a 10-day clock.
  const { proposals } = applyHoldFloor(
    [buy({ maxHoldDays: 10, earningsDate: iso(40) })],
    NOW,
  );
  assert.equal(proposals[0]?.maxHoldDays, undefined);
});

test("an unparseable or past earnings date is treated as absent", () => {
  const { proposals } = applyHoldFloor(
    [buy({ maxHoldDays: 10, earningsDate: "soon" }), buy({ maxHoldDays: 10, earningsDate: iso(-3) })],
    NOW,
  );
  assert.equal(proposals[0]?.maxHoldDays, undefined);
  assert.equal(proposals[1]?.maxHoldDays, undefined);
});

test("SELLs are never touched", () => {
  const sell: Proposal = { ...buy({ maxHoldDays: 3 }), side: "SELL" };
  const { proposals, notes } = applyHoldFloor([sell], NOW);
  assert.equal(proposals[0]?.maxHoldDays, 3);
  assert.deepEqual(notes, []);
});

test("submit_orders applies the hold floor before the gate (structural)", () => {
  // Mutation testing showed the unit tests above stay green if submit_orders never calls
  // applyHoldFloor. The tool is the only place the floor can take effect, so its source must
  // show the call, on the proposals, before the external-holdings partition and the gate.
  const src = readFileSync(new URL("../tools/submit_orders.ts", import.meta.url), "utf8");
  const call = src.indexOf("applyHoldFloor(proposals)");
  const partition = src.indexOf("partitionExternalHoldingBuys(");
  const gate = src.indexOf("evaluateAndExecute(");
  assert.ok(call > 0, "submit_orders must call applyHoldFloor on the incoming proposals");
  assert.ok(call < partition && partition < gate, "the floor must run before partition and gate");
  assert.match(src, /floored\.proposals/, "the floored proposals, not the raw ones, must flow on");
});
