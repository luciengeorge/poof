import { v } from "convex/values";

export const inventoryPosition = v.object({ ticker: v.string(), quantity: v.number(), averagePrice: v.number() });
export const reconciledFill = v.object({ id: v.number(), quantity: v.number(), price: v.number(), filledAt: v.number(),
  walletCurrency: v.literal("GBP"), realizedPnlGbp: v.number() });

export interface FillProof { id: number; quantity: number; price: number; filledAt: number; walletCurrency: "GBP"; realizedPnlGbp: number }
export function validateFillProofs(fills: FillProof[], quantity: number, startedAt: number, observedAt: number,
  evidence: { historyComplete: boolean; classification: string; matchedFillCount: number; filledQuantity?: number }): void {
  if (!Number.isFinite(quantity) || quantity === 0 || !Number.isFinite(startedAt) || !Number.isFinite(observedAt) ||
      !Number.isFinite(evidence.filledQuantity) || !evidence.historyComplete || !["filled", "partial", "rejected"].includes(evidence.classification) ||
      evidence.filledQuantity === undefined || fills.length > 150 || fills.length !== evidence.matchedFillCount)
    throw new Error("Incomplete fill proofs");
  const ids = new Set<number>();
  for (const f of fills) {
    if (!Number.isSafeInteger(f.id) || f.id <= 0 || ids.has(f.id) || !Number.isFinite(f.quantity) || f.quantity <= 0 ||
        !Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(f.filledAt) || f.filledAt < startedAt - 10_000 ||
        f.filledAt > observedAt || f.walletCurrency !== "GBP" || !Number.isFinite(f.realizedPnlGbp) || (quantity > 0 && f.realizedPnlGbp !== 0))
      throw new Error("Invalid normalized broker fill");
    ids.add(f.id);
  }
  const sum = fills.reduce((n, f) => n + f.quantity, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - evidence.filledQuantity) > 1e-9 || sum > Math.abs(quantity) + 1e-9)
    throw new Error("Inconsistent fill proofs");
}
