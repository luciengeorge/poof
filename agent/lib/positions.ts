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
  /** Entry share price in the instrument's own currency, and shares held. */
  price?: number;
  quantity?: number;
  /**
   * The last price actually OBSERVED while the position was still visible at the broker, and when.
   * Recorded every cycle so a position that later vanishes can be reconciled against something
   * real rather than discarded as unknown. Distinct from `peakPrice`, which is a high-water MARK
   * and therefore overstates a position that fell before it disappeared.
   */
  lastPrice?: number;
  lastSeenAt?: number;
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
  /** Reconciled from an observed price rather than an executed exit. Never silently dropped. */
  closedEstimated: number;
}

/**
 * Does this trade have an outcome, and how solid is it? ONE definition, shared by every consumer.
 *
 * WHY THIS EXISTS. Three modules each decided this differently and therefore disagreed in public:
 * `realizedStats` required `status === "closed"` exactly, so a `closed-estimated` trade silently
 * vanished from every count; `attributeFailures` asked only whether `pnl` was a number, which is
 * TRUE for a `closed-unknown` row because reconciliation writes `pnl: 0` as a PLACEHOLDER; and
 * `calibrationFrom` excluded estimated but not unknown. The weekly scorecard then reported figures
 * that did not add up, and the agent said so itself.
 *
 * The trap is that **a placeholder zero is indistinguishable from a real zero**, so the outcome
 * must be decided by STATUS and never by whether a number happens to be present.
 */
export type OutcomeKind =
  /** Exited by us, at a price we executed and recorded. */
  | "real"
  /** Reconciled from the last price actually OBSERVED before the position left the broker. */
  | "estimated"
  /** Closed with no outcome at all. Its `pnl: 0` is a placeholder, NOT a result. */
  | "unknown"
  /** Not closed. */
  | "open";

export function outcomeKind(t: { status?: string; pnl?: number }): OutcomeKind {
  if (t.status === "closed-unknown") return "unknown";
  const hasPnl = typeof t.pnl === "number" && Number.isFinite(t.pnl);
  if (t.status === "closed" && hasPnl) return "real";
  if (t.status === "closed-estimated" && hasPnl) return "estimated";
  return "open";
}

export function realizedStats(
  closedTrades: { pnl?: number; status?: string }[],
): RealizedStats {
  // "Actually banked" stays strictly to exits WE executed and priced. Estimated outcomes are real
  // observations but were not banked by us, so they are reported separately rather than folded in
  // or, as before, dropped from every count without trace.
  const closed = closedTrades.filter((t) => outcomeKind(t) === "real");
  const wins = closed.filter((t) => (t.pnl as number) > 0).length;
  const losses = closed.filter((t) => (t.pnl as number) < 0).length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl as number), 0);
  const closedUnknown = closedTrades.filter((t) => outcomeKind(t) === "unknown").length;
  const closedEstimated = closedTrades.filter((t) => outcomeKind(t) === "estimated").length;
  return {
    closedCount: closed.length,
    wins,
    losses,
    winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
    totalPnl,
    closedUnknown,
    closedEstimated,
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
