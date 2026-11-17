import { v } from "convex/values";

export const confirmedPosition = v.object({ ticker: v.string(), quantity: v.number(),
  averagePrice: v.number(), currentPrice: v.number() });
