import { test } from "node:test";
import assert from "node:assert/strict";
import { nextResearchSession, researchDay, researchSession, shadowTick } from "../../../convex/shadowCalendar.ts";
import { canonicalUrl, newsEligibility, relativeOutcome, startPair, storyKey } from "./policy.ts";
import { shadowDue, shadowEnabled } from "./run.ts";
import { runShadowSchedule } from "./schedule.ts";
import { shadowReport } from "./report.ts";

const at = Date.parse;
test("calendar handles DST, Thanksgiving, early closes, and fails closed outside its version", () => {
  assert.equal(researchDay(at("2026-11-12T01:00Z")), "2026-11-11");
  assert.deepEqual(researchSession("2026-03-06"), { day: "2026-03-06", open: at("2026-03-06T14:30Z"), close: at("2026-03-06T21:00Z") });
  assert.deepEqual(researchSession("2026-03-09"), { day: "2026-03-09", open: at("2026-03-09T13:30Z"), close: at("2026-03-09T20:00Z") });
  assert.equal(researchSession("2026-11-26"), null);
  assert.equal(researchSession("2028-01-03"), "unsupported");
  assert.equal(nextResearchSession(at("2026-11-25T20:00Z"))?.close, at("2026-11-27T18:00Z"));
  assert.equal(nextResearchSession(at("2026-11-27T14:30Z"))?.day, "2026-11-30");
  assert.equal(nextResearchSession(at("2026-12-31T22:00Z"))?.day, "2027-01-04");
  assert.equal(shadowDue("news", at("2026-11-27T18:00Z")), false);
  assert.equal(shadowDue("news", at("2026-11-11T15:30Z")), false);
  assert.equal(shadowDue("news", at("2026-11-11T16:31Z")), false);
  assert.equal(shadowDue("positions", at("2026-11-11T16:32Z")), true);
  assert.equal(shadowDue("news", at("2026-11-11T16:30Z")), true);
  assert.ok("reason" in shadowTick(at("2026-11-14T16:30Z"), 15));
});
test("all modes default off, require separate quota confirmation, and do not construct network clients", async () => {
  for (const kind of ["positions", "news", "score"] as const) {
    assert.equal(shadowEnabled({}, kind), false);
    const configured = { SHADOW_RESEARCH_ENABLED: "true", [`SHADOW_${kind.toUpperCase()}_ENABLED`]: "true" };
    assert.equal(shadowEnabled(configured, kind), false);
    assert.equal(shadowEnabled({ SHADOW_FEED_QUOTAS_VERIFIED: "true", [`SHADOW_${kind.toUpperCase()}_ENABLED`]: "true" }, kind), false);
    assert.equal(shadowEnabled({ ...configured, SHADOW_FEED_QUOTAS_VERIFIED: "true" }, kind), true);
    assert.equal(shadowEnabled({ ...configured, SHADOW_FEED_QUOTAS_VERIFIED: "TRUE" }, kind), false);
    await runShadowSchedule(kind, {}); // Would throw on missing client credentials if the gate failed.
  }
});
test("news is prospective; stale, overnight, future and missing publication times are ineligible", () => {
  const seen = at("2026-11-11T16:30Z");
  assert.equal(newsEligibility(seen - 900_000, seen), null);
  assert.equal(newsEligibility(seen - 900_001, seen), "stale-on-arrival");
  assert.equal(newsEligibility(seen + 1, seen), "invalid-publication-time");
  assert.equal(newsEligibility(0, seen), "invalid-publication-time");
  assert.equal(newsEligibility(at("2026-11-11T13:59Z"), at("2026-11-11T14:00Z")), "outside-session");
  assert.equal(canonicalUrl("https://news.test/a?utm_source=x&b=2&a=1#top"), "https://news.test/a?a=1&b=2");
  assert.equal(canonicalUrl("javascript:alert(1)"), "");
  assert.equal(storyKey("Stock: Up!", seen), storyKey("STOCK up", seen));
});
test("starting pair rejects pre-commit, stale, skewed, or untimestamped quotes", () => {
  const commit = at("2026-11-11T16:30Z");
  const stock = { symbol: "AAPL", price: 100, at: commit + 1_000 };
  const proxy = { symbol: "SPY", price: 600, at: commit + 4_000 };
  assert.equal(startPair(stock, proxy, commit, commit + 5_000), true);
  assert.equal(startPair({ ...stock, at: commit - 1 }, proxy, commit, commit + 5_000), false);
  assert.equal(startPair({ ...stock, at: 0 }, proxy, commit, commit + 5_000), false);
  assert.equal(startPair(stock, { ...proxy, at: commit + 9_000 }, commit, commit + 9_000), false);
  assert.equal(startPair(stock, proxy, commit, commit + 60_001), false);
});
test("outcomes align raw intraday starts to adjusted bases, including a split and dividend", () => {
  const start = { stock: { symbol: "AAPL", price: 100, at: at("2026-11-11T16:30Z") },
    proxy: { symbol: "SPY", price: 500, at: at("2026-11-11T16:30Z") }, sessionDay: "2026-11-12" };
  const bars = { stockStart: { day: "2026-11-11", rawClose: 100, adjustedClose: 50 },
    stockEnd: { day: "2026-11-12", rawClose: 51, adjustedClose: 51 },
    proxyStart: { day: "2026-11-11", rawClose: 500, adjustedClose: 499 },
    proxyEnd: { day: "2026-11-12", rawClose: 499, adjustedClose: 499 } };
  const result = relativeOutcome(0.8, 0.6, start, bars)!;
  assert.equal(result.up, true); assert.ok(Math.abs(result.relativeReturn - 0.02) < 1e-10);
  assert.ok(Math.abs(result.brier - 0.04) < 1e-10); assert.equal(result.constantBrier, 0.25);
  assert.ok(Math.abs(result.baseRateBrier! - 0.16) < 1e-10);
  assert.equal(relativeOutcome(0.8, null, start, { ...bars, stockEnd: { ...bars.stockEnd, day: "2026-11-13" } }), null);
  assert.equal(relativeOutcome(NaN, null, start, bars), null);
  assert.equal(relativeOutcome(0.8, null, start, { ...bars, stockStart: { ...bars.stockStart, adjustedClose: 0 } }), null);
});
test("coverage reports disabled/deployment gaps instead of manufacturing no-action observations", () => {
  const report = shadowReport("2026-11-27", [], [], at("2026-11-28T00:00Z"));
  assert.equal(report.coverage.news.expected, 10); // 14:30/45 and 16:00 through 17:45; excludes 15 UTC.
  assert.equal(report.coverage.news.missing, 10);
  assert.equal(report.brier, null); assert.equal(report.uniqueStoryClusters, 0);
});
