import { v } from "convex/values";

export const orderEvidence = v.object({
  classification: v.union(v.literal("pending"), v.literal("partial"), v.literal("filled"), v.literal("rejected"), v.literal("unknown")),
  filledQuantity: v.optional(v.number()),
  positionQuantity: v.optional(v.number()),
  historyComplete: v.boolean(),
  matchedFillCount: v.number(),
  reason: v.union(v.literal("pending-order"), v.literal("matched-history"), v.literal("not-found"),
    v.literal("order-mismatch"), v.literal("invalid-response"), v.literal("history-incomplete")),
});
