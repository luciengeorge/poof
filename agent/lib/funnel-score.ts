import { STRATEGY_TAGS } from "./positions.ts";

/**
 * Ranking screened news into a shortlist, deterministically.
 *
 * Jev answers three calibrated questions about every headline in the universe: is it a fresh,
 * stock-specific catalyst; has the market already repriced for it; which strategy bucket does it
 * fit. This module turns those numbers into one score the agent can sort by. The formula is
 * fixed and visible here, so a change to the ranking is a code change with a test, never a
 * drift in phrasing.
 *
 * The score is a RANKING aid. It decides what the agent reads first, not what it trades: a
 * shortlist with no calibration record yet would throw away candidates on an untested opinion if
 * it were a filter. The record accrues via the directional shadow question recorded beside
 * every item (see funnel.ts), and the threshold for turning ranking into filtering is a decision
 * for when that record exists.
 */

/**
 * How much each strategy bucket is worth to this strategy. news-catalyst is what the agent
 * actually trades well (47 of 65 orders). earnings-play is discounted for binary gap risk.
 * `other` is zero: a headline Jev cannot place in any bucket is commentary.
 */
export const FUNNEL_TAG_WEIGHT: Record<(typeof STRATEGY_TAGS)[number], number> = {
  "news-catalyst": 1.0,
  "earnings-play": 0.8,
  momentum: 0.6,
  "mean-reversion": 0.6,
  "index-event": 0.7,
  other: 0,
};

/** Half the score is gone after this many hours. Yesterday's catalyst is mostly priced by now. */
export const FUNNEL_RECENCY_HALF_LIFE_HOURS = 18;

export interface FunnelSignals {
  freshCatalyst: number;
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  /** Unix ms the item was published. */
  publishedAt: number;
}

export function recencyFactor(publishedAt: number, now: number): number {
  const ageHours = Math.max(0, (now - publishedAt) / 3_600_000);
  return Math.pow(0.5, ageHours / FUNNEL_RECENCY_HALF_LIFE_HOURS);
}

function tagWeight(tag: string): number {
  return (FUNNEL_TAG_WEIGHT as Record<string, number | undefined>)[tag] ?? 0;
}

/**
 * fresh x (1 - pricedIn) x tag weight x tag confidence x recency, in [0, 1].
 *
 * Multiplicative on purpose: a headline that fails any one test (stale, priced, uncategorisable)
 * should score near zero however strong the others are, which an average would hide.
 */
export function funnelScore(s: FunnelSignals, now: number): number {
  const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  const score =
    clamp(s.freshCatalyst) *
    (1 - clamp(s.pricedIn)) *
    tagWeight(s.strategyTag) *
    clamp(s.strategyTagConfidence) *
    recencyFactor(s.publishedAt, now);
  return Math.round(score * 10_000) / 10_000;
}

export interface RankedFunnelItem<T extends FunnelSignals> {
  item: T;
  score: number;
}

/** Highest score first; a stable tiebreak on freshness so equal scores do not reshuffle daily. */
export function rankFunnel<T extends FunnelSignals>(items: readonly T[], now: number): RankedFunnelItem<T>[] {
  return items
    .map((item) => ({ item, score: funnelScore(item, now) }))
    .sort((a, b) => b.score - a.score || b.item.publishedAt - a.item.publishedAt);
}
