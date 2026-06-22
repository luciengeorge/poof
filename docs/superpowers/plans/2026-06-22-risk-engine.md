# Risk Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agent/lib/risk.ts` — the deterministic, authoritative risk-limit engine that every proposed trade must pass before execution.

**Architecture:** A pure-functions module (no I/O, no LLM, no external API). It takes a portfolio snapshot + proposed orders + a limits config and returns accepted/rejected orders with reasons, plus halt/circuit-breaker decisions. This is the safety core: limits live here in code, never in a prompt. The later `validate_orders` eve tool and orchestrator will call these functions; the LLM red-team can only veto/shrink, never bypass them.

**Tech Stack:** TypeScript (strict, NodeNext), Node 24 built-in test runner (`node:test`), zero new dependencies.

## Global Constraints

- Node engine: `24.x` (per `package.json`). Native TS execution + `node:test`.
- Package manager: `pnpm@10.26.0` (pinned via `packageManager`). Use `corepack pnpm@10.26.0` or `pnpm` if on 10.x.
- No new runtime/dev dependencies. Tests run via `node --test --experimental-strip-types` (the flag is a no-op on Node 24, kept for Node 22 compatibility).
- All money values are USD numbers. Trading 212 Invest supports fractional shares, so orders are sized by **notional USD**, not share count.
- Risk limits are expressed as **fractions of account equity** (e.g. `0.18` = 18%), capital-agnostic across demo and live.
- Strict TypeScript: no `any`; all exported functions fully typed.
- This module is **pure**: no `import` of eve, no network, no `process.env`, no `Date.now()` reads inside pure functions (pass timestamps/day-state in via the portfolio snapshot).

---

### Task 1: Test harness + types + default limits

**Files:**
- Modify: `package.json` (add `test` script)
- Create: `agent/lib/risk.ts`
- Test: `agent/lib/risk.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the type surface every later task uses —
  - `type Side = "BUY" | "SELL"`
  - `interface RiskLimits` with numeric fields: `maxPerNamePct`, `maxDeployedPct`, `maxNewPositionsPerDay`, `minTradePct`, `maxTradePct`, `dailyLossHaltPct`, `maxConcurrentPositions`, `minPrice`, `maxDrawdownPct`, `maxConsecutiveLossDays`
  - `interface Position { ticker: string; value: number }` (current market value, USD)
  - `interface PortfolioSnapshot { equity: number; cash: number; peakEquity: number; dayPnl: number; positions: Position[]; newPositionsToday: number; consecutiveLossDays: number }`
  - `interface ProposedOrder { ticker: string; side: Side; notional: number; price: number }`
  - `interface Rejection { order: ProposedOrder; reason: string }`
  - `interface ValidationResult { accepted: ProposedOrder[]; rejected: Rejection[] }`
  - `interface HaltDecision { halted: boolean; reason: string | null; manualResumeRequired: boolean }`
  - `const DEFAULT_LIMITS: RiskLimits`

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, add to the `"scripts"` object (alongside the existing `typecheck`):

```json
    "test": "node --test --experimental-strip-types \"agent/**/*.test.ts\""
```

- [ ] **Step 2: Write the failing test**

Create `agent/lib/risk.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "./risk.ts";

test("DEFAULT_LIMITS encodes the balanced risk table", () => {
  assert.equal(DEFAULT_LIMITS.maxPerNamePct, 0.18);
  assert.equal(DEFAULT_LIMITS.maxDeployedPct, 0.8);
  assert.equal(DEFAULT_LIMITS.maxNewPositionsPerDay, 3);
  assert.equal(DEFAULT_LIMITS.minTradePct, 0.02);
  assert.equal(DEFAULT_LIMITS.maxTradePct, 0.08);
  assert.equal(DEFAULT_LIMITS.dailyLossHaltPct, 0.04);
  assert.equal(DEFAULT_LIMITS.maxConcurrentPositions, 10);
  assert.equal(DEFAULT_LIMITS.minPrice, 5);
  assert.equal(DEFAULT_LIMITS.maxDrawdownPct, 0.1);
  assert.equal(DEFAULT_LIMITS.maxConsecutiveLossDays, 2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: FAIL — `Cannot find module './risk.ts'` (file does not exist yet).

- [ ] **Step 4: Write minimal implementation**

Create `agent/lib/risk.ts`:

```ts
export type Side = "BUY" | "SELL";

export interface RiskLimits {
  maxPerNamePct: number;
  maxDeployedPct: number;
  maxNewPositionsPerDay: number;
  minTradePct: number;
  maxTradePct: number;
  dailyLossHaltPct: number;
  maxConcurrentPositions: number;
  minPrice: number;
  maxDrawdownPct: number;
  maxConsecutiveLossDays: number;
}

export interface Position {
  ticker: string;
  value: number;
}

export interface PortfolioSnapshot {
  equity: number;
  cash: number;
  peakEquity: number;
  dayPnl: number;
  positions: Position[];
  newPositionsToday: number;
  consecutiveLossDays: number;
}

export interface ProposedOrder {
  ticker: string;
  side: Side;
  notional: number;
  price: number;
}

export interface Rejection {
  order: ProposedOrder;
  reason: string;
}

export interface ValidationResult {
  accepted: ProposedOrder[];
  rejected: Rejection[];
}

export interface HaltDecision {
  halted: boolean;
  reason: string | null;
  manualResumeRequired: boolean;
}

export const DEFAULT_LIMITS: RiskLimits = {
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add package.json agent/lib/risk.ts agent/lib/risk.test.ts
git commit -m "feat(risk): add risk-engine types and default limits"
```

---

### Task 2: Halt & circuit-breaker decision

**Files:**
- Modify: `agent/lib/risk.ts`
- Test: `agent/lib/risk.test.ts`

**Interfaces:**
- Consumes: `PortfolioSnapshot`, `RiskLimits`, `HaltDecision` (Task 1).
- Produces: `function checkHalt(p: PortfolioSnapshot, limits: RiskLimits): HaltDecision`
  - Circuit breaker (manual resume required) takes priority: drawdown from peak `> maxDrawdownPct`, OR `consecutiveLossDays >= maxConsecutiveLossDays`.
  - Daily loss (auto-resume next day): `dayPnl <= -(dailyLossHaltPct * equity)`.
  - Otherwise not halted.

- [ ] **Step 1: Write the failing tests**

Append to `agent/lib/risk.test.ts`:

```ts
import { checkHalt } from "./risk.ts";

function basePortfolio(over: Partial<import("./risk.ts").PortfolioSnapshot> = {}) {
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

test("checkHalt: no halt on a normal day", () => {
  const d = checkHalt(basePortfolio({ dayPnl: -100 }), DEFAULT_LIMITS);
  assert.equal(d.halted, false);
  assert.equal(d.manualResumeRequired, false);
});

test("checkHalt: daily loss cap halts, auto-resume", () => {
  // -4% of 10000 = -400; -450 trips it
  const d = checkHalt(basePortfolio({ dayPnl: -450 }), DEFAULT_LIMITS);
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, false);
  assert.match(d.reason ?? "", /daily loss/i);
});

test("checkHalt: drawdown from peak trips circuit breaker (manual)", () => {
  // peak 10000, equity 8900 => -11% > 10%
  const d = checkHalt(
    basePortfolio({ equity: 8900, peakEquity: 10000 }),
    DEFAULT_LIMITS,
  );
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, true);
  assert.match(d.reason ?? "", /drawdown/i);
});

test("checkHalt: consecutive loss days trips circuit breaker (manual)", () => {
  const d = checkHalt(
    basePortfolio({ consecutiveLossDays: 2 }),
    DEFAULT_LIMITS,
  );
  assert.equal(d.halted, true);
  assert.equal(d.manualResumeRequired, true);
  assert.match(d.reason ?? "", /consecutive/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: FAIL — `checkHalt is not exported` / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `agent/lib/risk.ts`:

```ts
export function checkHalt(
  p: PortfolioSnapshot,
  limits: RiskLimits,
): HaltDecision {
  const drawdown = p.peakEquity > 0 ? (p.peakEquity - p.equity) / p.peakEquity : 0;
  if (drawdown > limits.maxDrawdownPct) {
    return {
      halted: true,
      manualResumeRequired: true,
      reason: `drawdown ${(drawdown * 100).toFixed(1)}% exceeds ${(limits.maxDrawdownPct * 100).toFixed(0)}% limit`,
    };
  }
  if (p.consecutiveLossDays >= limits.maxConsecutiveLossDays) {
    return {
      halted: true,
      manualResumeRequired: true,
      reason: `${p.consecutiveLossDays} consecutive loss days`,
    };
  }
  if (p.dayPnl <= -(limits.dailyLossHaltPct * p.equity)) {
    return {
      halted: true,
      manualResumeRequired: false,
      reason: `daily loss cap hit (${p.dayPnl.toFixed(0)} <= -${(limits.dailyLossHaltPct * p.equity).toFixed(0)})`,
    };
  }
  return { halted: false, manualResumeRequired: false, reason: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: PASS (all checkHalt tests + Task 1 test).

- [ ] **Step 5: Commit**

```bash
git add agent/lib/risk.ts agent/lib/risk.test.ts
git commit -m "feat(risk): add halt and circuit-breaker decision"
```

---

### Task 3: Single-order evaluation (BUY checks)

**Files:**
- Modify: `agent/lib/risk.ts`
- Test: `agent/lib/risk.test.ts`

**Interfaces:**
- Consumes: all Task 1 types.
- Produces: `function evaluateBuy(order: ProposedOrder, p: PortfolioSnapshot, limits: RiskLimits, running: RunningState): string | null`
  - Returns `null` if the order passes, else a human-readable rejection reason (first failing check).
  - `interface RunningState { cash: number; valueByTicker: Map<string, number>; distinctPositions: number; newPositionsToday: number }` — mutable cumulative state so a batch of BUYs is evaluated against the effect of earlier-accepted BUYs in the same run.
  - Checks, in order: (1) `price >= minPrice`; (2) trade size within `[minTradePct, maxTradePct] * equity`; (3) notional `<= running.cash`; (4) resulting per-name value `<= maxPerNamePct * equity`; (5) resulting deployed `<= maxDeployedPct * equity` (cash floor preserved); (6) if new ticker: `newPositionsToday < maxNewPositionsPerDay` AND `distinctPositions < maxConcurrentPositions`.
  - This function does NOT mutate `running` — the caller (Task 4) applies the mutation on accept.

- [ ] **Step 1: Write the failing tests**

Append to `agent/lib/risk.test.ts`:

```ts
import { evaluateBuy, type RunningState } from "./risk.ts";

function freshRunning(p: import("./risk.ts").PortfolioSnapshot): RunningState {
  const valueByTicker = new Map<string, number>();
  for (const pos of p.positions) valueByTicker.set(pos.ticker, pos.value);
  return {
    cash: p.cash,
    valueByTicker,
    distinctPositions: p.positions.length,
    newPositionsToday: p.newPositionsToday,
  };
}

function buy(over: Partial<import("./risk.ts").ProposedOrder> = {}) {
  return { ticker: "NVDA", side: "BUY" as const, notional: 500, price: 100, ...over };
}

test("evaluateBuy: accepts a clean order", () => {
  const p = basePortfolio();
  assert.equal(evaluateBuy(buy(), p, DEFAULT_LIMITS, freshRunning(p)), null);
});

test("evaluateBuy: rejects sub-$5 price", () => {
  const p = basePortfolio();
  const r = evaluateBuy(buy({ price: 3 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /price/i);
});

test("evaluateBuy: rejects oversize trade (> 8% equity)", () => {
  const p = basePortfolio(); // equity 10000 => max trade 800
  const r = evaluateBuy(buy({ notional: 900 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /trade size/i);
});

test("evaluateBuy: rejects undersize trade (< 2% equity)", () => {
  const p = basePortfolio(); // min trade 200
  const r = evaluateBuy(buy({ notional: 100 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /trade size/i);
});

test("evaluateBuy: rejects when notional exceeds cash", () => {
  const p = basePortfolio({ cash: 300 });
  const r = evaluateBuy(buy({ notional: 500 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /cash/i);
});

test("evaluateBuy: rejects per-name concentration breach", () => {
  // existing NVDA 1500 + buy 500 = 2000 = 20% > 18% of 10000
  const p = basePortfolio({ positions: [{ ticker: "NVDA", value: 1500 }] });
  const r = evaluateBuy(buy({ notional: 500 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /per-name|concentration/i);
});

test("evaluateBuy: rejects when cash floor (20%) would be breached", () => {
  // equity 10000, max deployed 80% => min cash 2000. Currently deployed 7800, cash 2200.
  // buy 500 -> cash 1700 < 2000 floor.
  const p = basePortfolio({
    cash: 2200,
    positions: [{ ticker: "AAPL", value: 7800 }],
  });
  const r = evaluateBuy(buy({ notional: 500 }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /deployed|cash floor/i);
});

test("evaluateBuy: rejects 4th new position of the day", () => {
  const p = basePortfolio({ newPositionsToday: 3 });
  const r = evaluateBuy(buy({ ticker: "TSLA" }), p, DEFAULT_LIMITS, freshRunning(p));
  assert.match(r ?? "", /new position/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: FAIL — `evaluateBuy` / `RunningState` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `agent/lib/risk.ts`:

```ts
export interface RunningState {
  cash: number;
  valueByTicker: Map<string, number>;
  distinctPositions: number;
  newPositionsToday: number;
}

export function evaluateBuy(
  order: ProposedOrder,
  p: PortfolioSnapshot,
  limits: RiskLimits,
  running: RunningState,
): string | null {
  if (order.price < limits.minPrice) {
    return `price $${order.price} below $${limits.minPrice} minimum`;
  }

  const minTrade = limits.minTradePct * p.equity;
  const maxTrade = limits.maxTradePct * p.equity;
  if (order.notional < minTrade || order.notional > maxTrade) {
    return `trade size $${order.notional} outside [$${minTrade.toFixed(0)}, $${maxTrade.toFixed(0)}]`;
  }

  if (order.notional > running.cash) {
    return `insufficient cash ($${running.cash.toFixed(0)} available)`;
  }

  const currentName = running.valueByTicker.get(order.ticker) ?? 0;
  const resultingName = currentName + order.notional;
  if (resultingName > limits.maxPerNamePct * p.equity) {
    return `per-name concentration ${((resultingName / p.equity) * 100).toFixed(1)}% exceeds ${(limits.maxPerNamePct * 100).toFixed(0)}%`;
  }

  const resultingCash = running.cash - order.notional;
  const minCash = (1 - limits.maxDeployedPct) * p.equity;
  if (resultingCash < minCash) {
    return `would breach cash floor (deployed > ${(limits.maxDeployedPct * 100).toFixed(0)}%)`;
  }

  const isNew = !running.valueByTicker.has(order.ticker);
  if (isNew) {
    if (running.newPositionsToday >= limits.maxNewPositionsPerDay) {
      return `max ${limits.maxNewPositionsPerDay} new positions/day reached`;
    }
    if (running.distinctPositions >= limits.maxConcurrentPositions) {
      return `max ${limits.maxConcurrentPositions} concurrent positions reached`;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: PASS (all evaluateBuy tests + prior tests).

- [ ] **Step 5: Commit**

```bash
git add agent/lib/risk.ts agent/lib/risk.test.ts
git commit -m "feat(risk): add single-order BUY evaluation"
```

---

### Task 4: Batch validation with cumulative accounting

**Files:**
- Modify: `agent/lib/risk.ts`
- Test: `agent/lib/risk.test.ts`

**Interfaces:**
- Consumes: `checkHalt` (Task 2), `evaluateBuy` + `RunningState` (Task 3), all Task 1 types.
- Produces: `function validateOrders(orders: ProposedOrder[], p: PortfolioSnapshot, limits: RiskLimits): ValidationResult`
  - If `checkHalt(p, limits).halted` is true → every order rejected with reason `"trading halted: <halt reason>"`.
  - SELL orders: accepted iff a position in that ticker exists and `notional <= position value`; else rejected (`"no position to sell"` / `"sell exceeds position"`). SELLs do not consume BUY headroom.
  - BUY orders: evaluated in array order via `evaluateBuy` against a `RunningState` seeded from the portfolio; on accept, mutate running state (decrement cash, add to per-name value, increment distinct/new counts for new tickers). This makes a batch that individually fits but collectively breaches the cash floor reject the later orders.

- [ ] **Step 1: Write the failing tests**

Append to `agent/lib/risk.test.ts`:

```ts
import { validateOrders } from "./risk.ts";

test("validateOrders: halts reject everything", () => {
  const p = basePortfolio({ dayPnl: -500 }); // trips daily loss
  const res = validateOrders([buy()], p, DEFAULT_LIMITS);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /halted/i);
});

test("validateOrders: cumulative cash floor rejects the later buy", () => {
  // equity 10000, cash 2600, min cash floor 2000. Two 400 buys:
  // first ok (cash->2200), second would go to 1800 < 2000 => reject.
  const p = basePortfolio({ cash: 2600, positions: [{ ticker: "X", value: 7400 }] });
  const res = validateOrders(
    [buy({ ticker: "AAA", notional: 400 }), buy({ ticker: "BBB", notional: 400 })],
    p,
    DEFAULT_LIMITS,
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
    DEFAULT_LIMITS,
  );
  assert.equal(res.accepted.length, 1);
  assert.equal(res.rejected.length, 0);
});

test("validateOrders: SELL with no position is rejected", () => {
  const p = basePortfolio();
  const res = validateOrders(
    [{ ticker: "NVDA", side: "SELL", notional: 600, price: 100 }],
    p,
    DEFAULT_LIMITS,
  );
  assert.equal(res.accepted.length, 0);
  assert.match(res.rejected[0].reason, /no position/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: FAIL — `validateOrders` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `agent/lib/risk.ts`:

```ts
export function validateOrders(
  orders: ProposedOrder[],
  p: PortfolioSnapshot,
  limits: RiskLimits,
): ValidationResult {
  const halt = checkHalt(p, limits);
  if (halt.halted) {
    return {
      accepted: [],
      rejected: orders.map((order) => ({
        order,
        reason: `trading halted: ${halt.reason}`,
      })),
    };
  }

  const accepted: ProposedOrder[] = [];
  const rejected: Rejection[] = [];

  const running: RunningState = {
    cash: p.cash,
    valueByTicker: new Map(p.positions.map((pos) => [pos.ticker, pos.value])),
    distinctPositions: p.positions.length,
    newPositionsToday: p.newPositionsToday,
  };

  for (const order of orders) {
    if (order.side === "SELL") {
      const held = running.valueByTicker.get(order.ticker);
      if (held === undefined) {
        rejected.push({ order, reason: "no position to sell" });
      } else if (order.notional > held) {
        rejected.push({ order, reason: "sell exceeds position value" });
      } else {
        accepted.push(order);
        const remaining = held - order.notional;
        running.cash += order.notional;
        if (remaining <= 0) {
          running.valueByTicker.delete(order.ticker);
          running.distinctPositions -= 1;
        } else {
          running.valueByTicker.set(order.ticker, remaining);
        }
      }
      continue;
    }

    const reason = evaluateBuy(order, p, limits, running);
    if (reason) {
      rejected.push({ order, reason });
      continue;
    }
    const isNew = !running.valueByTicker.has(order.ticker);
    accepted.push(order);
    running.cash -= order.notional;
    running.valueByTicker.set(
      order.ticker,
      (running.valueByTicker.get(order.ticker) ?? 0) + order.notional,
    );
    if (isNew) {
      running.distinctPositions += 1;
      running.newPositionsToday += 1;
    }
  }

  return { accepted, rejected };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-strip-types "agent/lib/risk.test.ts"`
Expected: PASS (all tests).

- [ ] **Step 5: Run typecheck**

Run: `corepack pnpm@10.26.0 run typecheck`
Expected: no output / exit 0.

- [ ] **Step 6: Commit**

```bash
git add agent/lib/risk.ts agent/lib/risk.test.ts
git commit -m "feat(risk): add batch order validation with cumulative accounting"
```

---

## Self-Review

**1. Spec coverage** (design doc risk table + halt policy):
- Per-name 18% → Task 3 concentration check ✓
- Max deployed 80% / cash floor → Task 3 cash-floor check ✓
- Max new positions/day 3 → Task 3 ✓
- Per-trade 2–8% → Task 3 ✓
- Daily loss −4% halt (auto-resume) → Task 2 ✓
- Max concurrent 10 → Task 3 ✓
- Min price $5 → Task 3 ✓
- Circuit breaker (−10% drawdown / 2 loss days, manual resume) → Task 2 ✓
- Cumulative batch effect → Task 4 ✓
- Stop-loss (−8%): NOT in this plan — it's a position-management action (sell trigger) handled by the orchestrator/strategy, not the order-admission gate. Tracked for a later plan.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — all steps contain complete code. ✓

**3. Type consistency:** `RiskLimits`, `PortfolioSnapshot`, `ProposedOrder`, `RunningState`, `ValidationResult`, `HaltDecision` used identically across Tasks 1–4. `evaluateBuy` signature in Task 3 matches its call in Task 4. `checkHalt` signature in Task 2 matches its call in Task 4. ✓

## What this plan deliberately excludes (future plans, after API-verification spike)

- **API-verification spike** (do first before the T212/data plans): confirm Trading 212 demo vs live base URLs, order endpoints/types Invest supports, rate limits, auth; confirm Finnhub free-tier endpoint coverage; confirm eve `defineTool`/`defineState`/schedule/Slack-channel APIs from `node_modules/eve/docs`.
- **T212 tool layer** (`agent/tools/t212_*.ts`, `agent/lib/t212.ts`) — needs verified API.
- **Data layer** (`agent/tools/get_news.ts`, `get_prices.ts`, `agent/lib/data.ts`) — needs Finnhub verification.
- **`validate_orders` eve tool** — thin wrapper calling `validateOrders` after fetching the live portfolio via the T212 tool. Depends on T212 layer.
- **Research + red-team subagents**, **schedules** (pre_open/cycle/eod), **Slack reporting**, **durable state** (`agent/lib/state.ts` via `defineState`), **HITL approval** (Phase 2).
