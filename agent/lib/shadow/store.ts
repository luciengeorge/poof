import type { TimedQuote } from "./policy.ts";
import type { ResearchSession } from "../../../convex/shadowCalendar.ts";
import type { JevScreen } from "../jev-shadow.ts";

export type ShadowKind = "positions" | "news" | "score";
export type Env = "demo" | "live";
export interface Lease { env: Env; runId: string; owner: string }
export interface DayCohort { day: string; symbols: string[]; baseline: number | null; baselineCount: number; baselineCutoff: number }
export interface ShadowInputs {
  day: DayCohort; held: { ticker: string; generation: string; thesis: string; openedAt: number; observedAt: number | null }[];
  cursors: { ticker: string; through: number }[];
  positionStateAvailable: boolean; reason: string;
}
export interface NewsEvidence {
  story: string; url: string; headline: string; summary: string; source: string;
  publishedAt: number; firstSeenAt: number; eligible: boolean; reason?: string;
}
export interface StartingPair { stock: TimedQuote; proxy: TimedQuote; sessionOpen: number; sessionClose: number; sessionDay: string }
export interface ForecastRow {
  _id: string; ticker: string; day: string; story: string; headline: string; summary: string; source: string;
  publishedAt: number; firstSeenAt: number; inputCutoff: number; baseline: number | null;
  probability?: number; committedAt?: number; targetClose: number; start?: StartingPair;
  outcome?: ScoredOutcome; state: string; reason?: string;
}
export interface ScoredOutcome { up: boolean; relativeReturn: number; brier: number; constantBrier: number;
  baseRateBrier: number | null; scoredAt: number; source: string }
export interface RunRecord { kind: string; status: string; reason?: string; slot: number; requests?: number; quotes?: TimedQuote[]; startedAt: number }
export interface ShadowStore {
  claim(env: Env, kind: ShadowKind, owner: string): Promise<{ reason: string } | { runId: string; day: string; slot: number; startedAt: number }>;
  permit(lease: Lease, provider: "finnhub" | "tiingo" | "jev"): Promise<boolean>;
  inputs(lease: Lease): Promise<ShadowInputs>;
  finish(lease: Lease, status: "completed" | "failed" | "skipped", reason: string, quotes?: TimedQuote[]): Promise<unknown>;
  ingest(lease: Lease, ticker: string, through: number, truncated: boolean, items: NewsEvidence[]): Promise<string[]>;
  attempt(lease: Lease, eventId: string, attemptId: string): Promise<ForecastRow | null>;
  prediction(lease: Lease, eventId: string, attemptId: string, data: {
    probability: number | null; model: string; completedAt: number; screen?: JevScreen; reason?: string;
  }): Promise<{ committedAt: number; session: ResearchSession } | null>;
  attachStart(lease: Lease, eventId: string, start: StartingPair | null): Promise<boolean>;
  due(env: Env, now: number): Promise<ForecastRow[]>;
  score(lease: Lease, eventId: string, outcome: ScoredOutcome): Promise<boolean>;
  report(env: Env, day: string): Promise<{ events: ForecastRow[]; runs: RunRecord[]; truncated: boolean }>;
}

/** Only these shadow names can cross the memory boundary; no generic live mutation is exposed. */
export function createShadowStore(
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): ShadowStore {
  return {
    claim: (env, kind, owner) => mutate("claim", { env, kind, owner }) as ReturnType<ShadowStore["claim"]>,
    permit: (lease, provider) => mutate("permit", { ...lease, provider }) as Promise<boolean>,
    inputs: (lease) => mutate("inputs", { ...lease }) as Promise<ShadowInputs>,
    finish: (lease, status, reason, quotes = []) => mutate("finish", { ...lease, status, reason, quotes, observations: [] }),
    ingest: (lease, ticker, through, truncated, items) => mutate("ingest", { ...lease, ticker, through, truncated, items }) as Promise<string[]>,
    attempt: (lease, eventId, attemptId) => mutate("attempt", { ...lease, eventId, attemptId }) as ReturnType<ShadowStore["attempt"]>,
    prediction: (lease, eventId, attemptId, data) => mutate("prediction", { ...lease, eventId, attemptId, ...data }) as ReturnType<ShadowStore["prediction"]>,
    attachStart: (lease, eventId, start) => mutate("attachStart", { ...lease, eventId, start }) as Promise<boolean>,
    due: (env, now) => query("due", { env, now }) as Promise<ForecastRow[]>,
    score: (lease, eventId, outcome) => mutate("score", { ...lease, eventId, outcome }) as Promise<boolean>,
    report: (env, day) => query("report", { env, day }) as ReturnType<ShadowStore["report"]>,
  };
}
