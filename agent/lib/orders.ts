import { validateOrders, DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";
import {
  buildRiskSnapshot,
  notionalToShares,
  roundQuantity,
  parseQuantityPrecision,
  DEFAULT_QUANTITY_PRECISION,
} from "./execution.ts";
import type { CashBalance, T212Position, T212Order } from "./t212.ts";
import type { RiskState } from "./state.ts";

/**
 * Place a market order, adapting to T212's per-instrument quantity precision. First tries
 * a clean DEFAULT_QUANTITY_PRECISION quantity; on an "invalid quantity precision N" error,
 * re-rounds DOWN to N decimals and retries once. If it rounds to 0 (share too dear for this
 * notional at the allowed precision), returns a skip instead of firing blind orders.
 */
async function placeWithPrecision(
  client: OrderExecClient,
  ticker: string,
  magnitude: number,
  sign: number,
): Promise<{ quantity: number; order: T212Order } | { skipped: string }> {
  const attempt = async (qty: number) =>
    client.placeMarketOrder({ ticker, quantity: sign * qty });

  const first = roundQuantity(magnitude, DEFAULT_QUANTITY_PRECISION);
  if (first <= 0) return { skipped: "quantity rounds to 0" };
  try {
    return { quantity: sign * first, order: await attempt(first) };
  } catch (err) {
    const allowed = parseQuantityPrecision(
      err instanceof Error ? err.message : String(err),
    );
    if (allowed === null) throw err; // not a precision problem — surface it
    const adjusted = roundQuantity(magnitude, allowed);
    if (adjusted <= 0) {
      return {
        skipped: `quantity rounds to 0 at ${allowed}dp (share price too high for this trade size)`,
      };
    }
    return { quantity: sign * adjusted, order: await attempt(adjusted) };
  }
}

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
  /**
   * Fetch the current live price for a ticker (used to size BUYs, since the LLM-supplied
   * `proposal.price` is untrusted). Must reject/throw if the price can't be fetched — callers
   * treat a throw as fail-closed (the BUY is rejected, nothing placed). Only BUY-submitting
   * callers need to supply this; a SELL-only caller (e.g. exit management) can omit it — an
   * omitted resolvePrice is likewise treated as fail-closed if a BUY somehow reaches this path.
   */
  resolvePrice?: (ticker: string) => Promise<number>;
  limits?: RiskLimits;
}

/** Max allowed fractional deviation between the model's price and the server-fetched price. */
const PRICE_DEVIATION_TOLERANCE = 0.05;

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
  const { client, fxRate, dryRun, resolveRiskState, resolvePrice } = opts;
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

    let sizingPrice = proposal.price;
    if (proposal.side === "BUY") {
      if (!resolvePrice) {
        result.rejected.push({
          proposal,
          reason: `no live price resolver configured for ${proposal.ticker}`,
        });
        continue;
      }
      let serverPrice: number;
      try {
        serverPrice = await resolvePrice(proposal.ticker);
      } catch (err) {
        result.rejected.push({
          proposal,
          reason: `could not fetch live price for ${proposal.ticker}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      const deviation = Math.abs(proposal.price - serverPrice) / serverPrice;
      if (deviation > PRICE_DEVIATION_TOLERANCE) {
        result.rejected.push({
          proposal,
          reason: `price mismatch — model $${proposal.price} vs live $${serverPrice}`,
        });
        continue;
      }
      sizingPrice = serverPrice;
    }

    const magnitude = notionalToShares(proposal.notional, sizingPrice, fxRate);
    const sign = proposal.side === "SELL" ? -1 : 1;

    if (dryRun) {
      const qty = roundQuantity(magnitude, DEFAULT_QUANTITY_PRECISION);
      result.placed.push({ proposal, quantity: sign * qty, dryRun: true });
      continue;
    }

    const outcome = await placeWithPrecision(client, proposal.ticker, magnitude, sign);
    if ("skipped" in outcome) {
      result.placed.push({ proposal, quantity: 0, dryRun: false, skipped: outcome.skipped });
    } else {
      result.placed.push({
        proposal,
        quantity: outcome.quantity,
        dryRun: false,
        order: outcome.order,
      });
    }
  }

  return result;
}
