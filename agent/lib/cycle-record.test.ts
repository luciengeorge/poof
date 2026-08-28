import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleRecordWithFx } from "./cycle-record.ts";

test("cycle records persist the resolved FX rate and source", () => {
  const record = cycleRecordWithFx({
    env: "live",
    equity: 247.82,
    freeCash: 150.38,
    decision: "no-trade",
    rationale: "No qualifying setup.",
    fx: { rate: 0.75094, source: "live" },
  });

  assert.equal(record.fxRate, 0.75094);
  assert.equal(record.fxSource, "live");
});
