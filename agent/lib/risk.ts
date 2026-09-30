import { isCore } from "./core.ts";

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
  /**
   * Cash, in account currency, that would have let through the BUYs rejected ONLY for want of
   * cash. 0 when there are none. The caller may raise it from the index core (core-orders.ts).
   */
  cashShortfall: number;
}

export interface HaltDecision {
  halted: boolean;
  reason: string | null;
  manualResumeRequired: boolean;
}

export interface RunningState {
  cash: number;
  valueByTicker: Map<string, number>;
  distinctPositions: number;
  newPositionsToday: number;
}

// "Concentrate, deploy, keep the breakers": seven weeks live showed the picks had positive
// expectancy (+0.8% mean per closed trade) while the account went nowhere, because the median
// order was 10 GBP on a 250 GBP account and cash drifted to 84%. A perfect signal is invisible at
// that size. The floor is now 15% of equity so a "probe" is rejected rather than placed, the
// position cap is 4 so the floor and the cap agree (4 x ~22% fills the 90% target), and 10% cash
// stays free for FX and fees. The daily-loss and drawdown breakers loosen to fit concentration:
// at 4 names a single -16% day on one 25% position is a -4% account day, which under the old 4%
// halt stopped the whole system for one stock's bad print. They remain ruin-prevention.
// Every field is overridable per-deployment via resolveLimits()/TRADING_* env vars.
export const DEFAULT_LIMITS: RiskLimits = {
  maxPerNamePct: 0.3,
  maxDeployedPct: 0.9,
  maxNewPositionsPerDay: 4,
  minTradePct: 0.15,
  maxTradePct: 0.3,
  dailyLossHaltPct: 0.06,
  maxConcurrentPositions: 4,
  minPrice: 5,
  maxDrawdownPct: 0.15,
  maxConsecutiveLossDays: 2,
};

export function checkHalt(
  p: PortfolioSnapshot,
  limits: RiskLimits,
): HaltDecision {
  const drawdown =
    p.peakEquity > 0 ? (p.peakEquity - p.equity) / p.peakEquity : 0;
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

  // The deployed cap bounds the STOCK SLEEVE. Idle money now waits in the index core rather than
  // in cash, so a floor on cash would reject every stock buy once the core had swept it up; the
  // core is the remainder of equity, not the risk this cap exists to limit.
  let stockSleeve = 0;
  for (const value of running.valueByTicker.values()) stockSleeve += value;
  if (stockSleeve + order.notional > limits.maxDeployedPct * p.equity) {
    return `would breach deployed cap (stocks > ${(limits.maxDeployedPct * 100).toFixed(0)}% of equity)`;
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

export function validateOrders(
  orders: ProposedOrder[],
  p: PortfolioSnapshot,
  limits: RiskLimits,
): ValidationResult {
  // A halt blocks NEW RISK (buys) but never de-risking: SELLs (incl. stop-losses)
  // must still go through so the agent can exit while halted.
  const halt = checkHalt(p, limits);

  const accepted: ProposedOrder[] = [];
  const rejected: Rejection[] = [];

  // Stock limits see stocks only. The index core is not a position the sleeve chose: counted,
  // it would take one of the stock slots and fill the deployed cap by itself. Equity stays the
  // broker's total, core included, so every percentage is still a share of the whole account.
  const stocks = p.positions.filter((pos) => !isCore(pos.ticker));
  const running: RunningState = {
    cash: p.cash,
    valueByTicker: new Map(stocks.map((pos) => [pos.ticker, pos.value])),
    distinctPositions: stocks.length,
    newPositionsToday: p.newPositionsToday,
  };
  let unfundedNotional = 0;

  for (const order of orders) {
    if (order.side === "SELL") {
      const held = running.valueByTicker.get(order.ticker);
      if (held === undefined) {
        rejected.push({ order, reason: "no position to sell" });
      } else {
        // Clamp instead of reject: a full-close SELL's notional is set from an earlier
        // portfolio read, so a downtick before this second read can make it look like it
        // exceeds the (now lower) held value. Rejecting would leave a stop-loss unprotected
        // until the next cron; clamping to held closes the position instead.
        const notional = Math.min(order.notional, held);
        const clamped = notional === order.notional ? order : { ...order, notional };
        accepted.push(clamped);
        const remaining = held - notional;
        // Sell proceeds are unsettled on a T212 cash ISA, so they must not fund a same-batch
        // BUY: spendable cash only decreases (on BUYs), it never increases from a SELL.
        if (remaining <= 0) {
          running.valueByTicker.delete(order.ticker);
          running.distinctPositions -= 1;
        } else {
          running.valueByTicker.set(order.ticker, remaining);
        }
      }
      continue;
    }

    if (halt.halted) {
      rejected.push({ order, reason: `trading halted: ${halt.reason}` });
      continue;
    }
    const reason = evaluateBuy(order, p, limits, running);
    if (reason) {
      rejected.push({ order, reason });
      // Re-run the same rules with unlimited cash: a buy that passes then was stopped by cash
      // alone. One that another limit would also stop is never worth raising cash for.
      if (evaluateBuy(order, p, limits, { ...running, cash: Infinity }) === null) {
        unfundedNotional += order.notional;
      }
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

  return { accepted, rejected, cashShortfall: Math.max(0, unfundedNotional - running.cash) };
}
