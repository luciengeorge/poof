import type { BrokerFill } from "./inventory-store.ts";
import type { FencedOrder, OrderEvidence } from "./reconciliation-store.ts";
import { matchesOrder } from "./order-evidence.ts";

const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
/** Seal only the known order's complete, normalized GBP-wallet fills. Missing SELL P&L
 * stays unavailable; native-price differences never substitute for broker P&L. */
export function brokerFillProofs(expected: FencedOrder, history: unknown[], evidence: OrderEvidence, observedAt: number): BrokerFill[] | undefined {
  if (!evidence.historyComplete || !["filled", "partial", "rejected"].includes(evidence.classification) ||
      evidence.filledQuantity === undefined || !Number.isFinite(evidence.filledQuantity) || history.length > 150) return undefined;
  const fills = new Map<number, BrokerFill>();
  let matchedOrder = false;
  for (const item of history) {
    const row = object(item), order = object(row?.order);
    if (order?.id !== expected.brokerOrderId) continue;
    if (!matchesOrder(order, expected)) return undefined;
    matchedOrder = true;
    const fill = object(row?.fill);
    if (!fill) continue;
    const wallet = object(fill.walletImpact);
    const filledAt = typeof fill.filledAt === "string" ? Date.parse(fill.filledAt) : NaN;
    // A BUY has no realized position gain. Fees are not invented or included by this ledger.
    const pnl = expected.quantity > 0 && (wallet?.realisedProfitLoss === undefined || wallet.realisedProfitLoss === null)
      ? 0 : wallet?.realisedProfitLoss;
    if (!Number.isSafeInteger(fill.id) || (fill.id as number) <= 0 || fill.type !== "TRADE" ||
        typeof fill.quantity !== "number" || !Number.isFinite(fill.quantity) || fill.quantity === 0 ||
        typeof fill.price !== "number" || !Number.isFinite(fill.price) || fill.price <= 0 ||
        !Number.isFinite(filledAt) || filledAt < expected.startedAt - 10_000 || filledAt > observedAt ||
        wallet?.currency !== "GBP" || typeof pnl !== "number" || !Number.isFinite(pnl) || (expected.quantity > 0 && pnl !== 0)) return undefined;
    const normalized: BrokerFill = { id: fill.id as number, quantity: Math.abs(fill.quantity), price: fill.price,
      filledAt, walletCurrency: "GBP", realizedPnlGbp: pnl };
    const prior = fills.get(normalized.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) return undefined;
    fills.set(normalized.id, normalized);
  }
  const result = [...fills.values()].sort((a, b) => a.id - b.id);
  if (!matchedOrder || result.length !== evidence.matchedFillCount || Math.abs(result.reduce((n, f) => n + f.quantity, 0) - evidence.filledQuantity) > 1e-9)
    return undefined;
  return result;
}
