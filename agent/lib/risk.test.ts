import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  checkHalt,
  evaluateBuy,
  validateOrders,
  type RiskLimits,
  type RunningState,
  type PortfolioSnapshot,
  type ProposedOrder,
} from "./risk.ts";
import { CORE_TICKER } from "./core.ts";

// Fixed limits table for exercising the engine MECHANICS independent of whatever policy
// DEFAULT_LIMITS happens to ship (the shipped defaults are asserted separately below).
const LIMITS: RiskLimits = {
  maxPerNamePct: 0.18,
  maxDeployedPct: 0.8,
  maxNewPositionsPerDay: 3,
  minTradePct: 0.02,
  maxTradePct: 0.08,
  dailyLossHaltPct: 0.04,
  maxConcurrentPositions: 10,
  minPrice: 5,
  maxDrawdownPct: 0.1,
  maxConsecutiveLossDays: 2,
};

function basePortfolio(
  over: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  return {
    equity: 10000,
    cash: 5000,
    peakEquity: 10000,
    dayPnl: 0,
    positions: [],
    newPositionsToday: 0,
    consecutiveLossDays: 0,
    ...over,
  };
}

function freshRunning(p: PortfolioSnapshot): RunningState {
  const valueByTicker = new Map<string, number>();
  for (const pos of p.positions) valueByTicker.set(pos.ticker, pos.value);
  return {
    cash: p.cash,
    valueByTicker,
    distinctPositions: p.positions.length,
    newPositionsToday: p.newPositionsToday,
  };
}

function buy(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return { ticker: "NVDA", side: "BUY", notional: 500, price: 100, ...over };
}

// --- Task 1: default limits ---

test("DEFAULT_LIMITS encodes the concentrate-and-deploy policy", () => {
  // Literal production values on purpose: this is the sizing a live account trades on, and it
  // should not be possible to change it without a test saying so out loud.
  assert.equal(DEFAULT_LIMITS.maxDeployedPct, 0.9); // 10% free for FX and fees
  assert.equal(DEFAULT_LIMITS.maxTradePct, 0.3);
  assert.equal(DEFAULT_LIMITS.maxNewPositionsPerDay, 4);
  assert.equal(DEFAULT_LIMITS.maxPerNamePct, 0.3); // no all-in on one name
  // A 10 GBP "probe" on a 250 GBP account is rejected, not placed: below this floor a correct
  // pick cannot move the account, so the size defeats the signal.
  assert.equal(DEFAULT_LIMITS.minTradePct, 0.15);
  assert.equal(DEFAULT_LIMITS.maxConcurrentPositions, 4);
  assert.equal(DEFAULT_LIMITS.minPrice, 5);
  // Breakers loosened to fit 4 concentrated names, still ruin-prevention.
  assert.equal(DEFAULT_LIMITS.dailyLossHaltPct, 0.06);
  assert.equal(DEFAULT_LIMITS.maxDrawdownPct, 0.15);
  assert.equal(DEFAULT_LIMITS.maxConsecutiveLossDays, 2);
});

// --- Task 2: halt & circuit breaker ---

test("checkHalt: no halt on a normal day", () => {
  const d = checkHalt(basePortfolio({ dayPnl: -100 }), LIMITS);
  assert.equal(d.halted, false);
  assert.equal(d.manualResumeRequired, false);
});

test("checkHalt: daily loss cap halts, auto-resume", () => {
  const d = checkHalt(basePortfolio({ dayPnl: -450 }), LIMITS);
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, false);
  assert.match(d.reason ?? "", /daily loss/i);
});

test("checkHalt: drawdown from peak trips circuit breaker (manual)", () => {
  const d = checkHalt(
    basePortfolio({ equity: 8900, peakEquity: 10000 }),
    LIMITS,
  );
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, true);
  assert.match(d.reason ?? "", /drawdown/i);
});

test("checkHalt: consecutive loss days trips circuit breaker (manual)", () => {
  const d = checkHalt(basePortfolio({ consecutiveLossDays: 2 }), LIMITS);
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, true);
  assert.match(d.reason ?? "", /consecutive/i);
});

// --- Task 3: single BUY evaluation ---

test("evaluateBuy: accepts a clean order", () => {
  const p = basePortfolio();
  assert.equal(evaluateBuy(buy(), p, LIMITS, freshRunning(p)), null);
});

test("evaluateBuy: rejects sub-$5 price", () => {
  const p = basePortfolio();
  const r = evaluateBuy(buy({ price: 3 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /price/i);
});

test("evaluateBuy: rejects oversize trade (> 8% equity)", () => {
  const p = basePortfolio();
  const r = evaluateBuy(buy({ notional: 900 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /trade size/i);
});

test("evaluateBuy: rejects undersize trade (< 2% equity)", () => {
  const p = basePortfolio();
  const r = evaluateBuy(buy({ notional: 100 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /trade size/i);
});

test("evaluateBuy: rejects when notional exceeds cash", () => {
  const p = basePortfolio({ cash: 300 });
  const r = evaluateBuy(buy({ notional: 500 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /cash/i);
});

test("evaluateBuy: rejects per-name concentration breach", () => {
  const p = basePortfolio({ positions: [{ ticker: "NVDA", value: 1500 }] });
  const r = evaluateBuy(buy({ notional: 500 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /per-name|concentration/i);
});

test("evaluateBuy: rejects when cash floor (20%) would be breached", () => {
  const p = basePortfolio({
    cash: 2200,
    positions: [{ ticker: "AAPL", value: 7800 }],
  });
  const r = evaluateBuy(buy({ notional: 500 }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /deployed|cash floor/i);
});

test("evaluateBuy: rejects 4th new position of the day", () => {
  const p = basePortfolio({ newPositionsToday: 3 });
  const r = evaluateBuy(buy({ ticker: "TSLA" }), p, LIMITS, freshRunning(p));
  assert.match(r ?? "", /new position/i);
});

// --- Task 4: batch validation ---

test("validateOrders: a halt rejects BUYs", () => {
  const p = basePortfolio({ dayPnl: -500 });
  const res = validateOrders([buy()], p, LIMITS);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /halted/i);
});

test("validateOrders: a halt still ALLOWS de-risking SELLs", () => {
  const p = basePortfolio({ dayPnl: -500, positions: [{ ticker: "NVDA", value: 1000 }] });
  const res = validateOrders(
    [
      { ticker: "NVDA", side: "SELL", notional: 600, price: 100 },
      buy({ ticker: "AAA" }),
    ],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].side, "SELL");
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /halted/i); // the buy
});

test("validateOrders: cumulative cash floor rejects the later buy", () => {
  const p = basePortfolio({ cash: 2600, positions: [{ ticker: "X", value: 7400 }] });
  const res = validateOrders(
    [buy({ ticker: "AAA", notional: 400 }), buy({ ticker: "BBB", notional: 400 })],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].ticker, "AAA");
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /cash floor|deployed/i);
});

test("validateOrders: SELL of held position is accepted", () => {
  const p = basePortfolio({ positions: [{ ticker: "NVDA", value: 1000 }] });
  const res = validateOrders(
    [{ ticker: "NVDA", side: "SELL", notional: 600, price: 100 }],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.rejected.length, 0);
  // in-range SELL notional passes through unclamped
  assert.equal(res.accepted[0].notional, 600);
});

test("validateOrders: SELL with no position is rejected", () => {
  const p = basePortfolio();
  const res = validateOrders(
    [{ ticker: "NVDA", side: "SELL", notional: 600, price: 100 }],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 0);
  assert.match(res.rejected[0].reason, /no position/i);
});

test("validateOrders: SELL above held value is clamped to held instead of rejected", () => {
  const p = basePortfolio({ positions: [{ ticker: "NVDA", value: 1000 }] });
  const res = validateOrders(
    // a downtick between the two portfolio reads can make notional (read #1) exceed
    // held (read #2); this must close the position, not reject the exit.
    [{ ticker: "NVDA", side: "SELL", notional: 1200, price: 100 }],
    p,
    LIMITS,
  );
  assert.equal(res.rejected.length, 0);
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].notional, 1000);
  assert.equal(res.accepted[0].ticker, "NVDA");
  assert.equal(res.accepted[0].side, "SELL");
});

// --- Task 5: SELL proceeds are unsettled, must not fund a same-batch BUY ---

test("validateOrders: a same-batch BUY funded by unsettled SELL proceeds is rejected", () => {
  const p = basePortfolio({
    cash: 300,
    positions: [{ ticker: "AAA", value: 1000 }],
  });
  const res = validateOrders(
    [
      { ticker: "AAA", side: "SELL", notional: 600, price: 100 },
      buy({ ticker: "BBB", notional: 500 }), // > p.cash (300), < p.cash + sell (900)
    ],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].side, "SELL");
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].order.ticker, "BBB");
  assert.match(res.rejected[0].reason, /cash/i);
});

test("validateOrders: a BUY funded entirely by pre-existing cash still passes", () => {
  const p = basePortfolio({ cash: 5000 });
  const res = validateOrders([buy({ notional: 500 })], p, LIMITS);
  assert.equal(res.accepted.length, 1);
  assert.equal(res.rejected.length, 0);
});

test("validateOrders: SELL is still accepted and updates concentration/valueByTicker without crediting cash", () => {
  const p = basePortfolio({
    cash: 2500,
    positions: [{ ticker: "AAA", value: 1700 }],
  });
  const res = validateOrders(
    [
      { ticker: "AAA", side: "SELL", notional: 1600, price: 100 },
      // funded entirely from pre-existing cash (2500), not the unsettled sell proceeds;
      // only passes the per-name check because valueByTicker[AAA] dropped to 100 post-SELL
      buy({ ticker: "AAA", notional: 200 }),
    ],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 2);
  assert.equal(res.accepted[0].side, "SELL");
  assert.equal(res.accepted[0].notional, 1600);
  assert.equal(res.accepted[1].side, "BUY");
  assert.equal(res.rejected.length, 0);
});

test("validateOrders: a clamped full-close SELL removes the position from running state", () => {
  const p = basePortfolio({ positions: [{ ticker: "NVDA", value: 1000 }] });
  const res = validateOrders(
    [
      { ticker: "NVDA", side: "SELL", notional: 1200, price: 100 },
      { ticker: "NVDA", side: "SELL", notional: 100, price: 100 },
    ],
    p,
    LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].notional, 1000);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /no position/i);
});

// --- Task 6: the index core is not a stock ---

test("validateOrders: with 90% in the core and 3% cash, a valid 15% buy fails only for cash", () => {
  const p = basePortfolio({
    equity: 1000,
    peakEquity: 1000,
    cash: 30,
    positions: [
      { ticker: CORE_TICKER, value: 900 },
      { ticker: "AAA", value: 30 },
      { ticker: "BBB", value: 20 },
      { ticker: "CCC", value: 20 },
    ],
  });
  const order = buy({ ticker: "DDD", notional: 150 });
  const res = validateOrders([order], p, DEFAULT_LIMITS);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /insufficient cash/);
  // Given the cash, neither the deployed cap nor the position count would stop it: the core
  // occupies no stock slot and is not part of the stock sleeve.
  const withCash = validateOrders([order], { ...p, cash: 1_000_000 }, DEFAULT_LIMITS);
  assert.equal(withCash.accepted.length, 1);
});

test("validateOrders: the deployed cap measures the stock sleeve, not cash", () => {
  // 700 core + 100 stock + 200 cash. A 150 buy leaves 50 cash, which the old cash floor (10% of
  // equity) rejected; the stock sleeve after the buy is 25%, well inside the 90% cap.
  const p = basePortfolio({
    equity: 1000,
    peakEquity: 1000,
    cash: 200,
    positions: [
      { ticker: CORE_TICKER, value: 700 },
      { ticker: "AAA", value: 100 },
    ],
  });
  const res = validateOrders([buy({ ticker: "BBB", notional: 150 })], p, DEFAULT_LIMITS);
  assert.equal(res.rejected.length, 0);
  assert.equal(res.accepted.length, 1);
});

test("validateOrders: three stocks plus the core allow a fourth stock and not a fifth", () => {
  const p = basePortfolio({
    equity: 10000,
    cash: 4500,
    positions: [
      { ticker: CORE_TICKER, value: 4000 },
      { ticker: "AAA", value: 500 },
      { ticker: "BBB", value: 500 },
      { ticker: "CCC", value: 500 },
    ],
  });
  const res = validateOrders(
    [buy({ ticker: "DDD", notional: 1500 }), buy({ ticker: "EEE", notional: 1500 })],
    p,
    DEFAULT_LIMITS,
  );
  assert.deepEqual(
    res.accepted.map((o) => o.ticker),
    ["DDD"],
  );
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].order.ticker, "EEE");
  assert.match(res.rejected[0].reason, /max 4 concurrent positions/);
});

// --- Task 7: the cash a funding sale would need ---

test("validateOrders: cashShortfall is the cash the buys rejected only for cash would need", () => {
  const p = basePortfolio({
    equity: 1000,
    peakEquity: 1000,
    cash: 200,
    positions: [
      { ticker: CORE_TICKER, value: 700 },
      { ticker: "AAA", value: 100 },
    ],
  });
  const res = validateOrders(
    [buy({ ticker: "BBB", notional: 250 }), buy({ ticker: "CCC", notional: 150 })],
    p,
    DEFAULT_LIMITS,
  );
  // BBB is short (250 > 200); CCC then spends 150, leaving 50. BBB needs 200 more.
  assert.deepEqual(
    res.accepted.map((o) => o.ticker),
    ["CCC"],
  );
  assert.match(res.rejected[0].reason, /insufficient cash/);
  assert.equal(res.cashShortfall, 200);
});

test("validateOrders: a buy another limit would also stop raises no cash", () => {
  // Short of cash AND over the 30% per-name cap once bought: cash is not its only problem.
  const p = basePortfolio({
    equity: 1000,
    peakEquity: 1000,
    cash: 30,
    positions: [
      { ticker: CORE_TICKER, value: 720 },
      { ticker: "AAA", value: 250 },
    ],
  });
  const res = validateOrders([buy({ ticker: "AAA", notional: 150 })], p, DEFAULT_LIMITS);
  assert.match(res.rejected[0].reason, /insufficient cash/);
  assert.equal(res.cashShortfall, 0);
});

test("validateOrders: a halt raises no cash, so it can never sell the core", () => {
  const p = basePortfolio({
    equity: 1000,
    peakEquity: 1000,
    cash: 30,
    dayPnl: -100,
    positions: [{ ticker: CORE_TICKER, value: 970 }],
  });
  const res = validateOrders([buy({ ticker: "BBB", notional: 150 })], p, DEFAULT_LIMITS);
  assert.match(res.rejected[0].reason, /halted/);
  assert.equal(res.cashShortfall, 0);
});
