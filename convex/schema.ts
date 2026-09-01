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
    // OPTIONAL because `cycles` already holds rows written before these fields existed, and
    // Convex validates the schema against EVERY existing document at deploy time. Adding them as
    // required failed the production deploy outright:
    //   "Document ... in table cycles does not match the schema: missing the required field fxRate".
    // Note this is NOT caught by `tsc -p convex/tsconfig.json`, which is a type-level check with no
    // knowledge of stored data. Any new field on a populated table must start optional.
    fxRate: v.optional(v.number()),
    fxSource: v.optional(
      v.union(v.literal("env"), v.literal("live"), v.literal("fallback")),
    ),
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
    // What the agent CLAIMED at entry, 0..1, scored against the realised outcome once closed.
    // "The Alpha Illusion" (arXiv 2605.16895) protocol P4: language confidence is routinely
    // miscalibrated as trading probability, and the only way to know is to score forecasts.
    predictedConfidence: v.optional(v.number()),
    // The last price actually OBSERVED while this position was still visible at the broker, and
    // when. Written every cycle so a position that later vanishes (a manual sale, or a pending sell
    // that finally filled) can be reconciled against something real. Distinct from `peakPrice`,
    // which is a high-water MARK and overstates a position that fell before it disappeared.
    lastPrice: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
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

  // DURABLE MEMORY, structured. Replaces the free-form `lessons` note below, which the agent
  // rewrote IN FULL every cycle. SHARP (arXiv 2605.06822) ablates exactly that: bounded atomic
  // edits scored +33.2% return where free-form full rewrites scored -12.1%, because a rewrite
  // makes credit assignment impossible. There is no "replace everything" mutation here by design.
  //
  // Three classes with SEPARATE budgets (see convex/memoryPolicy.ts). One shared budget is what
  // let a passing remark about oil prices compete with a hard account constraint and win:
  //   directive   - Lucien's standing instruction or a hard constraint. Never auto-evicted.
  //   lesson      - a mechanic the agent derived from outcomes. Confidence decays unconfirmed.
  //   observation - current regime or portfolio state. Expires by default.
  //
  // `memoryId` is a stable SEMANTIC id ("broker_min_position"), distinct from Convex's `_id`, so
  // an edit can name what it is changing and an audit trail can follow one rule across revisions.
  agentMemory: defineTable({
    env: v.string(),
    memoryId: v.string(),
    class: v.string(),
    category: v.string(),
    condition: v.string(),
    action: v.string(),
    provenance: v.string(),
    confidence: v.number(),
    createdAt: v.number(),
    lastConfirmedAt: v.number(),
    /** When the wording last changed. Drives the churn cooldown in memoryPolicy.ts. */
    lastModifiedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    /** Which cycle proposed it, for attribution back to the outcome that motivated it. */
    sourceCycle: v.optional(v.string()),
  })
    .index("by_env", ["env"])
    .index("by_env_and_class", ["env", "class"])
    .index("by_env_and_memoryId", ["env", "memoryId"]),

  // Every retirement, kept forever. SHARP logs each removal with its motivation; without this a
  // lesson simply vanished at the cap and nobody could tell whether it was wrong or just crowded
  // out. This is the audit trail for what the agent stopped believing, and why.
  memoryRetirements: defineTable({
    env: v.string(),
    memoryId: v.string(),
    class: v.string(),
    condition: v.string(),
    action: v.string(),
    reason: v.string(),
    /** "agent" (proposed), "policy" (cap or conflict), "expiry" (lapsed), "user" (Lucien). */
    retiredBy: v.string(),
    retiredAt: v.number(),
  })
    .index("by_env", ["env"])
    .index("by_env_and_memoryId", ["env", "memoryId"]),

  // SUPERSEDED by agentMemory above, kept for read-back during the transition. The agent's
  // standing lessons: a single, concise, agent-maintained note of what keeps
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
    // Action-result callIds whose CONTEXT has already been merged. Distinct from `callIds`, which
    // tracks the tool SEQUENCE. Needed because a re-delivered result must not double-count into an
    // accumulating collection, while a later delivery of the SAME call carrying fuller output must
    // still be captured. Skipping the whole save on a duplicate append lost real orders.
    contextCallIds: v.optional(v.array(v.string())),
    // Tools whose output could not be parsed, so their ground truth is missing for a KNOWN reason.
    // A thrown trading tool used to be invisible here: its absence looked identical to "the tool
    // ran and did nothing", which is how a Finnhub failure was reported as "red_team never ran".
    captureFailures: v.optional(v.array(v.string())),
    // Reconciliation warnings from account-reading tools. Observer only: one completed-cycle
    // alert tells a human when the FX-valued portfolio disagrees with the broker total or when
    // that authoritative total is unusable.
    accountValueAlerts: v.optional(v.array(v.string())),
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
    //
    // PRE-TRADE, from review_performance, which runs EARLY in the cycle. `accountValueGbp` is the
    // figure the DETERMINISTIC check in agent/lib/report-check.ts grades against, because the
    // report is instructed to quote that value verbatim and is written before record_cycle runs.
    accountValueGbp: v.optional(v.number()),
    cashGbp: v.optional(v.number()),
    deployedGbp: v.optional(v.number()),
    // POST-TRADE, from record_cycle's own fresh broker fetch at the END of the cycle. Kept
    // SEPARATE rather than overwriting the two fields above: the report-quality JUDGE needs the
    // post-trade cash (the report describes what is left after trading, so grading it against the
    // pre-trade figure produced a guaranteed false "cash is misstated" finding on every cycle that
    // traded), while the deterministic check must keep grading the pre-trade account value it has
    // always graded. Both stages are therefore available and each consumer reads the one it means.
    postTradeAccountValueGbp: v.optional(v.number()),
    postTradeCashGbp: v.optional(v.number()),
    // ALLOW-LIST of GBP magnitudes for the deterministic magnitude rule, NOT a content checklist.
    // The judge gets `externalAdvisoryHoldings` below instead: given this bare array it read the
    // allowance as a list of figures the report owed the reader.
    externalGbpValues: v.optional(v.array(v.number())),
    // EXPANDED GROUND TRUTH for the judge, all of it read from tool results the cycle already
    // produced (no extra broker or FX calls). Without it the judge could adjudicate six numbers
    // and nothing else, so every correctly sourced order, exit, holding or price in a report was
    // unverifiable from its seat and scored as invented.
    //
    // ABSENT and EMPTY mean different things, deliberately, exactly like "not-applicable" in the
    // invariants: absent means nothing was recorded, so a claim cannot be adjudicated; empty means
    // the cycle really did none, so a claim contradicts the record. Every collection is BOUNDED,
    // and its `*Truncated` flag is set loudly when the cap bit, so an incomplete list is never
    // read as proof that a real event never happened.
    orders: v.optional(
      v.array(
        v.object({
          ticker: v.string(),
          side: v.string(),
          notionalGbp: v.optional(v.number()),
          status: v.string(), // "placed" | "simulated" | "skipped" | "rejected"
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
    // The EXACT number held, even when the ticker list above was truncated, so a report stating
    // "10 stocks" stays checkable.
    positionCount: v.optional(v.number()),
    positionsTruncated: v.optional(v.boolean()),
    // Ticker to price, in the instrument's own currency (USD for US stocks), NEVER GBP. Merged
    // across the cycle's several get_prices calls (convex/traceAppend.ts) so an early quote the
    // report cites is not erased by a later batch.
    quotes: v.optional(v.record(v.string(), v.number())),
    quotesTruncated: v.optional(v.boolean()),
    // ADVISORY-ONLY external holdings with LABELLED GBP fields, for the judge. Reference context
    // only: a report that does not restate a cost basis or an unrealised P&L is not defective.
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
    reportText: v.optional(v.string()), // truncated by the hook
    reportPass: v.optional(v.boolean()),
    reportFindings: v.optional(
      v.array(v.object({ rule: v.string(), detail: v.string() })),
    ),
    // LLM-as-judge verdict on report QUALITY, written by a SCHEDULED pass long after the turn
    // ended (see agent/lib/report-judge.ts for why it is never inline in the hook). Lives on
    // this row rather than in its own table: there is exactly one verdict per cycle, it is
    // written once, and the weekly read path in agent/lib/eval-health.ts always needs it in the
    // same pass as the invariants, so a separate table would only add a second query and a join.
    //
    // "unjudged" is a FIRST-CLASS status. A judge response that could not be parsed must be
    // recorded as an absence of a verdict, never as a passing score, or the whole judging layer
    // silently becomes decoration. Every dimension is therefore optional and only populated
    // when status is "judged".
    reportScore: v.optional(
      v.object({
        status: v.string(), // "judged" | "unjudged"
        // Optional because populated rows were written before this availability marker existed.
        unjudgeable: v.optional(v.boolean()),
        grounding: v.optional(v.number()),
        consistency: v.optional(v.number()),
        calibration: v.optional(v.number()),
        completeness: v.optional(v.number()),
        overall: v.optional(v.number()),
        findings: v.optional(v.array(v.string())),
        warning: v.optional(v.string()), // set when status is "unjudged"
      }),
    ),
    // Set once, for both statuses, so the scheduled pass is idempotent: a cycle is judged at
    // most once and a re-run skips it instead of spending another model call on it.
    judgedAt: v.optional(v.number()),
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
