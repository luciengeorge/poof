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

export interface RunningState {
  cash: number;
  valueByTicker: Map<string, number>;
  distinctPositions: number;
  newPositionsToday: number;
}

// "Full deploy, keep diversification": no idle-cash floor and large per-trade size so the
// whole account can be put to work, but a per-name cap stops it going all-in on one stock.
// The daily-loss + drawdown circuit breakers below are ruin-prevention and stay tight.
// Every field is overridable per-deployment via resolveLimits()/TRADING_* env vars.
export const DEFAULT_LIMITS: RiskLimits = {
  maxPerNamePct: 0.3,
  maxDeployedPct: 1.0,
  maxNewPositionsPerDay: 6,
  minTradePct: 0.02,
  maxTradePct: 0.3,
  dailyLossHaltPct: 0.04,
  maxConcurrentPositions: 10,
  minPrice: 5,
  maxDrawdownPct: 0.1,
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
