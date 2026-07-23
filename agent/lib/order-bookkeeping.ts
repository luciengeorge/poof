/**
 * Pure mapping from order-tool execution results to Memory (Convex) mutation args.
 * Extracted from submit_orders.ts / manage_positions.ts so the status → openBuys
 * contract can be unit-tested without a live T212/Convex client.
 */
import type { Env, TradeRecord } from "./memory.ts";
import type { PlacedResult } from "./orders.ts";
import type { ManagedPosition, OpenBuyTrade } from "./positions.ts";

/**
 * The `status` recorded for a live placed order. `openBuys()` (convex/memory.ts)
 * filters trades on `status === "placed" && side === "BUY"` to find open positions
 * for the stop-loss engine: this const is the single source of truth both sides
 * must agree on.
 */
export const PLACED_STATUS = "placed";

/** Map submit_orders' evaluateAndExecute() output into recordTrade args, one per placed proposal. */
export function buildRecordTradeArgs(placed: PlacedResult[], env: Env): TradeRecord[] {
  return placed.map((p) => ({
    env,
    ticker: p.proposal.ticker,
    side: p.proposal.side,
    notional: p.proposal.notional,
    price: p.proposal.price,
    quantity: p.quantity,
    dryRun: p.dryRun,
    thesis: p.proposal.thesis,
    redTeamVerdict: p.proposal.redTeamVerdict,
    strategyTag: p.proposal.strategyTag,
    status: p.skipped ? "skipped" : p.dryRun ? "dry-run" : PLACED_STATUS,
    stopLossPct: p.proposal.stopLossPct,
    takeProfitPct: p.proposal.takeProfitPct,
    trailingStopPct: p.proposal.trailingStopPct,
    maxHoldDays: p.proposal.maxHoldDays,
  }));
}

export interface CloseTradeArgs {
  tradeId: string;
  pnl: number;
  exitPrice?: number;
  status?: "closed" | "closed-unknown";
}

/**
 * Map manage_positions' executed exits into closeTrade args: one per non-skipped
 * placed exit whose originating BUY trade is known (unknown tradeId means there's
 * nothing to close in memory, e.g. a position opened outside this system).
 */
export function buildCloseTradeArgs(
  placed: PlacedResult[],
  byTicker: Map<string, ManagedPosition>,
): CloseTradeArgs[] {
  const args: CloseTradeArgs[] = [];
  for (const p of placed) {
    if (p.skipped) continue;
    const m = byTicker.get(p.proposal.ticker);
    if (!m?.tradeId) continue;
    args.push({ tradeId: m.tradeId, pnl: m.unrealizedPnl, exitPrice: m.currentPrice });
  }
  return args;
}

/**
 * Map orphaned open BUYs (position closed elsewhere, e.g. manually) into closeTrade args.
 * Booked as "closed-unknown" (not "closed") so realizedStats doesn't count these as
 * break-even trades: the pnl:0 here is a placeholder, not a real result.
 */
export function buildOrphanCloseTradeArgs(orphans: OpenBuyTrade[]): CloseTradeArgs[] {
  return orphans.map((o) => ({ tradeId: o._id, pnl: 0, status: "closed-unknown" }));
}
