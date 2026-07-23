/**
 * Join live broker positions with the open BUY trades that opened them, so the exit
 * engine and performance review can recover each position's entry levels, thesis, and
 * age. Pure + unit-tested.
 */
import type { T212Position } from "./t212.ts";
import type { OpenPosition } from "./exits.ts";

/**
 * The fixed strategy taxonomy. Every BUY is tagged with exactly one of these so
 * per-type performance can be measured. Single source of truth for schema capture,
 * aggregation, instructions, and the eval. "other" is the catch-all for trades with
 * no tag or an unrecognized one.
 */
export const STRATEGY_TAGS = [
  "news-catalyst",
  "earnings-play",
  "momentum",
  "mean-reversion",
  "index-event",
  "other",
] as const;

export type StrategyTag = (typeof STRATEGY_TAGS)[number];

/** Bucket any raw tag into a known StrategyTag; unknown/missing falls back to "other". */
export function normalizeStrategyTag(tag?: string): StrategyTag {
  return (STRATEGY_TAGS as readonly string[]).includes(tag ?? "")
    ? (tag as StrategyTag)
    : "other";
}

/** The fields of an open BUY trade row (from Convex) this layer needs. */
export interface OpenBuyTrade {
  _id: string;
  ticker: string;
  createdAt: number;
  thesis: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxHoldDays?: number;
  peakPrice?: number;
}

export interface ManagedPosition extends OpenPosition {
  tradeId?: string;
  thesis?: string;
  unrealizedPnl: number; // account ccy, from the broker's ppl
}

/** Join broker positions with their originating BUY (latest open BUY per ticker). */
export function buildManagedPositions(
  positions: T212Position[],
  openBuys: OpenBuyTrade[],
  fxRate: number,
): ManagedPosition[] {
  const latestByTicker = new Map<string, OpenBuyTrade>();
  for (const b of openBuys) {
    const cur = latestByTicker.get(b.ticker);
    if (!cur || b.createdAt > cur.createdAt) latestByTicker.set(b.ticker, b);
  }
  return positions.map((p) => {
    const b = latestByTicker.get(p.ticker);
    return {
      ticker: p.ticker,
      entryPrice: p.averagePrice,
      currentPrice: p.currentPrice,
      marketValue: p.quantity * p.currentPrice * fxRate,
      openedAt: b?.createdAt ?? 0,
      peakPrice: b?.peakPrice,
      stopLossPct: b?.stopLossPct,
      takeProfitPct: b?.takeProfitPct,
      trailingStopPct: b?.trailingStopPct,
      maxHoldDays: b?.maxHoldDays,
      tradeId: b?._id,
      thesis: b?.thesis,
      unrealizedPnl: p.ppl,
    };
  });
}

export interface RealizedStats {
  closedCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  closedUnknown: number;
}

export function realizedStats(
  closedTrades: { pnl?: number; status?: string }[],
): RealizedStats {
  const closed = closedTrades.filter(
    (t) => t.status === "closed" && typeof t.pnl === "number",
  );
  const wins = closed.filter((t) => (t.pnl as number) > 0).length;
  const losses = closed.filter((t) => (t.pnl as number) < 0).length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl as number), 0);
  const closedUnknown = closedTrades.filter(
    (t) => t.status === "closed-unknown",
  ).length;
  return {
    closedCount: closed.length,
    wins,
    losses,
    winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
    totalPnl,
    closedUnknown,
  };
}

/**
 * Realized stats bucketed by strategy tag. Trades with no tag or an unknown one bucket
 * under "other". Only tags that actually have closed trades appear in the result, so a
 * consumer sees exactly which strategies have a track record. Mirrors realizedStats.
 */
export function realizedStatsByTag(
  closedTrades: { pnl?: number; status?: string; strategyTag?: string }[],
): Record<string, RealizedStats> {
  const byTag = new Map<StrategyTag, typeof closedTrades>();
  for (const t of closedTrades) {
    const tag = normalizeStrategyTag(t.strategyTag);
    const bucket = byTag.get(tag);
    if (bucket) bucket.push(t);
    else byTag.set(tag, [t]);
  }
  const out: Record<string, RealizedStats> = {};
  for (const [tag, trades] of byTag) out[tag] = realizedStats(trades);
  return out;
}

/** Open BUY trades whose ticker is no longer held -> the position was closed elsewhere. */
export function orphanedOpenBuys(
  openBuys: OpenBuyTrade[],
  positions: T212Position[],
): OpenBuyTrade[] {
  const held = new Set(positions.map((p) => p.ticker));
  return openBuys.filter((b) => !held.has(b.ticker));
}
