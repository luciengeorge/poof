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
    // Carried through so calibration can score the claim against the realised outcome later.
    predictedConfidence: p.proposal.confidence,
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
  status?: "closed" | "closed-unknown" | "closed-estimated";
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
 * Map orphaned open BUYs (position closed elsewhere, or a pending sell that finally filled) into
 * closeTrade args.
 *
 * WHY THIS RECOVERS A P&L NOW. On 2026-08-10 three of seven closures were booked `closed-unknown`
 * with pnl 0, and that starves the learning loop by construction: `attributeFailures` excludes
 * unknown outcomes and `calibrationFrom` cannot score them, so a third of the record taught nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not estimate from the CURRENT market price. The position
 * left the broker at an unknown moment, so today's price is a guess, and a guessed outcome entering
 * attribution as though it were real is worse than a missing one: a missing outcome is excluded by
 * design, a wrong one is believed. Instead it uses `lastPrice`, the price actually OBSERVED while
 * the position was still visible, recorded every cycle for exactly this purpose.
 *
 * The result is booked `closed-estimated`, a third status distinct from both `closed` (a real exit
 * we executed and priced) and `closed-unknown` (no outcome at all), so every downstream consumer
 * decides for itself whether an observed-but-not-executed outcome counts. See attribution.ts and
 * calibration.ts, which answer that question differently and on purpose.
 */
export function buildOrphanCloseTradeArgs(
  orphans: OpenBuyTrade[],
  fxRate: number,
): CloseTradeArgs[] {
  return orphans.map((o) => {
    const { lastPrice, price, quantity } = o;
    const usable =
      typeof lastPrice === "number" &&
      typeof price === "number" &&
      typeof quantity === "number" &&
      Number.isFinite(lastPrice) &&
      Number.isFinite(price) &&
      Number.isFinite(quantity) &&
      Number.isFinite(fxRate);
    if (!usable) {
      // No observation to reconcile against: stay honestly unknown.
      return { tradeId: o._id, pnl: 0, status: "closed-unknown" as const };
    }
    return {
      tradeId: o._id,
      pnl: (lastPrice - price) * quantity * fxRate,
      exitPrice: lastPrice,
      status: "closed-estimated" as const,
    };
  });
}
