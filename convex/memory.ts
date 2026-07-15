import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertSecret } from "./auth";

// --- mutations (writes) ---

export const recordTrade = mutation({
  args: {
    token: v.string(),
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
    stopLossPct: v.optional(v.number()),
    takeProfitPct: v.optional(v.number()),
    maxHoldDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("trades", { ...rest, createdAt: Date.now() });
  },
});

// Mark an open trade closed with its realized P&L (called when a position is exited or
// is no longer held on reconciliation).
export const closeTrade = mutation({
  args: {
    token: v.string(),
    tradeId: v.id("trades"),
    pnl: v.number(),
    exitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { tradeId, pnl, exitPrice } = args;
    await ctx.db.patch("trades", tradeId, {
      status: "closed",
      pnl,
      exitPrice,
      closedAt: Date.now(),
    });
    return tradeId;
  },
});

// Replace the standing lessons note (one row per env; the agent rewrites the whole thing).
export const saveLessons = mutation({
  args: { token: v.string(), env: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { env, text } = args;
    const existing = await ctx.db
      .query("lessons")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
    if (existing) {
      await ctx.db.patch("lessons", existing._id, {
        text,
        updatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("lessons", { env, text, updatedAt: Date.now() });
  },
});

export const getLessons = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("lessons")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .unique();
  },
});

export const saveBenchmark = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    inceptionEquity: v.number(),
    inceptionSpyPrice: v.number(),
    inceptionDate: v.string(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    const existing = await ctx.db
      .query("benchmark")
      .withIndex("by_env", (q) => q.eq("env", rest.env))
      .unique();
    if (existing) return existing._id; // baseline captured once, never overwritten
    return await ctx.db.insert("benchmark", { ...rest, updatedAt: Date.now() });
  },
});

export const recordCycle = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    equity: v.number(),
    freeCash: v.number(),
    decision: v.string(),
    rationale: v.string(),
    candidates: v.optional(v.any()),
    watchlist: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("cycles", { ...rest, createdAt: Date.now() });
  },
});

export const saveRiskState = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    peakEquity: v.number(),
    dayStartEquity: v.number(),
    dayStartDate: v.string(),
    consecutiveLossDays: v.number(),
    prevEquity: v.optional(v.number()),
    haltState: v.string(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    const existing = await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", rest.env))
      .unique();
    const patch = { ...rest, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch("riskState", existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("riskState", patch);
  },
});

export const recordMessage = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    role: v.string(),
    slackUser: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("messages", { ...rest, createdAt: Date.now() });
  },
});

export const recordCronRun = mutation({
  args: {
    token: v.string(),
    schedule: v.string(),
    firedAt: v.number(),
    marketOpen: v.optional(v.boolean()),
    dispatched: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("cronRuns", { ...rest });
  },
});

export const recordOrderIntent = mutation({
  args: { token: v.string(), env: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { env, key } = args;
    return await ctx.db.insert("orderIntents", { env, key, createdAt: Date.now() });
  },
});

// --- queries (reads) ---

export const getRiskState = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .unique();
  },
});

export const getBenchmark = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("benchmark")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .unique();
  },
});

// Open BUY positions for this account: placed (not dry-run, not closed/skipped) buys,
// most recent first. Used by the exit engine + performance review to recover each
// position's entry, thesis, and exit levels.
export const openBuys = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return ctx.db
      .query("trades")
      .withIndex("by_env_side_status", (q) =>
        q.eq("env", args.env).eq("side", "BUY").eq("status", "placed"),
      )
      .collect();
  },
});

export const latestCronRun = query({
  args: { token: v.string(), schedule: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("cronRuns")
      .withIndex("by_schedule", (q) => q.eq("schedule", args.schedule))
      .order("desc")
      .first();
  },
});

export const hasOrderIntent = query({
  args: { token: v.string(), env: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const existing = await ctx.db
      .query("orderIntents")
      .withIndex("by_env_and_key", (q) => q.eq("env", args.env).eq("key", args.key))
      .first();
    return existing !== null;
  },
});

export const recallRecent = query({
  args: {
    token: v.string(),
    env: v.string(),
    cycleLimit: v.optional(v.number()),
    tradeLimit: v.optional(v.number()),
    messageLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { env, cycleLimit, tradeLimit, messageLimit } = args;
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
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_env", (q) => q.eq("env", env))
      .order("desc")
      .take(messageLimit ?? 20);
    const riskState = await ctx.db
      .query("riskState")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
    const benchmark = await ctx.db
      .query("benchmark")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_env", (q) => q.eq("env", env))
      .unique();
    return { cycles, trades, messages, riskState, benchmark, lessons };
  },
});
