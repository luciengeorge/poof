import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CYCLE_WINDOW_CLOSES_UTC_HOUR,
  heartbeatUtcDay,
  lastExpectedCycleDay,
} from "./cron-watchdog.ts";

const at = (iso: string): Date => new Date(iso);

test("the real incident: a run delayed past midnight checks YESTERDAY, not today", () => {
  // 2026-08-27's 16:10 UTC watchdog was delayed ~9h by GitHub and ran at 00:51 UTC on the
  // 28th. The old code asked for a Friday heartbeat 14 hours before Friday's cycle was due
  // and paged a human at 1:51am. It must ask about Thursday.
  assert.equal(lastExpectedCycleDay(at("2026-08-28T00:51:12Z")), "2026-08-27");
});

test("an on-time run after the window closes checks today", () => {
  assert.equal(lastExpectedCycleDay(at("2026-08-28T16:10:00Z")), "2026-08-28");
});

test("the window is not closed until 16:00 UTC, because Hobby jitter allows 15:00-15:59", () => {
  // 15:59 is still inside a legitimate fire window, so today cannot yet be overdue.
  assert.equal(lastExpectedCycleDay(at("2026-08-28T15:59:59Z")), "2026-08-27");
  assert.equal(lastExpectedCycleDay(at("2026-08-28T16:00:00Z")), "2026-08-28");
  assert.equal(CYCLE_WINDOW_CLOSES_UTC_HOUR, 16);
});

test("weekends fall back to Friday, since the cycle does not run at weekends", () => {
  // 2026-08-29 is a Saturday, 2026-08-30 a Sunday, 2026-08-28 the preceding Friday.
  assert.equal(lastExpectedCycleDay(at("2026-08-29T16:10:00Z")), "2026-08-28");
  assert.equal(lastExpectedCycleDay(at("2026-08-30T16:10:00Z")), "2026-08-28");
});

test("early Monday falls back across the whole weekend to Friday", () => {
  // 2026-08-31 is a Monday. Before its window closes, the last expected day is Friday the 28th.
  assert.equal(lastExpectedCycleDay(at("2026-08-31T00:30:00Z")), "2026-08-28");
});

test("Monday after its window closes checks Monday", () => {
  assert.equal(lastExpectedCycleDay(at("2026-08-31T16:10:00Z")), "2026-08-31");
});

test("heartbeatUtcDay reads the UTC day from a timestamp", () => {
  assert.equal(heartbeatUtcDay(Date.parse("2026-08-27T15:13:54.045Z")), "2026-08-27");
  // Late-evening UTC must not roll into the next day.
  assert.equal(heartbeatUtcDay("2026-08-27T23:59:59Z"), "2026-08-27");
});

test("the delayed run would have found Thursday's real heartbeat and stayed silent", () => {
  // End to end on the actual incident data: expected day matches the heartbeat that existed,
  // so no alert. This is the assertion that would have prevented the 1:51am page.
  const expected = lastExpectedCycleDay(at("2026-08-28T00:51:12Z"));
  const actual = heartbeatUtcDay("2026-08-27T15:13:54.045Z");
  assert.equal(expected, actual);
});
