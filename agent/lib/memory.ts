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

// Untyped function references (no dependency on convex/_generated). The Convex
// functions live in convex/memory.ts; these point at them by path.
const fns = anyApi.memory;
const ref = (name: string) =>
  fns[name] as unknown as FunctionReference<"mutation"> &
    FunctionReference<"query">;

export class Memory {
  private readonly client: ConvexLike;

  constructor(client: ConvexLike) {
    this.client = client;
  }

  recordTrade(t: TradeRecord): Promise<unknown> {
    return this.client.mutation(ref("recordTrade"), { ...t });
  }
  recordCycle(c: CycleRecord): Promise<unknown> {
    return this.client.mutation(ref("recordCycle"), { ...c });
  }
  saveRiskState(s: RiskStateRecord): Promise<unknown> {
    return this.client.mutation(ref("saveRiskState"), { ...s });
  }
  recordMessage(m: MessageRecord): Promise<unknown> {
    return this.client.mutation(ref("recordMessage"), { ...m });
  }
  getRiskState(env: Env): Promise<unknown> {
    return this.client.query(ref("getRiskState"), { env });
  }
  recallRecent(
    env: Env,
    limits: { cycleLimit?: number; tradeLimit?: number } = {},
  ): Promise<unknown> {
    return this.client.query(ref("recallRecent"), { env, ...limits });
  }
}

export function memoryFromEnv(client?: ConvexLike): Memory {
  if (client) return new Memory(client);
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL is not set");
  return new Memory(new ConvexHttpClient(url) as unknown as ConvexLike);
}
