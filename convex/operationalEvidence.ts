import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertSecret } from "./auth";
import { shadowEnv } from "./shadowTypes";
import { confirmedPosition } from "./operationalTypes";

export const recordSnapshot = mutation({
  args: { token: v.string(), env: shadowEnv, observedAt: v.number(), positions: v.array(confirmedPosition) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const now = Date.now();
    if (!Number.isFinite(args.observedAt) || args.observedAt > now || now - args.observedAt > 120_000 ||
        args.positions.length > 128 || new Set(args.positions.map(p => p.ticker)).size !== args.positions.length ||
        args.positions.some(p => !/^[A-Za-z0-9._-]{1,40}$/.test(p.ticker) ||
          ![p.quantity, p.averagePrice, p.currentPrice].every(Number.isFinite) ||
          p.quantity <= 0 || p.averagePrice <= 0 || p.currentPrice <= 0)) throw new Error("Invalid broker snapshot");
    const existing = await ctx.db.query("confirmedPositionSnapshots")
      .withIndex("by_env_and_observedAt", q => q.eq("env", args.env).eq("observedAt", args.observedAt)).unique();
    if (existing) return existing._id;
    // This is an immutable broker observation, not an execution or current-quantity authority.
    // Pending orders were not part of this existing broker read; never imply there were none.
    return await ctx.db.insert("confirmedPositionSnapshots", { env: args.env, observedAt: args.observedAt,
      recordedAt: now, positions: args.positions, source: "cycle-broker-read", pendingOrders: "unverified" });
  },
});

export const recordAmbient = mutation({
  args: { token: v.string(), env: shadowEnv, sessionId: v.string(), turnId: v.string(),
    phase: v.union(v.literal("received"), v.literal("settled")),
    outcome: v.optional(v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled"))) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    if (!args.sessionId || args.sessionId.length > 200 || !args.turnId || args.turnId.length > 100 ||
        (args.phase === "settled" && !args.outcome)) throw new Error("Invalid ambient receipt");
    const row = await ctx.db.query("ambientReceipts").withIndex("by_env_and_sessionId_and_turnId", q =>
      q.eq("env", args.env).eq("sessionId", args.sessionId).eq("turnId", args.turnId)).unique();
    const patch = args.phase === "received" ? { receivedAt: row?.receivedAt ?? Date.now() } :
      { settledAt: row?.settledAt ?? Date.now(), outcome: row?.outcome ?? args.outcome };
    if (row) await ctx.db.patch("ambientReceipts", row._id, patch);
    else await ctx.db.insert("ambientReceipts", { env: args.env, sessionId: args.sessionId, turnId: args.turnId, ...patch });
    return null;
  },
});

export const status = query({
  args: { token: v.string(), env: shadowEnv },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const snapshot = await ctx.db.query("confirmedPositionSnapshots")
      .withIndex("by_env_and_observedAt", q => q.eq("env", args.env)).order("desc").first();
    const receipts = await ctx.db.query("ambientReceipts").withIndex("by_env", q => q.eq("env", args.env))
      .order("desc").take(101);
    const sample = receipts.slice(0, 100);
    return { snapshot: snapshot ? { observedAt: snapshot.observedAt, recordedAt: snapshot.recordedAt,
      positionCount: snapshot.positions.length, pendingOrders: snapshot.pendingOrders,
      executionEligible: false as const } : null,
      ambient: { sampled: sample.length, truncated: receipts.length > 100,
        received: sample.filter(r => r.receivedAt !== undefined).length,
        completed: sample.filter(r => r.outcome === "completed").length,
        failed: sample.filter(r => r.outcome === "failed").length,
        latestReceivedAt: Math.max(0, ...sample.map(r => r.receivedAt ?? 0)) || null } };
  },
});
