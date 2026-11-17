import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { shadowEnv } from "./shadowTypes";
import { authorizeExecution } from "./executionAuth";
import { inventoryPosition, validateFillProofs } from "./inventoryTypes";
const identity = { token: v.string(), env: shadowEnv, account: v.string() };
const EPSILON = 1e-9;
const close = (a: number, b: number) => Math.abs(a - b) <= EPSILON;
const validTicker = (s: string) => /^[A-Za-z0-9._-]{1,40}$/.test(s) && (s === "VUAGl_EQ" || s.endsWith("_US_EQ"));

/** Adopt only a fresh owned broker baseline with verified zero pending orders.
 * Existing inventory can be confirmed, never silently reset around a manual change. */
export const baseline = mutation({
  args: { ...identity, owner: v.string(), generation: v.number(), positions: v.array(inventoryPosition),
    positionsReadAt: v.number(), pendingReadAt: v.number(), pendingCount: v.number() },
  handler: async (ctx, args) => {
    authorizeExecution(args);
    const account = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const now = Date.now();
    if (!account || account.owner !== args.owner || account.generation !== args.generation || account.leaseUntil <= now ||
        account.activeReads.length || account.activeWrite || account.reconciliationFor) throw new Error("Baseline requires a quiescent current owner");
    if (args.positions.length > 128 || args.pendingCount !== 0 || !Number.isFinite(args.positionsReadAt) ||
        !Number.isFinite(args.pendingReadAt) || args.pendingReadAt > args.positionsReadAt || args.positionsReadAt > now ||
        now - args.pendingReadAt > 120_000) throw new Error("Baseline observations unavailable or stale");
    const seen = new Set<string>();
    for (const p of args.positions) {
      if (!validTicker(p.ticker) || !Number.isFinite(p.quantity) || p.quantity <= 0 || !Number.isFinite(p.averagePrice) ||
          p.averagePrice <= 0 || seen.has(p.ticker)) throw new Error("Invalid broker baseline");
      seen.add(p.ticker);
    }
    const open = await ctx.db.query("positionGenerations").withIndex("by_env_and_account_and_status", q =>
      q.eq("env", args.env).eq("account", args.account).eq("status", "open")).take(129);
    if (open.length > 128) throw new Error("Inventory exceeds reconciliation bound");
    if (account.inventoryInitialized) {
      if (open.some(g => args.positionsReadAt < g.observedAt)) throw new Error("Baseline observations precede reconciled inventory");
      if (open.length !== args.positions.length || args.positions.some(p => !open.some(g => g.ticker === p.ticker &&
          g.quantity === p.quantity && (g.brokerAveragePrice === undefined || close(g.brokerAveragePrice, p.averagePrice)))))
        throw new Error("Broker inventory changed; manual audit required");
      // Broker rounding/fees need not match our fill-derived basis. Confirm a separate
      // broker basis after a BUY; subsequent refreshes compare broker observations only.
      for (const g of open) await ctx.db.patch("positionGenerations", g._id, {
        observedAt: args.positionsReadAt, brokerAveragePrice: args.positions.find(p => p.ticker === g.ticker)!.averagePrice,
      });
    } else {
      if (open.length) throw new Error("Inventory baseline already exists");
      for (const p of args.positions) {
        const prior = await ctx.db.query("positionGenerations").withIndex("by_env_and_account_and_ticker_and_generation", q =>
          q.eq("env", args.env).eq("account", args.account).eq("ticker", p.ticker)).order("desc").first();
        if (prior) throw new Error("Inventory history requires manual audit");
        await ctx.db.insert("positionGenerations", { env: args.env, account: args.account, ticker: p.ticker, generation: 1,
          status: "open", quantity: p.quantity, averagePrice: p.averagePrice, brokerAveragePrice: p.averagePrice,
          instrumentCurrency: p.ticker === "VUAGl_EQ" ? "GBP" : "USD",
          realizedPnlGbp: 0, origin: "broker-baseline", observedAt: args.positionsReadAt });
      }
      await ctx.db.patch("executionAccounts", account._id, { inventoryInitialized: true });
    }
    return { confirmedPositions: args.positions.length, canDispatch: false };
  },
});

/** Idempotent isolated bookkeeping only. It never releases the account or daily reservation. */
export const apply = mutation({
  args: { ...identity, evidenceId: v.id("executionEvidence") },
  handler: async (ctx, args) => {
    authorizeExecution(args);
    const evidence = await ctx.db.get("executionEvidence", args.evidenceId);
    const op = evidence && await ctx.db.get("executionOperations", evidence.operationId);
    if (!evidence || !op || evidence.env !== args.env || evidence.account !== args.account || evidence.fills === undefined)
      throw new Error("Sealed broker fills unavailable");
    validateFillProofs(evidence.fills, op.quantity, op.startedAt, evidence.observedAt, evidence.evidence);
    const sorted = [...evidence.fills].sort((a, b) => a.id - b.id);
    const ids = new Set(sorted.map(f => f.id));
    const fingerprint = JSON.stringify(sorted.map(f => [f.id, f.quantity, f.price, f.filledAt, f.walletCurrency, f.realizedPnlGbp]));
    const priorReceipt = await ctx.db.query("inventoryReceipts").withIndex("by_evidenceId", q => q.eq("evidenceId", args.evidenceId)).unique();
    if (priorReceipt) {
      if (priorReceipt.env !== args.env || priorReceipt.account !== args.account || priorReceipt.fingerprint !== fingerprint)
        throw new Error("Bookkeeping receipt conflict");
      return { receiptId: priorReceipt._id, replayed: true, appliedFills: 0, canClearFence: false };
    }
    const account = await ctx.db.query("executionAccounts").withIndex("by_env_and_account", q => q.eq("env", args.env).eq("account", args.account)).unique();
    const now = Date.now();
    if (!account?.inventoryInitialized || !evidence || !op || evidence.env !== args.env || evidence.account !== args.account ||
        op.env !== args.env || op.account !== args.account || op.kind !== "write" || account.activeWrite !== op._id ||
        account.activeReads.length || account.owner !== "" || account.leaseUntil !== 0 || account.reconciliationFor || account.generation !== evidence.generation ||
        evidence.brokerOrderId !== op.brokerOrderId || evidence.observedAt > now || now - evidence.observedAt > 120_000)
      throw new Error("Bookkeeping requires fresh owned reconciliation evidence");
    const e = evidence.evidence;
    const totalQuantity = sorted.reduce((sum, f) => sum + f.quantity, 0);
    if (!e.historyComplete || !["filled", "partial", "rejected"].includes(e.classification) || e.positionQuantity === undefined ||
        e.filledQuantity === undefined || e.matchedFillCount !== sorted.length || !Number.isFinite(totalQuantity) ||
        !close(totalQuantity, e.filledQuantity) || totalQuantity > Math.abs(op.quantity) + EPSILON ||
        sorted.some(f => f.filledAt < op.startedAt - 10_000 || f.filledAt > evidence.observedAt || (op.quantity > 0 && f.realizedPnlGbp !== 0)))
      throw new Error("Incomplete or inconsistent fill evidence");
    const recorded = await ctx.db.query("reconciledFills").withIndex("by_operationId", q => q.eq("operationId", op._id)).take(151);
    if (recorded.length > 150 || recorded.some(r => !ids.has(r.fill.id))) throw new Error("Previously reconciled fill missing");
    const novel = [];
    for (const fill of sorted) {
      const oneFingerprint = JSON.stringify([fill.id, fill.quantity, fill.price, fill.filledAt, fill.walletCurrency, fill.realizedPnlGbp]);
      const existing = await ctx.db.query("reconciledFills").withIndex("by_env_and_account_and_fillId", q =>
        q.eq("env", args.env).eq("account", args.account).eq("fill.id", fill.id)).unique();
      if (existing) {
        if (existing.operationId !== op._id || existing.fingerprint !== oneFingerprint) throw new Error("Broker fill identity conflict");
      } else novel.push({ fill, fingerprint: oneFingerprint });
    }
    const latest = await ctx.db.query("positionGenerations").withIndex("by_env_and_account_and_ticker_and_generation", q =>
      q.eq("env", args.env).eq("account", args.account).eq("ticker", op.ticker)).order("desc").first();
    if (latest && evidence.observedAt < latest.observedAt) throw new Error("Position evidence precedes reconciled inventory");
    if (recorded.some(r => r.positionGenerationId !== latest?._id)) throw new Error("Order belongs to an earlier position generation");
    const delta = novel.reduce((sum, r) => sum + r.fill.quantity, 0) * Math.sign(op.quantity);
    const before = latest?.status === "open" ? latest.quantity : 0;
    if ((op.quantity < 0 && delta < 0 && before === 0) || before + delta < -EPSILON || !close(before + delta, e.positionQuantity))
      throw new Error("Broker residual does not match reconciled inventory");
    const realizedDelta = novel.reduce((sum, r) => sum + r.fill.realizedPnlGbp, 0);
    const nativeCost = novel.reduce((sum, r) => sum + r.fill.quantity * r.fill.price, 0);
    const realizedPnlGbp = (latest?.status === "open" ? latest.realizedPnlGbp : 0) + realizedDelta;
    if (!Number.isFinite(realizedPnlGbp) || !Number.isFinite(nativeCost)) throw new Error("Invalid fill accounting total");
    let generationId = latest?.status === "open" || recorded.length ? latest?._id : undefined;
    if (novel.length) {
      if (!latest || latest.status === "closed") {
        if (op.quantity < 0 || e.positionQuantity <= 0) throw new Error("Cannot create a sold position generation");
        const averagePrice = nativeCost / e.positionQuantity;
        if (!Number.isFinite(averagePrice) || averagePrice <= 0) throw new Error("Invalid inventory basis");
        generationId = await ctx.db.insert("positionGenerations", { env: args.env, account: args.account, ticker: op.ticker,
          generation: (latest?.generation ?? 0) + 1, status: "open", quantity: e.positionQuantity,
          averagePrice, instrumentCurrency: op.ticker === "VUAGl_EQ" ? "GBP" : "USD",
          realizedPnlGbp, origin: "reconciled-buy", openedAt: Math.min(...novel.map(r => r.fill.filledAt)), observedAt: evidence.observedAt });
      } else {
        const averagePrice = op.quantity > 0 ? (before * latest.averagePrice + nativeCost) / e.positionQuantity : latest.averagePrice;
        if (!Number.isFinite(averagePrice) || averagePrice <= 0) throw new Error("Invalid inventory basis");
        await ctx.db.patch("positionGenerations", latest._id, { quantity: e.positionQuantity, averagePrice, realizedPnlGbp,
          status: e.positionQuantity === 0 ? "closed" : "open", observedAt: evidence.observedAt,
          ...(op.quantity > 0 ? { brokerAveragePrice: undefined } : {}),
          ...(e.positionQuantity === 0 ? { closedAt: Math.max(...novel.map(r => r.fill.filledAt)) } : {}) });
      }
      for (const row of novel) await ctx.db.insert("reconciledFills", { env: args.env, account: args.account, operationId: op._id,
        positionGenerationId: generationId!, ...row });
    }
    const receiptId = await ctx.db.insert("inventoryReceipts", { env: args.env, account: args.account, evidenceId: args.evidenceId,
      operationId: op._id, ...(generationId ? { positionGenerationId: generationId } : {}), fingerprint,
      observedQuantity: e.positionQuantity, appliedFills: novel.length, recordedAt: now });
    return { receiptId, replayed: false, appliedFills: novel.length, canClearFence: false };
  },
});

export const positions = query({
  args: identity,
  handler: async (ctx, args) => {
    authorizeExecution(args, false);
    const rows = await ctx.db.query("positionGenerations").withIndex("by_env_and_account_and_status", q =>
      q.eq("env", args.env).eq("account", args.account).eq("status", "open")).take(129);
    return { positions: rows.slice(0, 128), truncated: rows.length > 128, canDispatch: false };
  },
});
