import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notionalToShares,
  buildRiskSnapshot,
  accountValueGbp,
  deployedValueGbp,
  roundQuantity,
  parseQuantityPrecision,
  t212TickerToFinnhubSymbol,
} from "./execution.ts";
import type { CashBalance, T212Position } from "./t212.ts";

function cash(over: Partial<CashBalance> = {}): CashBalance {
  return {
    total: 0,
    free: 0,
    blocked: 0,
    invested: 0,
    pieCash: 0,
    result: 0,
    ppl: 0,
    ...over,
  };
}

function pos(over: Partial<T212Position> = {}): T212Position {
  return {
    ticker: "AAPL_US_EQ",
    quantity: 1,
    averagePrice: 50,
    currentPrice: 50,
    ppl: 0,
    maxBuy: 0,
    maxSell: 0,
    pieQuantity: 0,
    ...over,
  };
}

// --- notionalToShares ---

test("notionalToShares converts account-ccy notional to shares via price*fx", () => {
  // £100 into a $50 stock at fx 0.8 (USD->GBP): price in GBP = 40 => 2.5 shares
  assert.equal(notionalToShares(100, 50, 0.8), 2.5);
});

test("notionalToShares keeps the sign (negative notional = SELL)", () => {
  assert.equal(notionalToShares(-100, 50, 0.8), -2.5);
});

test("notionalToShares rounds to 6 dp", () => {
  // 1 / (3 * 1) = 0.3333... -> 0.333333
  assert.equal(notionalToShares(1, 3, 1), 0.333333);
});

test("notionalToShares rejects non-positive price or fx", () => {
  assert.throws(() => notionalToShares(100, 0, 0.8), /positive/);
  assert.throws(() => notionalToShares(100, 50, 0), /positive/);
});

// --- accountValueGbp: the real bug's data point ---

test("accountValueGbp reproduces the true GBP account value on the live data point", () => {
  // Real cycle: cash.free = 142.37 GBP, holdings = 140.79 USD, true USD->GBP = 0.7514.
  // True account value = 248.16 GBP. The bug reported ~282 (LLM hand-summed raw USD onto
  // GBP cash) and the static-fx path recorded 253.60 (0.79 rate). Prove we get 248.16.
  const value = accountValueGbp(
    cash({ free: 142.37 }),
    [pos({ quantity: 1, currentPrice: 140.79 })],
    0.7514,
  );
  assert.ok(
    Math.abs(value - 248.16) < 0.01,
    `expected ~248.16, got ${value}`,
  );
  assert.ok(Math.abs(value - 253.6) > 1, "must NOT be the static-0.79 value 253.60");
  assert.ok(Math.abs(value - 282) > 1, "must NOT be the hand-summed report value ~282");
});

test("deployedValueGbp converts USD holdings to GBP at the given fx", () => {
  assert.ok(
    Math.abs(deployedValueGbp([pos({ quantity: 1, currentPrice: 140.79 })], 0.7514) - 105.79) <
      0.01,
  );
  assert.equal(deployedValueGbp([], 0.7514), 0);
});

// --- buildRiskSnapshot ---

test("buildRiskSnapshot maps cash + positions into a risk snapshot (account ccy)", () => {
  const snap = buildRiskSnapshot({
    cash: cash({ free: 20 }),
    positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
    fxRate: 0.8, // position value = 1 * 50 * 0.8 = 40
    peakEquity: 0,
    dayPnl: -1,
    newPositionsToday: 1,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.cash, 20);
  assert.equal(snap.positions[0].value, 40);
  assert.equal(snap.equity, 60); // 20 free + 40 deployed
  assert.equal(snap.peakEquity, 60); // max(0, 60)
  assert.equal(snap.dayPnl, -1);
  assert.equal(snap.newPositionsToday, 1);
});

test("buildRiskSnapshot throws on non-finite cash.free (fail-closed)", () => {
  assert.throws(
    () =>
      buildRiskSnapshot({
        cash: cash({ free: NaN }),
        positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
        fxRate: 0.8,
        peakEquity: 0,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
    /non-finite/,
  );
});

test("buildRiskSnapshot throws on non-finite position currentPrice (fail-closed)", () => {
  assert.throws(
    () =>
      buildRiskSnapshot({
        cash: cash({ free: 20 }),
        positions: [pos({ ticker: "X", quantity: 1, currentPrice: NaN })],
        fxRate: 0.8,
        peakEquity: 0,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
    /non-finite/,
  );
});

test("buildRiskSnapshot returns the same values as today for a normal finite snapshot", () => {
  const snap = buildRiskSnapshot({
    cash: cash({ free: 20 }),
    positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
    fxRate: 0.8,
    peakEquity: 0,
    dayPnl: -1,
    newPositionsToday: 1,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.cash, 20);
  assert.equal(snap.positions[0].value, 40);
  assert.equal(snap.equity, 60);
  assert.equal(snap.peakEquity, 60);
  assert.equal(snap.dayPnl, -1);
  assert.equal(snap.newPositionsToday, 1);
});

test("roundQuantity: truncates DOWN to N decimals, clean of float noise", () => {
  assert.equal(roundQuantity(0.2234567, 4), 0.2234);
  assert.equal(roundQuantity(0.2234, 4), 0.2234); // float-noise safe (0.2234*1e4 ≈ 2233.9999)
  assert.equal(roundQuantity(12.09032128, 4), 12.0903);
  assert.equal(roundQuantity(3.9, 0), 3); // whole shares only
  assert.equal(roundQuantity(0.4, 0), 0); // < 1 share, whole-only → 0
  assert.equal(roundQuantity(0, 6), 0);
});

test("parseQuantityPrecision: extracts allowed dp, ignores HTTP status", () => {
  assert.equal(parseQuantityPrecision("invalid quantity precision 4"), 4);
  assert.equal(
    parseQuantityPrecision('Trading 212 API error 400: {"code":"invalid quantity precision 4"}'),
    4,
  );
  assert.equal(parseQuantityPrecision("Quantity must be limited to 0 decimal spaces"), 0);
  assert.equal(parseQuantityPrecision("insufficient funds"), null);
});

test("t212TickerToFinnhubSymbol: strips the _US_EQ suffix", () => {
  assert.equal(t212TickerToFinnhubSymbol("AAPL_US_EQ"), "AAPL");
});

test("t212TickerToFinnhubSymbol: returns null for a non-matching ticker", () => {
  assert.equal(t212TickerToFinnhubSymbol("AAPL"), null);
});

test("buildRiskSnapshot keeps a higher stored peakEquity", () => {
  const snap = buildRiskSnapshot({
    cash: cash({ free: 10 }),
    positions: [],
    fxRate: 1,
    peakEquity: 100,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.equity, 10);
  assert.equal(snap.peakEquity, 100); // stored peak wins over current
});
