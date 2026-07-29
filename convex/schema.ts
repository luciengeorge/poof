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
    // Strategy taxonomy tag set at entry (see agent/lib/positions.ts STRATEGY_TAGS).
    // Optional for backward compatibility; existing rows bucket as "other" on aggregation.
    strategyTag: v.optional(v.string()),
    status: v.string(), // "placed" | "dry-run" | "skipped" | "closed"
    // Exit levels set at entry (fractions of entry price), read by the exit engine.
    stopLossPct: v.optional(v.number()),
    takeProfitPct: v.optional(v.number()),
    trailingStopPct: v.optional(v.number()),
    maxHoldDays: v.optional(v.number()),
    // High-water mark since entry (instrument ccy), ratcheted each cycle by the exit
    // engine and used to drive the trailing stop. Absent means "use entry price".
    peakPrice: v.optional(v.number()),
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

  // ONLINE EVALS: one row per production trading-cycle TURN, written by the trace-cycle hook.
  //
  // The `cycles` table above is a DECISION log (what the agent concluded). This is a
  // BEHAVIOUR log (what the agent actually did, in order) plus the verdict of the shared
  // invariants in agent/lib/invariants.ts and of the report self-consistency check in
  // agent/lib/report-check.ts. Without it, a production incident cannot be checked against
  // the cycle discipline even retroactively.
  //
  // Keyed by (env, sessionId, turnId): a Slack follow-up is a new turn in the SAME session,
  // and must not append its tools to the cycle's trace. `toolSequence` is bounded by the hook
  // (a cycle makes a few dozen tool calls), so it stays far from the 1MB document limit.
  //
  // OBSERVER ONLY. Nothing in this table is ever read by the risk gate, sizing, or order
  // placement; it exists to be alerted on and read by a human.
  cycleTraces: defineTable({
    env: v.string(),
    sessionId: v.string(),
    turnId: v.string(),
    toolSequence: v.array(v.string()),
    // Idempotency keys for the appends above, one per deduplicable tool result. A durable turn
    // can re-deliver an `action.result` after a crash-and-resume, and a double-append could
    // false-trip `single-submit`; a false violation alert erodes trust in the whole system.
    callIds: v.array(v.string()),
    // The recording cap was hit, so tools beyond it are missing. Set loudly rather than
    // silently, because `checkInvariants` then downgrades absence-based conclusions to
    // "not-applicable": a cap must never turn an unknown into a reported violation.
    truncated: v.optional(v.boolean()),
    invariants: v.array(
      v.object({
        name: v.string(),
        status: v.string(), // "pass" | "fail" | "not-applicable"
        detail: v.optional(v.string()),
      }),
    ),
    // Denormalised count of invariants with status "fail", so "did any cycle misbehave?" is a
    // cheap read instead of a scan-and-filter over the invariants array.
    violations: v.number(),
    // Ground truth observed from the cycle's own tool results, kept so the report check can
    // run at the turn boundary even when the report arrived in an earlier durable step.
    accountValueGbp: v.optional(v.number()),
    cashGbp: v.optional(v.number()),
    deployedGbp: v.optional(v.number()),
    externalGbpValues: v.optional(v.array(v.number())),
    reportText: v.optional(v.string()), // truncated by the hook
    reportPass: v.optional(v.boolean()),
    reportFindings: v.optional(
      v.array(v.object({ rule: v.string(), detail: v.string() })),
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()), // set at the turn boundary; absent means unfinished
  })
    .index("by_env", ["env"])
    .index("by_env_and_session_and_turn", ["env", "sessionId", "turnId"])
    .index("by_env_and_completedAt", ["env", "completedAt"]),

  // ADVISORY-ONLY holdings in a SEPARATE account the agent has no API access to and can
  // NEVER trade. Deliberately its own table: these rows must never reach the trading
  // account's equity, risk snapshot, position sizing, breakers, exits, or `trades`. One such
  // holding can be many multiples of the Trading 212 account, so leaking it into
  // accountValueGbp would authorise wildly oversized orders and compute the drawdown /
  // daily-loss breakers against the wrong base. Read only by review_external_holdings.
  externalHoldings: defineTable({
    env: v.string(),
    ticker: v.string(),
    shares: v.number(),
    costBasisGbp: v.number(), // total cost in GBP, not per share
    currency: v.string(), // instrument currency, e.g. "USD"
    accountLabel: v.optional(v.string()),
    taxable: v.boolean(), // true for a UK GIA: realising a loss has CGT value
    intent: v.string(), // "exit" | "hold" | "add" | "monitor"
    targetPriceUsd: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_env", ["env"])
    .index("by_env_and_ticker", ["env", "ticker"]),
});
