import { ConvexHttpClient } from "convex/browser";
import type { Edit, MemoryRow } from "../../convex/memoryPolicy.ts";
import { anyApi, type FunctionReference } from "convex/server";
import { timeoutFetch } from "./fetch-timeout.ts";
import type { FxSource } from "./fx.ts";

/** Minimal Convex client surface the memory layer needs (injectable for tests). */
export interface ConvexLike {
  mutation(
    ref: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  query(
    ref: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export type Env = "demo" | "live";

export interface TradeRecord {
  env: Env;
  cycleId?: string;
  ticker: string;
  side: "BUY" | "SELL";
  notional: number;
  price: number;
  quantity: number;
  dryRun: boolean;
  thesis: string;
  /** Claimed probability of success at entry, 0..1. Scored by agent/lib/calibration.ts on close. */
  predictedConfidence?: number;
  redTeamVerdict?: string;
  strategyTag?: string;
  status: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxHoldDays?: number;
}

export interface BenchmarkRecord {
  env: Env;
  inceptionEquity: number;
  inceptionSpyPrice: number;
  inceptionDate: string;
}

export interface CycleRecord {
  env: Env;
  equity: number;
  freeCash: number;
  fxRate: number;
  fxSource: FxSource;
  decision: string;
  rationale: string;
  candidates?: unknown;
  watchlist?: unknown;
}

export interface RiskStateRecord {
  env: Env;
  peakEquity: number;
  dayStartEquity: number;
  dayStartDate: string;
  consecutiveLossDays: number;
  prevEquity?: number;
  haltState: string;
}

export interface MessageRecord {
  env: Env;
  sessionId?: string;
  threadTs?: string;
  role: "user" | "agent";
  slackUser?: string;
  text: string;
}

/**
 * An ADVISORY-ONLY holding in a separate account the agent cannot trade. Stored in its own
 * table and read by its own tool; never an input to account equity, sizing, or the risk gate.
 */
export interface ExternalHoldingRecord {
  env: Env;
  ticker: string;
  shares: number;
  costBasisGbp: number;
  currency: string;
  accountLabel?: string;
  taxable: boolean;
  intent: ExternalHoldingIntent;
  targetPriceUsd?: number;
  notes?: string;
}

export type ExternalHoldingIntent = "exit" | "hold" | "add" | "monitor";

/** A stored external holding as read back from Convex. */
export interface StoredExternalHolding extends ExternalHoldingRecord {
  _id: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * ONLINE EVALS. Identity of one production cycle trace: one row per cycle TURN, not per
 * session, because a Slack follow-up is a new turn in the same session and must not append
 * its tool calls to the cycle's behaviour log.
 */
export interface CycleTraceKey {
  env: Env;
  sessionId: string;
  turnId: string;
}

/** A cycle trace as read back from Convex. See convex/schema.ts for the field semantics. */
export interface StoredCycleTrace extends CycleTraceKey {
  _id: string;
  toolSequence: string[];
  callIds: string[];
  truncated?: boolean;
  invariants: { name: string; status: string; detail?: string }[];
  violations: number;
  /** PRE-TRADE, from review_performance early in the cycle. Read by the deterministic check. */
  accountValueGbp?: number;
  cashGbp?: number;
  deployedGbp?: number;
  /** POST-TRADE, from record_cycle's fresh broker fetch at the end. Read by the judge. */
  postTradeAccountValueGbp?: number;
  postTradeCashGbp?: number;
  /** The magnitude ALLOW-LIST for report-check.ts. Never handed to the judge as a checklist. */
  externalGbpValues?: number[];
  // Expanded ground truth for the judge. ABSENT and EMPTY differ: absent means nothing was
  // recorded (a claim cannot be adjudicated), empty means the cycle really did none of it.
  orders?: {
    ticker: string;
    side: string;
    notionalGbp?: number;
    status: string;
    strategyTag?: string;
    detail?: string;
  }[];
  ordersTruncated?: boolean;
  exits?: { ticker: string; reason: string; detail?: string }[];
  exitsTruncated?: boolean;
  positionTickers?: string[];
  positionCount?: number;
  positionsTruncated?: boolean;
  /** Ticker to price, in the instrument's own currency (USD for US stocks), never GBP. */
  quotes?: Record<string, number>;
  quotesTruncated?: boolean;
  externalAdvisoryHoldings?: {
    ticker: string;
    currentValueGbp?: number;
    costBasisGbp?: number;
    unrealisedPnlGbp?: number;
  }[];
  externalAdvisoryHoldingsTruncated?: boolean;
  reportText?: string;
  /** Tools whose output could not be parsed this cycle, so their ground truth is missing. */
  captureFailures?: string[];
  /** Broker-total reconciliation alerts from account-reading tools, deduplicated per cycle. */
  accountValueAlerts?: string[];
  reportPass?: boolean;
  reportFindings?: { rule: string; detail: string }[];
  /** LLM-as-judge verdict on report quality, written by the scheduled judge pass. */
  reportScore?: StoredReportScore;
  /** Set once, for a judged AND an unjudged verdict, so the judge pass is idempotent. */
  judgedAt?: number;
  startedAt: number;
  completedAt?: number;
}

/**
 * A stored judge verdict. Every dimension is optional because "unjudged" is a first-class
 * status: an unparseable judge response is recorded as an absence of a verdict, never as a
 * passing score. See agent/lib/report-judge.ts.
 */
/**
 * What `saveReportScore` did.
 *
 * `already-judged` and `no-such-trace` both mean THIS verdict was not persisted, which is why
 * they are distinguished from `stored`: the caller must not alert on a score that is not in the
 * database, and must not re-alert on one an earlier pass already handled.
 */
export interface SaveReportScoreResult {
  outcome: "stored" | "already-judged" | "no-such-trace";
  id?: string;
}

export interface StoredReportScore {
  status: string; // "judged" | "unjudged"
  /** True only when the judge could not load ground truth for the requested cycle id. */
  unjudgeable?: boolean;
  grounding?: number;
  consistency?: number;
  calibration?: number;
  completeness?: number;
  overall?: number;
  findings?: string[];
  warning?: string;
}

export interface CronRunRecord {
  schedule: string;
  firedAt: number;
  marketOpen?: boolean;
  dispatched: boolean;
}

// Untyped function references (no dependency on convex/_generated). The Convex
// functions live in convex/memory.ts; these point at them by path.
const fns = anyApi.memory;
const ref = (name: string) =>
  fns[name] as unknown as FunctionReference<"mutation"> &
    FunctionReference<"query">;

export class Memory {
  private readonly client: ConvexLike;
  private readonly token: string;

  constructor(client: ConvexLike, token: string) {
    this.client = client;
    this.token = token;
  }

  private mutation(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.mutation(ref(name), { token: this.token, ...args });
  }
  private query(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.query(ref(name), { token: this.token, ...args });
  }

  recordTrade(t: TradeRecord): Promise<unknown> {
    return this.mutation("recordTrade", { ...t });
  }
  closeTrade(args: {
    tradeId: string;
    pnl: number;
    exitPrice?: number;
    status?: "closed" | "closed-unknown" | "closed-estimated";
  }): Promise<unknown> {
    return this.mutation("closeTrade", { ...args });
  }
  updatePeak(args: { tradeId: string; price: number }): Promise<unknown> {
    return this.mutation("updatePeak", { ...args });
  }
  openBuys(env: Env): Promise<unknown> {
    return this.query("openBuys", { env });
  }
  saveBenchmark(b: BenchmarkRecord): Promise<unknown> {
    return this.mutation("saveBenchmark", { ...b });
  }
  getBenchmark(env: Env): Promise<unknown> {
    return this.query("getBenchmark", { env });
  }
  saveLessons(env: Env, text: string): Promise<unknown> {
    return this.mutation("saveLessons", { env, text });
  }
  getLessons(env: Env): Promise<unknown> {
    return this.query("getLessons", { env });
  }
  // --- durable structured memory (supersedes the free-form lessons note above) ---
  /** One round trip for all positions: see the mutation for why it is batched. */
  recordObservedPrices(entries: { tradeId: string; price: number }[]): Promise<unknown> {
    return this.mutation("recordObservedPrices", { entries });
  }
  listAgentMemory(env: Env): Promise<StoredMemoryRow[]> {
    return this.query("listAgentMemory", { env }) as Promise<StoredMemoryRow[]>;
  }
  /**
   * Apply atomic edits. Returns a decision per edit, including REFUSALS with the policy rule that
   * refused them, so the agent can be told "that duplicates broker_min_position" rather than
   * silently losing the edit. There is no full-rewrite counterpart by design.
   */
  applyMemoryEdits(
    env: Env,
    edits: readonly Edit[],
    sourceCycle?: string,
  ): Promise<MemoryEditOutcome> {
    return this.mutation("applyMemoryEdits", {
      env,
      edits,
      ...(sourceCycle !== undefined ? { sourceCycle } : {}),
    }) as Promise<MemoryEditOutcome>;
  }
  expireAgentMemory(env: Env): Promise<{ expired: string[]; active: number }> {
    return this.mutation("expireAgentMemory", { env }) as Promise<{
      expired: string[];
      active: number;
    }>;
  }
  /** Lucien's messages on their own budget, so the agent's own prose cannot crowd them out. */
  recentUserMessages(env: Env, limit?: number): Promise<{ text: string; createdAt: number }[]> {
    return this.query("recentUserMessages", {
      env,
      ...(limit !== undefined ? { limit } : {}),
    }) as Promise<{ text: string; createdAt: number }[]>;
  }
  listMemoryRetirements(env: Env, limit?: number): Promise<StoredRetirement[]> {
    return this.query("listMemoryRetirements", {
      env,
      ...(limit !== undefined ? { limit } : {}),
    }) as Promise<StoredRetirement[]>;
  }
  recordCycle(c: CycleRecord): Promise<unknown> {
    return this.mutation("recordCycle", { ...c });
  }
  saveRiskState(s: RiskStateRecord): Promise<unknown> {
    return this.mutation("saveRiskState", { ...s });
  }
  recordMessage(m: MessageRecord): Promise<unknown> {
    return this.mutation("recordMessage", { ...m });
  }
  recordCronRun(r: CronRunRecord): Promise<unknown> {
    return this.mutation("recordCronRun", { ...r });
  }
  latestCronRun(schedule: string): Promise<unknown> {
    return this.query("latestCronRun", { schedule });
  }
  recordOrderIntent(env: Env, key: string): Promise<unknown> {
    return this.mutation("recordOrderIntent", { env, key });
  }
  async hasOrderIntent(env: Env, key: string): Promise<boolean> {
    return (await this.query("hasOrderIntent", { env, key })) as boolean;
  }
  getRiskState(env: Env): Promise<unknown> {
    return this.query("getRiskState", { env });
  }
  upsertExternalHolding(h: ExternalHoldingRecord): Promise<unknown> {
    return this.mutation("upsertExternalHolding", { ...h });
  }
  removeExternalHolding(env: Env, ticker: string): Promise<unknown> {
    return this.mutation("removeExternalHolding", { env, ticker });
  }
  async listExternalHoldings(env: Env): Promise<StoredExternalHolding[]> {
    return ((await this.query("listExternalHoldings", { env })) ??
      []) as StoredExternalHolding[];
  }
  // --- online evals: cycle traces (OBSERVER ONLY, never read by the trading path) ---

  startCycleTrace(key: CycleTraceKey): Promise<unknown> {
    return this.mutation("startCycleTrace", { ...key });
  }
  /**
   * `callId` is the idempotency key: a re-delivered action result must not double-append.
   *
   * Returns the append DECISION so the caller can tell a first delivery from a re-delivery.
   * "duplicate" means this exact action result was already recorded, and the caller must NOT
   * then save its context: the accumulating collections would double-count, turning one real
   * order into an apparent duplicate send. "truncated" is still a first delivery (the tool
   * missed the sequence cap, but its orders and exits are real).
   */
  appendCycleTraceTool(
    key: CycleTraceKey,
    toolName: string,
    callId: string,
  ): Promise<"no-trace" | "duplicate" | "truncated" | "append"> {
    return this.mutation("appendCycleTraceTool", { ...key, toolName, callId }) as Promise<
      "no-trace" | "duplicate" | "truncated" | "append"
    >;
  }
  /**
   * Save whichever pieces of a cycle's ground truth the caller just observed.
   *
   * SNAPSHOTS (money figures, position tickers and count, external holdings) are SET: the latest
   * observation is the best one. EVENT LISTS (`orders`, `exits`) and `quotes` are MERGED
   * server-side, because a cycle produces them across several tool calls and an earlier batch
   * must not be erased. Call this only on a FIRST delivery (see `appendCycleTraceTool`).
   */
  saveCycleTraceContext(
    key: CycleTraceKey,
    context: Partial<
      Pick<
        StoredCycleTrace,
        | "accountValueGbp"
        | "cashGbp"
        | "deployedGbp"
        | "postTradeAccountValueGbp"
        | "postTradeCashGbp"
        | "externalGbpValues"
        | "orders"
        | "ordersTruncated"
        | "exits"
        | "exitsTruncated"
        | "positionTickers"
        | "positionCount"
        | "positionsTruncated"
        | "quotes"
        | "externalAdvisoryHoldings"
        | "externalAdvisoryHoldingsTruncated"
        | "reportText"
        | "accountValueAlerts"
      >
    > & { callId?: string; captureFailures?: string[] },
  ): Promise<unknown> {
    return this.mutation("saveCycleTraceContext", { ...key, ...context });
  }
  /** The `violations` count is derived server-side from `invariants`, so it is not sent. */
  finishCycleTrace(
    key: CycleTraceKey,
    verdict: {
      invariants: { name: string; status: string; detail?: string }[];
      reportPass?: boolean;
      reportFindings?: { rule: string; detail: string }[];
    },
  ): Promise<unknown> {
    return this.mutation("finishCycleTrace", { ...key, ...verdict });
  }
  /**
   * Record the report-quality verdict for one cycle. Server-side idempotent: a row that already
   * carries `judgedAt` is left untouched, so a cycle is judged at most once.
   *
   * The OUTCOME is returned, not just an id, so the caller can tell a stored verdict from a
   * skipped or missing one. It only alerts on a verdict that was actually persisted.
   */
  async saveReportScore(
    key: CycleTraceKey,
    verdict: StoredReportScore,
  ): Promise<SaveReportScoreResult> {
    return (await this.mutation("saveReportScore", {
      ...key,
      ...verdict,
    })) as SaveReportScoreResult;
  }
  async getCycleTrace(key: CycleTraceKey): Promise<StoredCycleTrace | null> {
    return ((await this.query("getCycleTrace", { ...key })) ??
      null) as StoredCycleTrace | null;
  }
  /**
   * Load one stored cycle trace by its immutable Convex document id.
   *
   * The report judge uses this rather than receiving a serialized truth object through model
   * text. It is still secret-gated by the same Memory client as every other trace read.
   */
  async getCycleTraceById(cycleId: string): Promise<StoredCycleTrace | null> {
    return ((await this.query("getCycleTraceById", { cycleId })) ??
      null) as StoredCycleTrace | null;
  }
  async recentCycleTraces(env: Env, limit?: number): Promise<StoredCycleTrace[]> {
    return ((await this.query("recentCycleTraces", { env, limit })) ??
      []) as StoredCycleTrace[];
  }

  recallRecent(
    env: Env,
    limits: {
      cycleLimit?: number;
      tradeLimit?: number;
      messageLimit?: number;
    } = {},
  ): Promise<unknown> {
    return this.query("recallRecent", { env, ...limits });
  }
}

/**
 * `timeoutMs` bounds every HTTP call this client makes, and is OPT-IN.
 *
 * Observers (the online-eval hook) must set it: hooks run inline in eve's event pipeline, so a
 * Convex endpoint that HANGS rather than errors would stall a trading cycle until the OS TCP
 * timeout, and the hook makes one small call per tool result.
 *
 * The trading path deliberately does NOT set it. A deadline on `getRiskState` would turn a
 * slow-but-healthy Convex into the fail-closed halt path and could block a legitimate trade,
 * which is exactly the class of change observability work must not make. Changing that is a
 * trading decision, not an observability one.
 */
export function memoryFromEnv(
  client?: ConvexLike,
  opts: { timeoutMs?: number } = {},
): Memory {
  const token = process.env.CONVEX_APP_SECRET;
  if (!token) throw new Error("CONVEX_APP_SECRET is not set");
  if (client) return new Memory(client, token);
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL is not set");
  const httpClient =
    opts.timeoutMs === undefined
      ? new ConvexHttpClient(url)
      : new ConvexHttpClient(url, { fetch: timeoutFetch(opts.timeoutMs) });
  return new Memory(httpClient as unknown as ConvexLike, token);
}

/** One stored memory row, as Convex returns it (semantic `memoryId` plus bookkeeping). */
export interface StoredMemoryRow extends Omit<MemoryRow, "id"> {
  memoryId: string;
  env: string;
  sourceCycle?: string;
}

/** One retirement, kept forever so a dropped rule can be told from a crowded-out one. */
export interface StoredRetirement {
  memoryId: string;
  class: string;
  condition: string;
  action: string;
  reason: string;
  retiredBy: string;
  retiredAt: number;
}

export interface MemoryEditOutcome {
  applied: string[];
  decisions: {
    op: string;
    id: string;
    admitted: boolean;
    rule?: string;
    detail?: string;
  }[];
}
