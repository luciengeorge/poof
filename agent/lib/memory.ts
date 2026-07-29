import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import { timeoutFetch } from "./fetch-timeout.ts";

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
  accountValueGbp?: number;
  cashGbp?: number;
  deployedGbp?: number;
  externalGbpValues?: number[];
  reportText?: string;
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
export interface StoredReportScore {
  status: string; // "judged" | "unjudged"
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
    status?: "closed" | "closed-unknown";
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
  /** `callId` is the idempotency key: a re-delivered action result must not double-append. */
  appendCycleTraceTool(
    key: CycleTraceKey,
    toolName: string,
    callId: string,
  ): Promise<unknown> {
    return this.mutation("appendCycleTraceTool", { ...key, toolName, callId });
  }
  saveCycleTraceContext(
    key: CycleTraceKey,
    context: {
      accountValueGbp?: number;
      cashGbp?: number;
      deployedGbp?: number;
      externalGbpValues?: number[];
      reportText?: string;
    },
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
   */
  saveReportScore(
    key: CycleTraceKey,
    verdict: StoredReportScore,
  ): Promise<unknown> {
    return this.mutation("saveReportScore", { ...key, ...verdict });
  }
  async getCycleTrace(key: CycleTraceKey): Promise<StoredCycleTrace | null> {
    return ((await this.query("getCycleTrace", { ...key })) ??
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
