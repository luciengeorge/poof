import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Durable memory for the trading agent. Every row is env-tagged ("demo" | "live")
// so dry-run/demo data never mixes with live history. _id and _creationTime are
// added automatically by Convex.
export default defineSchema({
  riskState: defineTable({
    env: v.string(),
    peakEquity: v.number(),
    dayStartEquity: v.number(),
    dayStartDate: v.string(), // YYYY-MM-DD (ET)
    consecutiveLossDays: v.number(),
    prevEquity: v.optional(v.number()), // daily dayPnl reference, rolls once per ET day
    haltState: v.string(), // "none" | "daily" | "circuit"
    updatedAt: v.number(),
  }).index("by_env", ["env"]),

  cycles: defineTable({
    env: v.string(),
    equity: v.number(),
    freeCash: v.number(),
    decision: v.string(), // "trade" | "no-trade"
    rationale: v.string(),
    candidates: v.optional(v.any()),
    watchlist: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_env", ["env"]),

  trades: defineTable({
    env: v.string(),
    cycleId: v.optional(v.id("cycles")),
    ticker: v.string(),
    side: v.string(), // "BUY" | "SELL"
    notional: v.number(),
    price: v.number(),
    quantity: v.number(),
    dryRun: v.boolean(),
    thesis: v.string(),
    redTeamVerdict: v.optional(v.string()),
    status: v.string(), // "placed" | "dry-run" | "skipped" | "closed"
    // Exit levels set at entry (fractions of entry price), read by the exit engine.
    stopLossPct: v.optional(v.number()),
    takeProfitPct: v.optional(v.number()),
    maxHoldDays: v.optional(v.number()),
    fillPrice: v.optional(v.number()),
    exitPrice: v.optional(v.number()),
    pnl: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_env", ["env"])
    .index("by_env_and_ticker", ["env", "ticker"])
    .index("by_env_side_status", ["env", "side", "status"]),

  // The agent's standing lessons: a single, concise, agent-maintained note of what keeps
  // working / losing. Read at the start of every cycle, rewritten at the end. In-context
  // learning from its own track record.
  lessons: defineTable({
    env: v.string(),
    text: v.string(),
    updatedAt: v.number(),
  }).index("by_env", ["env"]),

  // Buy-and-hold SPY baseline, captured once at inception, for alpha reporting.
  benchmark: defineTable({
    env: v.string(),
    inceptionEquity: v.number(),
    inceptionSpyPrice: v.number(),
    inceptionDate: v.string(), // YYYY-MM-DD (ET)
    updatedAt: v.number(),
  }).index("by_env", ["env"]),

  messages: defineTable({
    env: v.string(),
    sessionId: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    role: v.string(), // "user" | "agent"
    slackUser: v.optional(v.string()),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_env", ["env"]),

  cronRuns: defineTable({
    schedule: v.string(), // "cycle" | "scorecard"
    firedAt: v.number(),
    marketOpen: v.optional(v.boolean()),
    dispatched: v.boolean(), // did we actually kick off the work?
  }).index("by_schedule", ["schedule"]),

  // Durable per-cycle intent marker for order placement. T212 market orders fill near-
  // instantly and vanish from "pending", so a step re-run after the fill would otherwise see
  // nothing pending and place a duplicate order. `key` encodes ET-date:ticker:side:notional.
  orderIntents: defineTable({
    env: v.string(),
    key: v.string(),
    createdAt: v.number(),
  }).index("by_env_and_key", ["env", "key"]),
});
