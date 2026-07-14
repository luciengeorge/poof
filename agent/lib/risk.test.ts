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

test("DEFAULT_LIMITS encodes the full-deploy-keep-diversification policy", () => {
  // Sizing opened up so the whole account can be deployed...
  assert.equal(DEFAULT_LIMITS.maxDeployedPct, 1.0); // no idle-cash floor
  assert.equal(DEFAULT_LIMITS.maxTradePct, 0.3);
  assert.equal(DEFAULT_LIMITS.maxNewPositionsPerDay, 6);
  assert.equal(DEFAULT_LIMITS.maxPerNamePct, 0.3); // ...but no all-in on one name
  assert.equal(DEFAULT_LIMITS.minTradePct, 0.02);
  assert.equal(DEFAULT_LIMITS.maxConcurrentPositions, 10);
  assert.equal(DEFAULT_LIMITS.minPrice, 5);
  // Ruin-prevention breakers stay tight.
  assert.equal(DEFAULT_LIMITS.dailyLossHaltPct, 0.04);
  assert.equal(DEFAULT_LIMITS.maxDrawdownPct, 0.1);
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
