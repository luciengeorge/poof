import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldCatchUp } from "./cycle-catch-up.ts";

const NOW = new Date("2026-10-28T18:20:00Z");
const YESTERDAY = { firedAt: Date.parse("2026-10-27T15:41:08Z") };
const YESTERDAYS_TRACE = [Date.parse("2026-10-27T15:41:30Z")];

test("REGRESSION (2026-10-28): no heartbeat and no trace today means catch up", () => {
  assert.equal(shouldCatchUp(YESTERDAY, YESTERDAYS_TRACE, NOW), true);
});

test("a cycle that fired today is never run twice", () => {
  assert.equal(shouldCatchUp({ firedAt: Date.parse("2026-10-28T15:41:08Z") }, [], NOW), false);
  assert.equal(shouldCatchUp({ firedAt: Date.parse("2026-10-28T00:00:00Z") }, [], NOW), false);
});

test("a cycle whose heartbeat write failed is still seen through its trace", () => {
  // cycle.ts dispatches even when recordCronRun fails, so the heartbeat alone is not proof.
  assert.equal(shouldCatchUp(YESTERDAY, [Date.parse("2026-10-28T15:41:30Z")], NOW), false);
});

test("any unreadable signal never dispatches: a duplicate cycle is worse than a missed day", () => {
  assert.equal(shouldCatchUp("unreadable", [], NOW), false);
  assert.equal(shouldCatchUp(YESTERDAY, "unreadable", NOW), false);
});

test("no heartbeat ever, or a malformed one, with no trace today, catches up", () => {
  assert.equal(shouldCatchUp(null, [], NOW), true);
  assert.equal(shouldCatchUp({ firedAt: "yesterday" }, [], NOW), true);
});

test("the catch-up writes the cycle heartbeat BEFORE dispatching, and checks market hours", () => {
  const src = readFileSync(new URL("../schedules/cycle-catch-up.ts", import.meta.url), "utf8");
  assert.match(src, /cron: "0 18 \* \* 1-5"/);
  assert.match(src, /isUsMarketOpen\(now\)/);
  // Keyed on startedAt: a cycle that died mid-way has no completedAt and must still count.
  assert.match(src, /cycleTraceStartsSince\(tradingEnv\(\)/);
  assert.doesNotMatch(src, /recentCycleTraces/);
  const heartbeat = src.indexOf('recordCronRun({ schedule: "cycle"');
  const dispatch = src.indexOf("receive(slack");
  assert.ok(heartbeat > 0 && dispatch > heartbeat, "heartbeat must be written before the dispatch");
  assert.match(src, /heartbeat write failed, not dispatching[^]*?return;/);
});
