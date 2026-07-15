import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";

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
  status: string;
  stopLossPct?: number;
  takeProfitPct?: number;
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
  }): Promise<unknown> {
    return this.mutation("closeTrade", { ...args });
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

export function memoryFromEnv(client?: ConvexLike): Memory {
  const token = process.env.CONVEX_APP_SECRET;
  if (!token) throw new Error("CONVEX_APP_SECRET is not set");
  if (client) return new Memory(client, token);
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL is not set");
  return new Memory(new ConvexHttpClient(url) as unknown as ConvexLike, token);
}
