import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertSecret } from "./auth";
import {
  decideAppend,
  mergeEventRows,
  mergeQuoteMap,
  MAX_TOOL_SEQUENCE,
} from "./traceAppend";
import {
  admitEdits,
  decayed,
  OBSERVATION_TTL_MS,
  type Edit,
  type MemoryRow,
} from "./memoryPolicy";

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
    strategyTag: v.optional(v.string()),
    status: v.string(),
    stopLossPct: v.optional(v.number()),
    takeProfitPct: v.optional(v.number()),
    trailingStopPct: v.optional(v.number()),
    maxHoldDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("trades", { ...rest, createdAt: Date.now() });
  },
});

// Ratchet a trade's high-water mark: peakPrice = max(existing ?? entryPrice, price).
// Called each cycle by the exit engine so the trailing stop only ever moves up.
export const updatePeak = mutation({
  args: { token: v.string(), tradeId: v.id("trades"), price: v.number() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { tradeId, price } = args;
    const trade = await ctx.db.get("trades", tradeId);
    if (!trade) return null;
    const peakPrice = Math.max(trade.peakPrice ?? trade.price, price);
    // Skip the write when the high-water mark is unchanged (no new high this cycle).
    if (peakPrice === trade.peakPrice) return tradeId;
    await ctx.db.patch("trades", tradeId, { peakPrice });
    return tradeId;
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
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { tradeId, pnl, exitPrice, status } = args;
    await ctx.db.patch("trades", tradeId, {
      status: status ?? "closed",
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

// --- durable structured memory (replaces the free-form lessons note) ---
//
// The write path is deliberately narrow: atomic edits only, each with a reason, and the SAME
// admission policy the tool showed the model is re-applied here at the storage boundary. The tool
// runs it to explain refusals; this mutation runs it so a future caller cannot bypass the caps,
// grant itself a directive, or grow memory without an audit trail. Same defence-in-depth spirit as
// `boundedRows` and as saveReportScore re-checking a judged verdict.

const memoryEdit = v.union(
  v.object({
    op: v.literal("add"),
    id: v.string(),
    class: v.string(),
    category: v.string(),
    condition: v.string(),
    action: v.string(),
    provenance: v.string(),
    reason: v.string(),
  }),
  v.object({
    op: v.literal("modify"),
    id: v.string(),
    condition: v.optional(v.string()),
    action: v.optional(v.string()),
    confidence: v.optional(v.number()),
    reason: v.string(),
  }),
  v.object({
    op: v.literal("retire"),
    id: v.string(),
    reason: v.string(),
  }),
);

/** Convex rows -> the shape the pure policy reasons about. */
function toMemoryRows(docs: readonly Doc<"agentMemory">[]): MemoryRow[] {
  return docs.map((d) => ({
    id: d.memoryId,
    class: d.class as MemoryRow["class"],
    category: d.category,
    condition: d.condition,
    action: d.action,
    provenance: d.provenance as MemoryRow["provenance"],
    confidence: d.confidence,
    createdAt: d.createdAt,
    lastConfirmedAt: d.lastConfirmedAt,
    ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
  }));
}

async function memoryDocs(
  ctx: QueryCtx,
  env: string,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_env", (q) => q.eq("env", env))
    .collect();
}

export const listAgentMemory = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await memoryDocs(ctx, args.env);
  },
});

/**
 * Apply up to a few atomic edits, returning a DECISION for every one of them.
 *
 * Refusals are returned rather than thrown: a rejected edit is information the agent should see
 * ("that duplicates broker_min_position"), not a failed cycle. The reason each refusal names its
 * rule is so a wrongly-refused memory is diagnosable instead of silently absent.
 */
export const applyMemoryEdits = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    edits: v.array(memoryEdit),
    sourceCycle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const now = Date.now();
    const docs = await memoryDocs(ctx, args.env);
    const byMemoryId = new Map(docs.map((d) => [d.memoryId, d]));
    const decisions = admitEdits(toMemoryRows(docs), args.edits as Edit[], now);

    const applied: string[] = [];
    for (const decision of decisions) {
      if (!decision.admitted) continue;
      const edit = decision.edit;
      if (edit.op === "add") {
        await ctx.db.insert("agentMemory", {
          env: args.env,
          memoryId: edit.id,
          class: edit.class,
          category: edit.category,
          condition: edit.condition,
          action: edit.action,
          provenance: edit.provenance,
          // A fresh memory is a hypothesis, not a fact: it starts mid-confidence and has to earn
          // standing by being reconfirmed, per the survey's probation guidance.
          confidence: edit.provenance === "user" ? 1 : 0.6,
          createdAt: now,
          lastConfirmedAt: now,
          ...(edit.class === "observation" ? { expiresAt: now + OBSERVATION_TTL_MS } : {}),
          ...(args.sourceCycle !== undefined ? { sourceCycle: args.sourceCycle } : {}),
        });
        applied.push(`add:${edit.id}`);
        continue;
      }
      const doc = byMemoryId.get(edit.id);
      if (!doc) continue; // policy already refused unknown targets; belt and braces
      if (edit.op === "modify") {
        await ctx.db.patch("agentMemory", doc._id, {
          ...(edit.condition !== undefined ? { condition: edit.condition } : {}),
          ...(edit.action !== undefined ? { action: edit.action } : {}),
          ...(edit.confidence !== undefined ? { confidence: edit.confidence } : {}),
          // An edited rule counts as reconfirmed: someone just looked at it deliberately.
          lastConfirmedAt: now,
        });
        applied.push(`modify:${edit.id}`);
        continue;
      }
      await ctx.db.insert("memoryRetirements", {
        env: args.env,
        memoryId: doc.memoryId,
        class: doc.class,
        condition: doc.condition,
        action: doc.action,
        reason: edit.reason,
        retiredBy: "agent",
        retiredAt: now,
      });
      await ctx.db.delete("agentMemory", doc._id);
      applied.push(`retire:${edit.id}`);
    }
    return {
      applied,
      decisions: decisions.map((d) => ({
        op: d.edit.op,
        id: d.edit.id,
        admitted: d.admitted,
        ...(d.rule !== undefined ? { rule: d.rule } : {}),
        ...(d.detail !== undefined ? { detail: d.detail } : {}),
      })),
    };
  },
});

/**
 * Retire whatever has lapsed, logging each one.
 *
 * Called once per cycle. This is what stops a belief formed in one market regime from standing
 * forever with the authority of a hard constraint, which is exactly what happened when an
 * observation about a single oil-price episode sat in memory as standing guidance long after it
 * stopped being true. Directives are exempt: they are not the agent's inferences and do not rot.
 */
export const expireAgentMemory = mutation({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const now = Date.now();
    const docs = await memoryDocs(ctx, args.env);
    const byMemoryId = new Map(docs.map((d) => [d.memoryId, d]));
    const { active, expired } = decayed(toMemoryRows(docs), now);

    for (const row of expired) {
      const doc = byMemoryId.get(row.id);
      if (!doc) continue;
      await ctx.db.insert("memoryRetirements", {
        env: args.env,
        memoryId: doc.memoryId,
        class: doc.class,
        condition: doc.condition,
        action: doc.action,
        reason: "lapsed without reconfirmation",
        retiredBy: "expiry",
        retiredAt: now,
      });
      await ctx.db.delete("agentMemory", doc._id);
    }
    // Persist decayed confidence so the weakening is visible in the store, not only at read time.
    for (const row of active) {
      const doc = byMemoryId.get(row.id);
      if (doc && doc.confidence !== row.confidence) {
        await ctx.db.patch("agentMemory", doc._id, { confidence: row.confidence });
      }
    }
    return { expired: expired.map((r) => r.id), active: active.length };
  },
});

export const listMemoryRetirements = query({
  args: { token: v.string(), env: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("memoryRetirements")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 20, 1), 100));
  },
});

// --- external holdings (ADVISORY ONLY) ---
//
// Holdings in a SEPARATE account the agent cannot trade. These live in their own table and
// are read by their own tool; they must never be folded into the trading account's equity,
// risk snapshot, sizing, breakers, exits, or `trades`. See the schema comment.

const EXTERNAL_INTENTS = ["exit", "hold", "add", "monitor"];

/** Upsert on (env, ticker): one row per external holding per env. */
export const upsertExternalHolding = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    ticker: v.string(),
    shares: v.number(),
    costBasisGbp: v.number(),
    currency: v.string(),
    accountLabel: v.optional(v.string()),
    taxable: v.boolean(),
    intent: v.string(),
    targetPriceUsd: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    // Bound the free numbers: a NaN/Infinity/negative here would silently poison every
    // valuation and every piece of advice derived from it.
    if (!Number.isFinite(rest.shares) || rest.shares <= 0) {
      throw new Error("shares must be a finite positive number");
    }
    if (!Number.isFinite(rest.costBasisGbp) || rest.costBasisGbp < 0) {
      throw new Error("costBasisGbp must be a finite non-negative number");
    }
    if (
      rest.targetPriceUsd !== undefined &&
      (!Number.isFinite(rest.targetPriceUsd) || rest.targetPriceUsd <= 0)
    ) {
      throw new Error("targetPriceUsd must be a finite positive number");
    }
    if (!EXTERNAL_INTENTS.includes(rest.intent)) {
      throw new Error(`intent must be one of ${EXTERNAL_INTENTS.join(" | ")}`);
    }
    const existing = await ctx.db
      .query("externalHoldings")
      .withIndex("by_env_and_ticker", (q) =>
        q.eq("env", rest.env).eq("ticker", rest.ticker),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch("externalHoldings", existing._id, {
        ...rest,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("externalHoldings", {
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removeExternalHolding = mutation({
  args: { token: v.string(), env: v.string(), ticker: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const existing = await ctx.db
      .query("externalHoldings")
      .withIndex("by_env_and_ticker", (q) =>
        q.eq("env", args.env).eq("ticker", args.ticker),
      )
      .unique();
    if (!existing) return null;
    await ctx.db.delete("externalHoldings", existing._id);
    return existing._id;
  },
});

// --- queries (reads) ---

/** All external holdings for an env. Bounded: this is a hand-maintained handful of rows. */
export const listExternalHoldings = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await ctx.db
      .query("externalHoldings")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .take(50);
  },
});

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

// --- online evals: cycle traces (OBSERVER ONLY) ---
//
// Written by agent/hooks/trace-cycle.ts to record what a production cycle actually DID (its
// ordered tool sequence) and how that behaviour graded against the shared invariants and the
// report self-consistency check. Read only by a human or by the list query below: never by the
// risk gate, position sizing, or order placement.
//
// Every row is keyed by (env, sessionId, turnId). `startCycleTrace` is the only function that
// creates a row, so the appends below are no-ops on a turn that was never marked as a cycle
// (an ad-hoc Slack question), which is what keeps chat turns out of this table.

/** Hard cap on the stored report text, well under Convex's 1MB document limit. */
const MAX_REPORT_TEXT = 8_000;

async function findTrace(
  ctx: QueryCtx,
  env: string,
  sessionId: string,
  turnId: string,
): Promise<Doc<"cycleTraces"> | null> {
  return await ctx.db
    .query("cycleTraces")
    .withIndex("by_env_and_session_and_turn", (q) =>
      q.eq("env", env).eq("sessionId", sessionId).eq("turnId", turnId),
    )
    .unique();
}

/** Open a trace for one cycle turn. Idempotent: a step re-run must not create a second row. */
export const startCycleTrace = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { env, sessionId, turnId } = args;
    const existing = await findTrace(ctx, env, sessionId, turnId);
    if (existing) return existing._id;
    return await ctx.db.insert("cycleTraces", {
      env,
      sessionId,
      turnId,
      toolSequence: [],
      callIds: [],
      invariants: [],
      violations: 0,
      startedAt: Date.now(),
    });
  },
});

/**
 * Append one tool/subagent name to the trace, atomically (the read-modify-write happens inside
 * one Convex transaction, so tool results that complete concurrently cannot lose each other).
 * Returns null when this turn has no trace, i.e. it is not a cycle.
 *
 * IDEMPOTENT on `callId`. A turn is a durable workflow that resumes from its last completed
 * step, so an `action.result` already recorded before a crash can be re-delivered on resume.
 * Appending it twice would put a second `submit_orders` in the sequence and false-trip the
 * `single-submit` invariant, and a violation alert nobody believes is worse than no alert. An
 * empty `callId` cannot be deduplicated, so it is appended rather than dropped: losing a real
 * tool call would itself be a false verdict.
 */
export const appendCycleTraceTool = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
    toolName: v.string(),
    callId: v.string(),
  },
  // Returns the append DECISION, not just an id. The caller needs it: a re-delivered result must
  // not merge its orders or exits a second time, which would manufacture a duplicate send out of
  // one real order.
  handler: async (ctx, args): Promise<"no-trace" | "duplicate" | "truncated" | "append"> => {
    assertSecret(args.token);
    const existing = await findTrace(ctx, args.env, args.sessionId, args.turnId);
    if (!existing) return "no-trace";
    const decision = decideAppend(existing, args.toolName, args.callId);
    if (decision.kind === "duplicate") return "duplicate";
    if (decision.kind === "truncated") {
      // Mark the trace LOUDLY rather than silently dropping tools: checkInvariants downgrades
      // absence-based conclusions on a truncated trace, so a cap can never turn an unknown
      // into a reported violation.
      if (existing.truncated !== true) {
        console.warn(
          `[online-eval] cycle trace ${args.sessionId}/${args.turnId} hit the ` +
            `${MAX_TOOL_SEQUENCE}-tool cap; later tools are NOT recorded and absence-based ` +
            "invariants will be reported as not-applicable",
        );
        await ctx.db.patch("cycleTraces", existing._id, { truncated: true });
      }
      // Still a FIRST delivery: the tool did not fit the sequence cap, but its orders and exits
      // are real and must still be merged, so this is not reported as a duplicate.
      return "truncated";
    }
    await ctx.db.patch("cycleTraces", existing._id, {
      toolSequence: decision.toolSequence,
      callIds: decision.callIds,
    });
    return "append";
  },
});

/**
 * Cap on any one recorded collection, enforced here at the STORAGE boundary as well.
 *
 * The primary bound is agent/lib/cycle-trace.ts, which is where truncation is detected and the
 * matching `*Truncated` flag is raised. This one exists so a future caller cannot grow a trace
 * document without a flag saying the list is incomplete, in the same spirit as `saveReportScore`
 * re-checking a judged verdict rather than trusting its caller.
 */
const MAX_TRACE_ROWS = 30;

function boundedRows<T>(
  rows: readonly T[],
  truncated: boolean | undefined,
): { rows: T[]; truncated: boolean } {
  return {
    rows: rows.slice(0, MAX_TRACE_ROWS),
    truncated: truncated === true || rows.length > MAX_TRACE_ROWS,
  };
}

/**
 * Record the cycle's observed ground truth and/or its latest report candidate. Every field is
 * optional so one caller can save whichever it just saw. Returns null when there is no trace.
 *
 * TWO SNAPSHOT STAGES are stored, not one. The pre-trade figures come from review_performance
 * (early in the cycle) and the post-trade ones from record_cycle's own fresh broker fetch (last).
 * They are kept in separate fields because two different checks need different stages: the
 * deterministic report check grades the pre-trade account value the report was told to quote
 * verbatim, while the report-quality judge needs the post-trade cash, since the report describes
 * the cash left AFTER trading and grading that against the pre-trade figure produced a guaranteed
 * false finding on every cycle that traded.
 *
 * COLLECTIONS FALL INTO TWO KINDS, and getting this wrong silently corrupted the ground truth
 * once already. The original rule was "set wholesale, because each comes from one tool result".
 * That premise held for the snapshots and was FALSE for the event lists:
 *
 *  - SNAPSHOTS (the money figures, position tickers and count, external holdings) describe the
 *    account at a moment. The latest observation is the best one, so last-write-wins is correct
 *    even when review_performance runs more than once.
 *  - EVENT LISTS (orders, exits) and the QUOTE MAP ACCUMULATE across the several submit_orders,
 *    manage_positions and get_prices calls one cycle makes. They are MERGED, because an order,
 *    exit or price the report cites may have come from the first batch, and erasing it would
 *    leave the judge grading an accurate report against an incomplete record that claims to be
 *    complete.
 *
 * Re-delivery is handled by the CALLER, which skips this write entirely when
 * `appendCycleTraceTool` reports the action result was a duplicate. Merging cannot be made
 * idempotent by value here: two identical placed orders are a real duplicate send, and collapsing
 * them would hide exactly what `no-duplicate-orders` exists to catch.
 */
export const saveCycleTraceContext = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
    accountValueGbp: v.optional(v.number()),
    cashGbp: v.optional(v.number()),
    deployedGbp: v.optional(v.number()),
    postTradeAccountValueGbp: v.optional(v.number()),
    postTradeCashGbp: v.optional(v.number()),
    externalGbpValues: v.optional(v.array(v.number())),
    orders: v.optional(
      v.array(
        v.object({
          ticker: v.string(),
          side: v.string(),
          notionalGbp: v.optional(v.number()),
          status: v.string(),
          strategyTag: v.optional(v.string()),
          detail: v.optional(v.string()),
        }),
      ),
    ),
    ordersTruncated: v.optional(v.boolean()),
    exits: v.optional(
      v.array(
        v.object({
          ticker: v.string(),
          reason: v.string(),
          detail: v.optional(v.string()),
        }),
      ),
    ),
    exitsTruncated: v.optional(v.boolean()),
    positionTickers: v.optional(v.array(v.string())),
    positionCount: v.optional(v.number()),
    positionsTruncated: v.optional(v.boolean()),
    quotes: v.optional(v.record(v.string(), v.number())),
    externalAdvisoryHoldings: v.optional(
      v.array(
        v.object({
          ticker: v.string(),
          currentValueGbp: v.optional(v.number()),
          costBasisGbp: v.optional(v.number()),
          unrealisedPnlGbp: v.optional(v.number()),
        }),
      ),
    ),
    externalAdvisoryHoldingsTruncated: v.optional(v.boolean()),
    reportText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, env, sessionId, turnId, ...rest } = args;
    const existing = await findTrace(ctx, env, sessionId, turnId);
    if (!existing) return null;
    // Reject non-finite money before it is stored: a NaN account value would silently
    // disable the report check rather than failing visibly.
    const patch: Record<string, unknown> = {};
    for (const key of [
      "accountValueGbp",
      "cashGbp",
      "deployedGbp",
      "postTradeAccountValueGbp",
      "postTradeCashGbp",
      "positionCount",
    ] as const) {
      const value = rest[key];
      if (value !== undefined && Number.isFinite(value)) patch[key] = value;
    }
    if (rest.externalGbpValues !== undefined) {
      patch.externalGbpValues = rest.externalGbpValues.filter((n) => Number.isFinite(n));
    }
    // ORDERS and EXITS ACCUMULATE. A cycle calls submit_orders (and manage_positions) more than
    // once whenever the broker rejects a first attempt and the agent retries a workable variant,
    // so overwriting would drop the earlier batch while still marking the list COMPLETE. The
    // judge, reading a complete list that lacked a real order, would score an accurate report as
    // a fabrication. Truncation is STICKY for the same reason as the quote map: once something
    // has been dropped, the list stays INCOMPLETE for this cycle however many later batches fit.
    if (rest.orders !== undefined) {
      const merged = mergeEventRows(existing.orders, rest.orders);
      patch.orders = merged.rows;
      patch.ordersTruncated =
        merged.truncated || existing.ordersTruncated === true || rest.ordersTruncated === true;
    }
    if (rest.exits !== undefined) {
      const merged = mergeEventRows(existing.exits, rest.exits);
      patch.exits = merged.rows;
      patch.exitsTruncated =
        merged.truncated || existing.exitsTruncated === true || rest.exitsTruncated === true;
    }
    if (rest.positionTickers !== undefined) {
      const bounded = boundedRows(rest.positionTickers, rest.positionsTruncated);
      patch.positionTickers = bounded.rows;
      patch.positionsTruncated = bounded.truncated;
    }
    if (rest.externalAdvisoryHoldings !== undefined) {
      const bounded = boundedRows(
        rest.externalAdvisoryHoldings,
        rest.externalAdvisoryHoldingsTruncated,
      );
      patch.externalAdvisoryHoldings = bounded.rows;
      patch.externalAdvisoryHoldingsTruncated = bounded.truncated;
    }
    if (rest.quotes !== undefined) {
      const merged = mergeQuoteMap(existing.quotes, rest.quotes);
      patch.quotes = merged.quotes;
      // Sticky: once a quote has been dropped, the map stays INCOMPLETE for this cycle however
      // many later batches fit.
      patch.quotesTruncated = merged.truncated || existing.quotesTruncated === true;
    }
    if (rest.reportText !== undefined) {
      patch.reportText = rest.reportText.slice(0, MAX_REPORT_TEXT);
    }
    if (Object.keys(patch).length === 0) return existing._id;
    await ctx.db.patch("cycleTraces", existing._id, patch);
    return existing._id;
  },
});

/** Close the trace with the invariant verdict and the report-check verdict. */
export const finishCycleTrace = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
    invariants: v.array(
      v.object({
        name: v.string(),
        status: v.string(),
        detail: v.optional(v.string()),
      }),
    ),
    reportPass: v.optional(v.boolean()),
    reportFindings: v.optional(
      v.array(v.object({ rule: v.string(), detail: v.string() })),
    ),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, env, sessionId, turnId, ...rest } = args;
    const existing = await findTrace(ctx, env, sessionId, turnId);
    if (!existing) return null;
    await ctx.db.patch("cycleTraces", existing._id, {
      ...rest,
      // Derived here, never accepted from the caller, so the denormalised counter cannot
      // disagree with the array it summarises.
      violations: rest.invariants.filter((i) => i.status === "fail").length,
      completedAt: Date.now(),
    });
    return existing._id;
  },
});

/** Bounds on a stored judge verdict, mirroring agent/lib/report-judge.ts. */
const MIN_SCORE = 1;
const MAX_SCORE = 5;
const MAX_JUDGE_FINDINGS = 10;
const MAX_JUDGE_FINDING_CHARS = 400;
const MAX_JUDGE_WARNING_CHARS = 300;

/**
 * Record the LLM-as-judge verdict on one cycle's report quality.
 *
 * IDEMPOTENT on `judgedAt`. A cycle is judged AT MOST ONCE: the scheduled pass skips rows that
 * already carry `judgedAt`, and this mutation refuses to overwrite one even if the caller asks
 * twice. That keeps the weekly pass from spending a second model call on the same cycle and
 * keeps the recorded verdict stable once a human has read it.
 *
 * THE FAIL-SAFE, enforced here at the storage boundary and not only in the caller: a verdict
 * claiming `status: "judged"` must carry all five dimensions as finite numbers in range, or it
 * is rejected. An unparseable judge response belongs in the row as `status: "unjudged"` with a
 * warning, never as a passing score. Storing a bogus 5 would be worse than storing nothing,
 * because the weekly read path would then report the cycle as verified.
 */
export const saveReportScore = mutation({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
    status: v.string(), // "judged" | "unjudged"
    grounding: v.optional(v.number()),
    consistency: v.optional(v.number()),
    calibration: v.optional(v.number()),
    completeness: v.optional(v.number()),
    overall: v.optional(v.number()),
    findings: v.optional(v.array(v.string())),
    warning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { env, sessionId, turnId, status } = args;
    if (status !== "judged" && status !== "unjudged") {
      throw new Error('status must be "judged" or "unjudged"');
    }
    const existing = await findTrace(ctx, env, sessionId, turnId);
    // The outcome is returned rather than just an id, because the caller must be able to tell
    // "persisted" from "skipped" and "no such cycle": it only alerts on a verdict that was
    // actually stored, and alerting on one that was not would be a claim about nothing.
    if (!existing) return { outcome: "no-such-trace" as const };
    if (existing.judgedAt !== undefined) {
      // Already judged: never re-judge, and never re-alert. The pass that stored the original
      // verdict already raised whatever alert it deserved.
      return { outcome: "already-judged" as const, id: existing._id };
    }

    const dimensions = {
      grounding: args.grounding,
      consistency: args.consistency,
      calibration: args.calibration,
      completeness: args.completeness,
      overall: args.overall,
    };
    if (status === "judged") {
      for (const [name, value] of Object.entries(dimensions)) {
        if (
          value === undefined ||
          !Number.isFinite(value) ||
          value < MIN_SCORE ||
          value > MAX_SCORE
        ) {
          throw new Error(
            `a judged verdict needs ${name} as a finite number in ${MIN_SCORE}..${MAX_SCORE}; ` +
              "record an unusable judge response as status \"unjudged\" instead",
          );
        }
      }
    }

    const findings = (args.findings ?? [])
      .filter((entry) => entry.trim() !== "")
      .slice(0, MAX_JUDGE_FINDINGS)
      .map((entry) => entry.trim().slice(0, MAX_JUDGE_FINDING_CHARS));

    await ctx.db.patch("cycleTraces", existing._id, {
      reportScore: {
        status,
        // Scores are dropped entirely on an unjudged verdict, so no partial number can later be
        // mistaken for a grade.
        ...(status === "judged" ? dimensions : {}),
        findings,
        warning:
          args.warning === undefined
            ? undefined
            : args.warning.slice(0, MAX_JUDGE_WARNING_CHARS),
      },
      judgedAt: Date.now(),
    });
    return { outcome: "stored" as const, id: existing._id };
  },
});

export const getCycleTrace = query({
  args: {
    token: v.string(),
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return await findTrace(ctx, args.env, args.sessionId, args.turnId);
  },
});

/** Most recently finished traces first. Bounded; 50 max, so the read stays cheap as we grow. */
/**
 * Lucien's messages on their OWN budget, separate from the agent's.
 *
 * WHY THIS IS NOT JUST recallRecent. That returns the most recent messages regardless of author,
 * and the agent's own reports are long and frequent: measured on live data, its prose was 15,157
 * characters of the window against 515 of Lucien's, so his instructions scrolled out within a
 * couple of cycles. "Long context is not memory" (arXiv 2603.07670): what matters is that the
 * right thing is retrievable, not that a lot is present.
 */
export const recentUserMessages = query({
  args: { token: v.string(), env: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_env", (q) => q.eq("env", args.env))
      .order("desc")
      .take(200);
    return recent
      .filter((m) => m.role === "user")
      .slice(0, Math.min(Math.max(args.limit ?? 15, 1), 50));
  },
});

export const recentCycleTraces = query({
  args: { token: v.string(), env: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    return await ctx.db
      .query("cycleTraces")
      .withIndex("by_env_and_completedAt", (q) => q.eq("env", args.env))
      .order("desc")
      .take(limit);
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
