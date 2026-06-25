import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// --- mutations (writes) ---

export const recordTrade = mutation({
  args: {
    env: v.string(),
    cycleId: v.optional(v.id("cycles")),
    ticker: v.string(),
    side: v.string(),
    notional: v.number(),
    price: v.number(),
    quantity: v.number(),
    dryRun: v.boolean(),
    thesis: v.string(),
    redTeamVerdict: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("trades", { ...args, createdAt: Date.now() });
  },
});

export const recordCycle = mutation({
  args: {
    env: v.string(),
    equity: v.number(),
    freeCash: v.number(),
    decision: v.string(),
    rationale: v.string(),
    candidates: v.optional(v.any()),
    watchlist: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("cycles", { ...args, createdAt: Date.now() });
  },
});

export const saveRiskState = mutation({
  args: {
    env: v.string(),
    peakEquity: v.number(),
    dayStartEquity: v.number(),
    dayStartDate: v.string(),
    consecutiveLossDays: v.number(),
    haltState: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .unique();
    const patch = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("riskState", patch);
  },
});

export const recordMessage = mutation({
  args: {
    env: v.string(),
    sessionId: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    role: v.string(),
    slackUser: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", { ...args, createdAt: Date.now() });
  },
});

// --- queries (reads) ---

export const getRiskState = query({
  args: { env: v.string() },
  handler: async (ctx, { env }) => {
    return await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
  },
});

export const recallRecent = query({
  args: {
    env: v.string(),
    cycleLimit: v.optional(v.number()),
    tradeLimit: v.optional(v.number()),
  },
  handler: async (ctx, { env, cycleLimit, tradeLimit }) => {
    const cycles = await ctx.db
      .query("cycles")
      .withIndex("by_env", (q) => q.eq("env", env))
      .order("desc")
      .take(cycleLimit ?? 5);
    const trades = await ctx.db
      .query("trades")
      .withIndex("by_env", (q) => q.eq("env", env))
      .order("desc")
      .take(tradeLimit ?? 20);
    const riskState = await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
    return { cycles, trades, riskState };
  },
});
