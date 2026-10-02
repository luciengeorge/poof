import { validateOrders, DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";
import {
  buildRiskSnapshot,
  brokerSnapshotWithFx,
  reconcileAccountValueGbp,
  notionalToShares,
  roundQuantity,
  parseQuantityPrecision,
  DEFAULT_QUANTITY_PRECISION,
} from "./execution.ts";
import { T212Error, type BrokerAccountSnapshot, type T212Order } from "./t212.ts";
import type { RiskState } from "./state.ts";
import { etDateString } from "./clock.ts";
import { redact } from "./redact.ts";
import type { FxResolution } from "./fx.ts";

/**
 * If `err` is a T212 rejection of THIS specific order (min-position, insufficient funds,
 * not tradable, etc.) rather than an infra failure, return a concise skip reason. 429s are
 * excluded: those are rate-limit exhaustion, not a business rejection, and 5xx/network
 * errors aren't T212Error at all (or aren't 4xx), so they fall through to null.
 */
function t212RejectionSkip(err: unknown): string | null {
  if (!(err instanceof T212Error)) return null;
  if (err.rateLimited || err.status < 400 || err.status >= 500) return null;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(err.body);
    detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : typeof parsed?.title === "string"
          ? parsed.title
          : undefined;
  } catch {
    // body wasn't JSON: fall back to the error message below
  }
  return `T212 rejected: ${detail ?? err.message}`;
}

/**
 * Place a market order, adapting to T212's per-instrument quantity precision. First tries
 * a clean DEFAULT_QUANTITY_PRECISION quantity; on an "invalid quantity precision N" error,
 * re-rounds DOWN to N decimals and retries once. If it rounds to 0 (share too dear for this
 * notional at the allowed precision), returns a skip instead of firing blind orders.
 *
 * A T212 rejection of this specific order (min-position, insufficient funds, not tradable,
 * etc.) is also returned as a skip rather than thrown: one bad order shouldn't abort the
 * rest of the batch. Genuine infra failures (network, 5xx, exhausted rate-limit backoff)
 * still throw so they surface instead of being silently swallowed.
 */
export async function placeWithPrecision(
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
    if (allowed !== null) {
      const adjusted = roundQuantity(magnitude, allowed);
      if (adjusted <= 0) {
        return {
          skipped: `quantity rounds to 0 at ${allowed}dp (share price too high for this trade size)`,
        };
      }
      return { quantity: sign * adjusted, order: await attempt(adjusted) };
    }
    const rejection = t212RejectionSkip(err);
    if (rejection !== null) return { skipped: rejection };
    throw err; // not a precision or per-order rejection: surface it
  }
}

/** The subset of T212Client the executor needs (T212Client satisfies it structurally). */
export interface OrderExecClient {
  getBrokerSnapshot(opts?: { fresh?: boolean }): Promise<BrokerAccountSnapshot>;
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
  strategyTag?: string;
  /** The agent's claimed probability this trade works, 0..1. Scored once the position closes. */
  confidence?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxHoldDays?: number;
  /** ISO date of the next earnings print, when one falls inside the hold window. Justifies a short hold. */
  earningsDate?: string;
  /** Set by submit_orders after placement, from Jev. Shadow only: recorded, scored, never acted on. */
  jevConfidence?: number;
  jevModel?: string;
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
  accountValueReconciliation?: import("./execution.ts").AccountValueReconciliation;
  /** From the gate: cash that would have let the BUYs rejected only for cash through. */
  cashShortfall?: number;
}

export interface ExecuteOpts {
  client: OrderExecClient;
  fx: FxResolution;
  dryRun: boolean;
  /**
   * Resolve the cross-cycle risk state given the freshly-computed current equity.
   * Lets the caller load durable state (Convex) + derive day-rollover/peak/halt fields.
   */
  resolveRiskState: (currentEquity: number) => Promise<RiskState>;
  /**
   * Fetch the current live price for a ticker (used to size BUYs, since the LLM-supplied
   * `proposal.price` is untrusted). Must reject/throw if the price can't be fetched: callers
   * treat a throw as fail-closed (the BUY is rejected, nothing placed). Only BUY-submitting
   * callers need to supply this; a SELL-only caller (e.g. exit management) can omit it, an
   * omitted resolvePrice is likewise treated as fail-closed if a BUY somehow reaches this path.
   */
  resolvePrice?: (ticker: string) => Promise<number>;
  limits?: RiskLimits;
  /**
   * Durable per-cycle intent marker (Convex-backed), guarding against duplicate placement
   * when a step re-runs after a market order has already filled and vanished from pending.
   * Both optional: if absent, behaves exactly as today (no marker, no dedupe beyond pending).
   * If either throws, a BUY is refused and a SELL goes ahead without the guard.
   */
  hasOrderIntent?: (key: string) => Promise<boolean>;
  recordOrderIntent?: (key: string) => Promise<void>;
  /**
   * The intent key for a proposal. Defaults to `${etDate}:${ticker}:${side}:${notional}`. A
   * caller whose notional moves between runs (an exit sized from the live market value) must
   * leave the notional out, or two runs never share a key and the guard can never fire.
   */
  intentKeyOf?: (p: Proposal) => string;
}

function defaultIntentKey(p: Proposal): string {
  return `${etDateString(new Date())}:${p.ticker}:${p.side}:${p.notional}`;
}

/** Max allowed fractional deviation between the model's price and the server-fetched price. */
const PRICE_DEVIATION_TOLERANCE = 0.05;

/**
 * Authoritative execution path. Fetches live cash + positions + pending orders, runs the
 * deterministic risk gate (which short-circuits on a halt), then for each accepted order:
 * reconciles against pending orders (the beta API isn't idempotent: skip a ticker that
 * already has a pending order so a step re-run can't duplicate), converts notional→signed
 * shares, and either logs (dryRun) or places a market order.
 */
export async function evaluateAndExecute(
  proposals: Proposal[],
  opts: ExecuteOpts,
): Promise<ExecutionResult> {
  const {
    client,
    fx,
    dryRun,
    resolveRiskState,
    resolvePrice,
    hasOrderIntent,
    recordOrderIntent,
    intentKeyOf = defaultIntentKey,
  } = opts;
  const fxRate = fx.rate;
  const limits = opts.limits ?? DEFAULT_LIMITS;

  // Force-fresh: this snapshot feeds the risk gate, and manage_positions may have already
  // sold positions earlier in the same cycle. A cached pre-sell snapshot would size/validate
  // against stale cash/positions. getPendingOrders is uncached (never stale).
  const [account, pending] = await Promise.all([
    client.getBrokerSnapshot({ fresh: true }),
    client.getPendingOrders(),
  ]);
  const brokerSnapshot = brokerSnapshotWithFx(account, fx);

  // Trading 212's total is authoritative for equity. The FX-derived value is retained only as a
  // reconciliation check and returned so the observer can alert without touching the risk gate.
  const accountValueReconciliation = reconcileAccountValueGbp(brokerSnapshot);
  const currentEquity = accountValueReconciliation.accountValueGbp;
  const riskState = await resolveRiskState(currentEquity);

  const snapshot = buildRiskSnapshot({ brokerSnapshot, ...riskState });
  // Pass full proposals through; validateOrders only reads ticker/side/notional/price,
  // but keeping the original objects means thesis/redTeamVerdict ride along to the result.
  const { accepted, rejected, cashShortfall } = validateOrders(proposals, snapshot, limits);

  const result: ExecutionResult = {
    placed: [],
    rejected: rejected.map((r) => ({
      proposal: r.order as Proposal,
      reason: r.reason,
    })),
    accountValueReconciliation,
    cashShortfall,
  };

  // The duplicate guard itself failing (its Convex read or write throws) is handled by side; the
  // comment on the intent write below says why. Returns true when the order must not be placed.
  const refusedForGuardFailure = (
    proposal: Proposal,
    step: "read" | "write",
    err: unknown,
  ): boolean => {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (proposal.side === "BUY") {
      result.rejected.push({
        proposal,
        reason: `not placed: duplicate guard unavailable: ${detail}`,
      });
      return true;
    }
    console.warn(
      `[orders] intent ${step} failed for SELL ${proposal.ticker}; selling without the guard:`,
      detail,
    );
    return false;
  };

  for (const [i, order] of accepted.entries()) {
    const proposal = order as Proposal;
    let sendStarted = false;

    try {
      if (pending.some((o) => o.ticker === proposal.ticker)) {
        result.placed.push({
          proposal,
          quantity: 0,
          dryRun,
          skipped: "a pending order already exists for this ticker",
        });
        continue;
      }

      const intentKey = intentKeyOf(proposal);
      let intentRecorded = false;
      if (hasOrderIntent) {
        try {
          intentRecorded = await hasOrderIntent(intentKey);
        } catch (err) {
          if (refusedForGuardFailure(proposal, "read", err)) continue;
        }
      }
      if (intentRecorded) {
        result.placed.push({
          proposal,
          quantity: 0,
          dryRun,
          skipped: "duplicate: order intent already recorded this cycle",
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
            reason: `could not fetch live price for ${proposal.ticker}: ${redact(
              err instanceof Error ? err.message : String(err),
            )}`,
          });
          continue;
        }
        const deviation = Math.abs(proposal.price - serverPrice) / serverPrice;
        if (deviation > PRICE_DEVIATION_TOLERANCE) {
          result.rejected.push({
            proposal,
            reason: `price mismatch: model $${proposal.price} vs live $${serverPrice}`,
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

      // A BUY's marker goes down BEFORE the order is sent. Written after, a process killed between
      // the broker accepting a market order and the marker landing leaves neither a pending order
      // nor a marker, and a re-run places the trade twice. Written first, the worst case is
      // over-blocking: a BUY that then fails keeps its marker and cannot be retried until the
      // next ET day. If the guard cannot be read or written, the BUY is refused: a duplicate BUY
      // is the hazard this guard exists for, and a refused BUY just waits a cycle (the same rule
      // as fundFromCore's "no marker, no sale").
      //
      // A SELL's marker goes down only AFTER the broker accepts the order. Written first, an exit
      // that Trading 212 refuses, or whose send throws, keeps its marker, and the agent's next
      // manage_positions call that day reports a duplicate and never sends the stop-loss. The
      // early marker buys a SELL almost nothing: if the first sale filled, the re-run's fresh
      // portfolio no longer holds the position, so no exit fires; if it is still pending, the
      // pending-order check above skips it. A SELL also goes ahead when the guard cannot be read,
      // and a failed write after the sale is only logged. A duplicate SELL cannot oversell, since
      // an ISA cannot short and Trading 212 rejects selling shares not held, while a stop-loss
      // blocked by a Convex blip is the worse failure.
      if (recordOrderIntent && proposal.side === "BUY") {
        try {
          await recordOrderIntent(intentKey);
        } catch (err) {
          if (refusedForGuardFailure(proposal, "write", err)) continue;
        }
      }
      sendStarted = true;
      const outcome = await placeWithPrecision(client, proposal.ticker, magnitude, sign);
      if ("skipped" in outcome) {
        result.placed.push({ proposal, quantity: 0, dryRun: false, skipped: outcome.skipped });
      } else {
        if (recordOrderIntent && proposal.side === "SELL") {
          try {
            await recordOrderIntent(intentKey);
          } catch (err) {
            console.warn(
              `[orders] intent write failed for SELL ${proposal.ticker} after it was placed:`,
              redact(err instanceof Error ? err.message : String(err)),
            );
          }
        }
        result.placed.push({
          proposal,
          quantity: outcome.quantity,
          dryRun: false,
          order: outcome.order,
        });
      }
    } catch (err) {
      // Per-order rejections were already turned into skips, so a throw here is an infra failure
      // (network, 5xx, exhausted rate-limit backoff). It is contained so the orders already placed
      // in this batch still reach the caller's recordTrade, then the batch stops: later orders
      // would meet the same failure. A throw before the send means this order was not placed. A
      // throw from placeWithPrecision is ambiguous, since the broker may have accepted the order
      // before the connection failed, so the cycle report says "outcome unknown" rather than
      // claim it was not placed. A BUY's marker, written first, stops a re-run from duplicating
      // it; a SELL has none and needs none, for the reasons on the intent write above.
      const detail = redact(err instanceof Error ? err.message : String(err));
      const status = sendStarted ? "outcome unknown" : "not placed";
      result.rejected.push({ proposal, reason: `${status}: broker error: ${detail}` });
      for (const rest of accepted.slice(i + 1)) {
        result.rejected.push({
          proposal: rest as Proposal,
          reason: `not placed: batch stopped after a broker error on ${proposal.ticker}`,
        });
      }
      break;
    }
  }

  return result;
}
