import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadExitScope } from "../tools/manage_positions.ts";
import { presentPosition } from "../tools/review_performance.ts";
import { CORE_TICKER } from "./core.ts";
import { checkExits, DEFAULT_EXITS } from "./exits.ts";
import { buildManagedPositions, orphanedOpenBuys, type OpenBuyTrade } from "./positions.ts";
import type { T212Position } from "./t212.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 15, 35);

function position(ticker: string): T212Position {
  // Down 15% from entry: past the default 10% stop-loss.
  return {
    ticker,
    quantity: 5,
    averagePrice: 100,
    currentPrice: 85,
    ppl: -75,
    maxBuy: 0,
    maxSell: 5,
    pieQuantity: 0,
  };
}

function openBuy(ticker: string): OpenBuyTrade {
  // Held 60 days: three times the default 20-day max-hold.
  return { _id: `trade-${ticker}`, ticker, createdAt: NOW - 60 * DAY, thesis: "t" };
}

test("the index core down 15% and held 60 days produces no exit and no orphan close", async () => {
  const scope = await loadExitScope(
    { getPortfolio: async () => [position(CORE_TICKER), position("AAPL_US_EQ")] },
    { openBuys: async () => [openBuy(CORE_TICKER), openBuy("AAPL_US_EQ")] },
    "live",
  );
  const signals = checkExits(
    buildManagedPositions(scope.positions, scope.openBuys, 0.755),
    DEFAULT_EXITS,
    NOW,
  );
  // A stock in exactly the same state DOES exit, so the scenario is live, not vacuous.
  assert.deepEqual(
    signals.map((s) => s.ticker),
    ["AAPL_US_EQ"],
  );
  assert.deepEqual(orphanedOpenBuys(scope.openBuys, scope.positions), []);
});

test("manage_positions filters the core out before checkExits and orphan reconciliation (structural)", () => {
  // The seam above proves the filter works; only the tool's source can prove the tool uses it.
  // A unit test on a helper alone has let this exact gap ship before.
  const src = readFileSync(new URL("../tools/manage_positions.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /\(await client\.getPortfolio\(\)\)\.filter\(\(p\) => !isCore\(p\.ticker\)\)/,
    "the portfolio must be filtered of the core as it is read",
  );
  assert.match(
    src,
    /\(\(\(await memory\.openBuys\(env\)\) \?\? \[\]\) as OpenBuyTrade\[\]\)\.filter\(\s*\(b\) => !isCore\(b\.ticker\),?\s*\)/,
    "the open BUYs must be filtered of the core as they are read",
  );
  assert.equal(
    src.split("getPortfolio(").length - 1,
    1,
    "the portfolio must be read in one place only, the filtered one",
  );
  const scope = src.indexOf("await loadExitScope(client, memory, tradingEnv())");
  const exits = src.indexOf("checkExits(managed");
  const orphans = src.indexOf("orphanedOpenBuys(openBuys, positions)");
  assert.ok(scope > 0, "the tool must load its positions through loadExitScope");
  assert.ok(scope < exits && scope < orphans, "the filtered scope must feed exits and orphans");
});

test("review_performance shows the core with no exit levels, marked as the index core", () => {
  const [core, stock] = buildManagedPositions(
    [position(CORE_TICKER), position("AAPL_US_EQ")],
    [openBuy("AAPL_US_EQ")],
    0.755,
  );
  const shownCore = presentPosition(core, NOW);
  const shownStock = presentPosition(stock, NOW);
  for (const level of ["stopLossPct", "takeProfitPct", "trailingStopPct", "maxHoldDays"]) {
    assert.equal(level in shownCore, false, `the core must not show ${level}`);
    assert.equal(level in shownStock, true, `a stock still shows ${level}`);
  }
  assert.equal((shownCore as { indexCore?: boolean }).indexCore, true);
  assert.match((shownCore as { exits?: string }).exits ?? "", /exempt from exits/);
  assert.equal((shownStock as { indexCore?: boolean }).indexCore, undefined);
  // And the tool shows every position through it.
  const src = readFileSync(new URL("../tools/review_performance.ts", import.meta.url), "utf8");
  assert.match(src, /const managed = rawManaged\.map\(\(m\) => presentPosition\(m, now\)\);/);
});
