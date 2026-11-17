import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { shadowEnv } from "./shadowTypes";
import { authorizeExecution } from "./executionAuth";
import { orderEvidence } from "./reconciliationTypes";
import { researchDay } from "./shadowCalendar";
import { reconciledFill, validateFillProofs } from "./inventoryTypes";

const identity = { token: v.string(), env: shadowEnv, account: v.string(), owner: v.string() };
const lease = { ...identity, generation: v.number(), operationId: v.id("executionOperations") };

/** A separate read-only owner; never transfers or clears the original write intent. */
export const claim = mutation({
  args: { ...identity, handoff: v.optional(v.object({ owner: v.string(), generation: v.number() })) },
  handler: async (ctx, args) => {
    authorizeExecution(args);
    if (!args.owner.startsWith("reconcile/") || args.owner.length > 300) throw new Error("Invalid reconciliation owner");
    const prior = await ctx.db.query("executionEvidence").withIndex("by_env_and_account_and_owner", q =>
      q.eq("env", args.env).eq("account", args.account).eq("owner", args.owner)).unique();
    if (prior) throw new Error("Reconciliation owner already completed");
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    if (!row?.activeWrite) throw new ConvexError({ code: "NO_FENCED_ORDER", message: "No fenced order to reconcile" });
    const op = await ctx.db.get("executionOperations", row.activeWrite);
    if (!op || op.kind !== "write" || op.env !== args.env || op.account !== args.account ||
        !["pending", "unknown", "filled"].includes(op.state) || !Number.isSafeInteger(op.brokerOrderId) || op.brokerOrderId! <= 0)
      throw new ConvexError({ code: "MANUAL_AUDIT_REQUIRED", message: "Unacknowledged order requires manual audit; no automatic resend" });
    const now = Date.now();
    // The live owner that sent the order may hand it straight to a reconciler; anyone else waits for expiry.
    const handoff = args.handoff !== undefined;
    if (handoff && (row.owner !== args.handoff!.owner || row.generation !== args.handoff!.generation || op.owner !== args.handoff!.owner ||
        row.leaseUntil <= now || row.activeReads.length)) throw new Error("Stale reconciliation handoff");
    if (!handoff && row.leaseUntil > now) throw new Error("Account execution busy");
    // Expired reconciliation GETs are safe to abandon. Keep the original write unchanged.
    for (const id of row.activeReads) {
      const read = await ctx.db.get("executionOperations", id);
      if (!read || read.kind !== "read" || read.env !== args.env || read.account !== args.account)
        throw new Error("Read fence reconciliation required");
      await ctx.db.patch("executionOperations", id, { state: "read-abandoned", finishedAt: now });
    }
    const generation = row.generation + 1;
    await ctx.db.patch("executionAccounts", row._id, { owner: args.owner, generation, leaseUntil: now + 60_000,
      activeReads: [], reconciliationFor: op._id, reconciliationReads: 0 });
    return { generation, operationId: op._id, brokerOrderId: op.brokerOrderId!, ticker: op.ticker, quantity: op.quantity, startedAt: op.startedAt };
  },
});

export const begin = mutation({
  args: { ...lease, kind: v.union(v.literal("pending"), v.literal("history"), v.literal("portfolio")), cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    authorizeExecution(args);
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const op = await ctx.db.get("executionOperations", args.operationId);
    const now = Date.now();
    if (!row || !op || row.activeWrite !== op._id || row.reconciliationFor !== op._id || row.owner !== args.owner ||
        row.generation !== args.generation || row.leaseUntil <= now) throw new Error("Stale reconciliation owner");
    if (row.activeReads.length) throw new Error("Reconciliation read active");
    if ((row.reconciliationReads ?? 0) >= 8) throw new Error("Reconciliation read budget exhausted");
    if (args.cursor !== undefined && (args.kind !== "history" || !Number.isSafeInteger(args.cursor) || args.cursor < 0))
      throw new Error("Invalid history cursor");
    // The caller chooses a read kind, never a method, host or arbitrary URL.
    const path = args.kind === "pending" ? "/equity/orders" : args.kind === "portfolio" ? "/equity/portfolio" :
      `/equity/history/orders?ticker=${encodeURIComponent(op.ticker)}&limit=50${args.cursor === undefined ? "" : `&cursor=${args.cursor}`}`;
    const key = `${args.owner}/${path}`;
    const existing = await ctx.db.query("executionOperations").withIndex("by_env_and_account_and_key", q =>
      q.eq("env", args.env).eq("account", args.account).eq("key", key)).unique();
    const data = { env: args.env, account: args.account, owner: args.owner, generation: args.generation, key,
      kind: "read" as const, ticker: op.ticker, quantity: 0, day: researchDay(now), state: "sending", startedAt: now,
      attempt: (existing?.attempt ?? 0) + 1 };
    const readId = existing?._id ?? await ctx.db.insert("executionOperations", data);
    if (existing) await ctx.db.patch("executionOperations", readId, { ...data, finishedAt: undefined });
    await ctx.db.patch("executionAccounts", row._id, { activeReads: [readId], leaseUntil: now + 60_000,
      reconciliationReads: (row.reconciliationReads ?? 0) + 1 });
    return { readId, path, leaseUntil: now + 60_000 };
  },
});

/** Observation receipt only. It cannot release the write fence, reservation or position. */
export const finish = mutation({
  args: { ...lease, observedAt: v.number(), evidence: orderEvidence, fills: v.optional(v.array(reconciledFill)) },
  handler: async (ctx, args) => {
    authorizeExecution(args);
    const prior = await ctx.db.query("executionEvidence").withIndex("by_env_and_account_and_owner", q =>
      q.eq("env", args.env).eq("account", args.account).eq("owner", args.owner)).unique();
    if (prior) {
      if (prior.operationId !== args.operationId || prior.generation !== args.generation) throw new Error("Evidence owner reused");
      return { receiptId: prior._id, canClearFence: false };
    }
    const row = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const op = await ctx.db.get("executionOperations", args.operationId);
    const now = Date.now();
    if (!row || !op || row.owner !== args.owner || row.generation !== args.generation || row.activeWrite !== op._id ||
        row.reconciliationFor !== op._id || row.activeReads.length || row.leaseUntil <= now) throw new Error("Stale reconciliation evidence");
    const e = args.evidence;
    if ((row.reconciliationReads ?? 0) < 2 || !Number.isFinite(args.observedAt) || args.observedAt > now || now - args.observedAt > 120_000 ||
        !Number.isSafeInteger(e.matchedFillCount) || e.matchedFillCount < 0 || e.matchedFillCount > 150 ||
        (e.filledQuantity !== undefined && (!Number.isFinite(e.filledQuantity) || e.filledQuantity < 0 || e.filledQuantity > Math.abs(op.quantity) + 1e-9)) ||
        (e.positionQuantity !== undefined && (!Number.isFinite(e.positionQuantity) || e.positionQuantity < 0))) throw new Error("Invalid reconciliation evidence");
    if ((e.classification === "filled" && (e.filledQuantity === undefined || Math.abs(e.filledQuantity - Math.abs(op.quantity)) > 1e-9)) ||
        (e.classification === "rejected" && e.filledQuantity !== 0)) throw new Error("Inconsistent order evidence");
    if (args.fills !== undefined) validateFillProofs(args.fills, op.quantity, op.startedAt, args.observedAt, e);
    const receiptId = await ctx.db.insert("executionEvidence", { env: args.env, account: args.account, owner: args.owner,
      generation: args.generation, operationId: op._id, brokerOrderId: op.brokerOrderId!, observedAt: args.observedAt,
      recordedAt: now, readRequests: row.reconciliationReads ?? 0, evidence: e,
      ...(args.fills === undefined ? {} : { fills: args.fills }) });
    await ctx.db.patch("executionAccounts", row._id, { owner: "", leaseUntil: 0, reconciliationFor: undefined });
    return { receiptId, canClearFence: false };
  },
});
