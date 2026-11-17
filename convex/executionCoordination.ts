import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertSecret } from "./auth";
import { shadowEnv } from "./shadowTypes";
import { researchDay, researchSession } from "./shadowCalendar";
import { executionSessionOpen } from "./executionCalendar";
declare const process: { env: Record<string, string | undefined> };
const identity = { token: v.string(), env: shadowEnv, account: v.string() };
const owner = { ...identity, owner: v.string() };
function authorize(args: { token: string; account: string }, requireEnabled = true) {
  assertSecret(args.token);
  if ((requireEnabled && process.env.EXECUTION_COORDINATION_ENABLED !== "true") || !process.env.EXECUTION_ACCOUNT_ID ||
      args.account !== process.env.EXECUTION_ACCOUNT_ID) throw new Error("Execution coordination unavailable");
}

export const claim = mutation({
  args: owner,
  handler: async (ctx, args) => {
    authorize(args);
    if (!args.owner || args.owner.length > 300) throw new Error("Invalid execution owner");
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const now = Date.now();
    if (row?.draining || (row && row.owner !== args.owner &&
        (row.leaseUntil > now || row.activeWrite || row.activeReads.length))) throw new Error("Account execution busy");
    const generation = !row ? 1 : row.owner === args.owner && row.leaseUntil > now ? row.generation : row.generation + 1;
    // Never transfer an in-flight operation, even after expiry. Lease expiry is not quiescence.
    if (row && generation !== row.generation && (row.activeWrite || row.activeReads.length)) throw new Error("Account reconciliation required");
    const data = { owner: args.owner, generation, leaseUntil: now + 60_000 };
    if (row) await ctx.db.patch("executionAccounts", row._id, data);
    else await ctx.db.insert("executionAccounts", { env: args.env, account: args.account, ...data, draining: false, activeReads: [] });
    return { generation };
  },
});

export const begin = mutation({
  args: { ...owner, generation: v.number(), key: v.string(), kind: v.union(v.literal("read"), v.literal("write")), ticker: v.string(), quantity: v.number() },
  handler: async (ctx, args) => {
    authorize(args);
    const account = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const now = Date.now();
    if (!account || account.draining || account.owner !== args.owner || account.generation !== args.generation || account.leaseUntil <= now)
      throw new Error("Stale execution owner");
    if (!args.key || args.key.length > 700 || !Number.isFinite(args.quantity)) throw new Error("Invalid operation");
    if (account.activeWrite || (args.kind === "write" && account.activeReads.length) || account.activeReads.length >= 8)
      throw new Error("Physical broker operation active");
    const supportedTicker = /^[A-Za-z0-9._-]{1,40}$/.test(args.ticker) &&
      (args.ticker === "VUAGl_EQ" || args.ticker.endsWith("_US_EQ"));
    if (args.kind === "write" && (!supportedTicker || !args.quantity || !executionSessionOpen(now, args.ticker, researchSession(researchDay(now)))))
      throw new Error("Execution market closed or unsupported");
    const existing = await ctx.db.query("executionOperations").withIndex("by_env_and_account_and_key", q =>
      q.eq("env", args.env).eq("account", args.account).eq("key", args.key)).unique();
    if (existing && (existing.kind !== args.kind || existing.owner !== args.owner || existing.ticker !== args.ticker ||
        (args.kind === "read" && existing.state === "sending") ||
        (args.kind === "write" && (!existing.retryableRejection || existing.attempt >= 2 || existing.state !== "rejected" ||
          Math.sign(args.quantity) !== Math.sign(existing.quantity) || Math.abs(args.quantity) >= Math.abs(existing.quantity)))))
      throw new Error("Operation already attempted or unresolved");
    const day = researchDay(now);
    if (existing && args.kind === "write" && existing.day !== day) throw new Error("Operation belongs to an earlier trading day");
    const entry = args.kind === "write" && args.quantity > 0 && args.ticker !== "VUAGl_EQ";
    if (entry) {
      let baseline = await ctx.db.query("executionDays").withIndex("by_env_and_account_and_day", q =>
        q.eq("env", args.env).eq("account", args.account).eq("day", day)).unique();
      if (!baseline) {
        // A 27-hour indexed window covers even a 25-hour ET DST day. Fail closed on
        // truncation instead of assuming creation order proves the baseline complete.
        const trades = await ctx.db.query("trades").withIndex("by_env_and_createdAt", q =>
          q.eq("env", args.env).gte("createdAt", now - 27 * 3_600_000).lte("createdAt", now)).take(201);
        if (trades.length === 201) throw new Error("Daily baseline incomplete");
        const today = trades.filter(t => researchDay(t.createdAt) === day);
        const baselineEntries = today.filter(t => t.side === "BUY" && t.ticker !== "VUAGl_EQ" && !t.dryRun && ["placed", "closed", "closed-estimated", "closed-unknown"].includes(t.status)).length;
        const id = await ctx.db.insert("executionDays", { env: args.env, account: args.account, day, baselineEntries });
        baseline = (await ctx.db.get("executionDays", id))!;
      }
      const reservations = await ctx.db.query("executionEntries").withIndex("by_env_and_account_and_day_and_released", q =>
        q.eq("env", args.env).eq("account", args.account).eq("day", day).eq("released", false)).take(5);
      if (baseline.baselineEntries + reservations.length >= 4) throw new Error("Daily entry cap reached");
    }
    const data = { state: "sending", quantity: args.quantity, generation: args.generation,
      startedAt: now, attempt: (existing?.attempt ?? 0) + 1, retryableRejection: false };
    const operationId = existing?._id ?? await ctx.db.insert("executionOperations", { env: args.env, account: args.account,
      owner: args.owner, key: args.key, kind: args.kind, ticker: args.ticker, day, ...data });
    if (existing) await ctx.db.patch("executionOperations", operationId, { ...data, finishedAt: undefined, brokerOrderId: undefined });
    if (entry) {
      const reservation = await ctx.db.query("executionEntries").withIndex("by_operationId", q => q.eq("operationId", operationId)).unique();
      if (reservation) await ctx.db.patch("executionEntries", reservation._id, { released: false });
      else await ctx.db.insert("executionEntries", { env: args.env, account: args.account, day, operationId, released: false });
    }
    await ctx.db.patch("executionAccounts", account._id, args.kind === "write" ? { activeWrite: operationId } : { activeReads: [...account.activeReads, operationId] });
    return { operationId, leaseUntil: account.leaseUntil };
  },
});

export const settle = mutation({
  args: { ...owner, generation: v.number(), operationId: v.id("executionOperations"),
    outcome: v.union(v.literal("read-completed"), v.literal("read-failed"), v.literal("not-sent"), v.literal("filled"), v.literal("rejected"), v.literal("pending"), v.literal("unknown")),
    retryableRejection: v.optional(v.boolean()), brokerOrderId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    authorize(args);
    const account = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const op = await ctx.db.get("executionOperations", args.operationId);
    if (!account || !op || op.env !== args.env || op.account !== args.account || op.owner !== args.owner ||
        op.generation !== args.generation || account.owner !== args.owner || account.generation !== args.generation) throw new Error("Stale operation settlement");
    if (op.state !== "sending") return null;
    if ((op.kind === "read") !== args.outcome.startsWith("read-")) throw new Error("Invalid settlement kind");
    if (args.outcome === "filled" && (!Number.isSafeInteger(args.brokerOrderId) || args.brokerOrderId! <= 0)) throw new Error("Missing broker acknowledgement");
    await ctx.db.patch("executionOperations", op._id, { state: args.outcome, finishedAt: Date.now(),
      retryableRejection: args.outcome === "rejected" && args.retryableRejection === true, brokerOrderId: args.brokerOrderId });
    // An acknowledgement does not reconcile position generation, residual quantity or bookkeeping.
    // All accepted/ambiguous writes stay fenced until the separate reconciliation slice exists.
    if (["unknown", "pending", "filled"].includes(args.outcome)) return null;
    await ctx.db.patch("executionAccounts", account._id, op.kind === "read" ? { activeReads: account.activeReads.filter(id => id !== op._id) } : { activeWrite: undefined });
    if (args.outcome === "rejected" || args.outcome === "not-sent") {
      const reservation = await ctx.db.query("executionEntries").withIndex("by_operationId", q => q.eq("operationId", op._id)).unique();
      if (reservation) await ctx.db.patch("executionEntries", reservation._id, { released: true });
    }
    return null;
  },
});

export const release = mutation({
  args: owner,
  handler: async (ctx, args) => {
    authorize(args);
    const account = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    if (!account || account.owner !== args.owner) return false;
    if (account.activeWrite || account.activeReads.length) return false;
    await ctx.db.patch("executionAccounts", account._id, { owner: "", leaseUntil: 0 });
    return true;
  },
});

export const drain = mutation({
  args: { ...identity, draining: v.boolean() },
  handler: async (ctx, args) => {
    authorize(args, false);
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    if (row) await ctx.db.patch("executionAccounts", row._id, { draining: args.draining });
    else await ctx.db.insert("executionAccounts", { env: args.env, account: args.account, owner: "", generation: 0, leaseUntil: 0, draining: args.draining, activeReads: [] });
    return { quiescent: !row?.activeWrite && !row?.activeReads.length };
  },
});

export const status = query({
  args: identity,
  handler: async (ctx, args) => {
    authorize(args, false);
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    return { draining: row?.draining ?? false, activeReads: row?.activeReads.length ?? 0,
      unresolvedWrite: !!row?.activeWrite, leaseUntil: row?.leaseUntil ?? null };
  },
});
