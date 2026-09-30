import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CORE_TICKER } from "./core.ts";

// The prompt has no logic to unit-test, only content, and its content is the behaviour: it once
// told the agent to trade every cycle and to lower its bar until something qualified. With no
// measured stock-picking edge and about 0.3% of FX paid on every US round trip, that bought a
// certain cost for no expected gain. These tests keep that rule from coming back in a later edit.
const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");

const FORBIDDEN = [
  "opening at least one position each cycle",
  "lower your bar",
  "are NOT reasons to sit out",
  "cash guarantees you lose to SPY",
  "cash can't beat SPY",
  "2%-of-equity floor",
  "bias sizing/selection toward strategy types",
];

for (const phrase of FORBIDDEN) {
  test(`instructions no longer say "${phrase}"`, () => {
    assert.equal(instructions.includes(phrase), false);
  });
}

test("instructions name the index core as the default home for money", () => {
  assert.ok(instructions.includes(CORE_TICKER), `expected ${CORE_TICKER} in agent/instructions.md`);
});

test("instructions say a cycle with no stock trade is normal", () => {
  assert.match(instructions, /a cycle with no stock trade is normal/i);
});
