import { validateOrders, DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";
import { buildRiskSnapshot, notionalToShares } from "./execution.ts";
import type { CashBalance, T212Position, T212Order } from "./t212.ts";
import type { RiskState } from "./state.ts";

/** The subset of T212Client the executor needs (T212Client satisfies it structurally). */
export interface OrderExecClient {
  getCash(): Promise<CashBalance>;
  getPortfolio(): Promise<T212Position[]>;
  getPendingOrders(): Promise<T212Order[]>;
  placeMarketOrder(input: {
    ticker: string;
    quantity: number;
  }): Promise<T212Order>;
}

/** A proposed trade. `notional` is a positive magnitude in account currency; `side` gives direction. */
export interface Proposal {
  ticker: string;
  side: "BUY" | "SELL";
  notional: number;
  price: number;
  thesis: string;
  redTeamVerdict?: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  maxHoldDays?: number;
}

export interface PlacedResult {
  proposal: Proposal;
  quantity: number;
  dryRun: boolean;
  order?: T212Order;
  skipped?: string;
}

export interface ExecutionResult {
  placed: PlacedResult[];
  rejected: { proposal: Proposal; reason: string }[];
}

export interface ExecuteOpts {
  client: OrderExecClient;
  fxRate: number;
  dryRun: boolean;
  /**
   * Resolve the cross-cycle risk state given the freshly-computed current equity.
   * Lets the caller load durable state (Convex) + derive day-rollover/peak/halt fields.
   */
  resolveRiskState: (currentEquity: number) => Promise<RiskState>;
  limits?: RiskLimits;
}

/**
 * Authoritative execution path. Fetches live cash + positions + pending orders, runs the
 * deterministic risk gate (which short-circuits on a halt), then for each accepted order:
 * reconciles against pending orders (the beta API isn't idempotent — skip a ticker that
 * already has a pending order so a step re-run can't duplicate), converts notional→signed
 * shares, and either logs (dryRun) or places a market order.
 */
export async function evaluateAndExecute(
  proposals: Proposal[],
  opts: ExecuteOpts,
): Promise<ExecutionResult> {
  const { client, fxRate, dryRun, resolveRiskState } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;

  const [cash, positions, pending] = await Promise.all([
    client.getCash(),
    client.getPortfolio(),
    client.getPendingOrders(),
  ]);

  // Equity (account ccy) = free cash + Σ position market value (instrument ccy → account ccy).
  const deployed = positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice * fxRate,
    0,
  );
  const currentEquity = cash.free + deployed;
  const riskState = await resolveRiskState(currentEquity);

  const snapshot = buildRiskSnapshot({ cash, positions, fxRate, ...riskState });
  // Pass full proposals through; validateOrders only reads ticker/side/notional/price,
  // but keeping the original objects means thesis/redTeamVerdict ride along to the result.
  const { accepted, rejected } = validateOrders(proposals, snapshot, limits);

  const result: ExecutionResult = {
    placed: [],
    rejected: rejected.map((r) => ({
      proposal: r.order as Proposal,
      reason: r.reason,
    })),
  };

  for (const order of accepted) {
    const proposal = order as Proposal;

    if (pending.some((o) => o.ticker === proposal.ticker)) {
      result.placed.push({
        proposal,
        quantity: 0,
        dryRun,
        skipped: "a pending order already exists for this ticker",
      });
      continue;
    }

    const magnitude = notionalToShares(proposal.notional, proposal.price, fxRate);
    const quantity = proposal.side === "SELL" ? -magnitude : magnitude;

    if (dryRun) {
      result.placed.push({ proposal, quantity, dryRun: true });
      continue;
    }

    const placed = await client.placeMarketOrder({
      ticker: proposal.ticker,
      quantity,
    });
    result.placed.push({ proposal, quantity, dryRun: false, order: placed });
  }

  return result;
}
