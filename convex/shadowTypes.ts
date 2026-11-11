import { v } from "convex/values";

export const shadowEnv = v.union(v.literal("demo"), v.literal("live"));
export const shadowKind = v.union(v.literal("positions"), v.literal("news"), v.literal("score"));
export const shadowQuote = v.object({ symbol: v.string(), price: v.number(), at: v.number() });
export const shadowScreen = v.object({ freshCatalyst: v.number(), pricedIn: v.number(),
  strategyTag: v.string(), strategyTagConfidence: v.number(), model: v.string() });
export const shadowObservation = v.object({
  generation: v.string(), ticker: v.string(), snapshotAt: v.number(), entryPrice: v.number(),
  quantity: v.number(), basePeak: v.number(), peak: v.number(), quote: shadowQuote,
  intradayExit: v.union(v.string(), v.null()), dailyExit: v.union(v.string(), v.null()),
});
export const shadowStart = v.object({ stock: shadowQuote, proxy: shadowQuote,
  sessionOpen: v.number(), sessionClose: v.number(), sessionDay: v.string() });
export const shadowOutcome = v.object({ up: v.boolean(), relativeReturn: v.number(),
  brier: v.number(), constantBrier: v.number(), baseRateBrier: v.union(v.number(), v.null()),
  scoredAt: v.number(), source: v.string() });
