import type { NewsItem } from "./data.ts";
import type { JevClient } from "./jev.ts";
import type { Proposal } from "./orders.ts";
import { STRATEGY_TAGS } from "./positions.ts";

/**
 * The two places Jev touches poof, and the rule that keeps both honest.
 *
 * 1. SHADOW CONFIDENCE. For every BUY that is actually placed, Jev is asked one question: will
 *    this trade close at a profit? Its answer is RECORDED beside the agent's own claimed
 *    confidence and scored against the realised outcome by calibration.ts, exactly as the agent's
 *    claim is. It influences nothing. In a few weeks the Brier scores say which of the two
 *    forecasters, if either, deserves a say. Until then a number that has not been scored is a
 *    guess with a decimal point.
 *
 * 2. NEWS SCREENING. Every headline the agent reads gets three cheap, calibrated annotations:
 *    is this a fresh, stock-specific catalyst; is it already priced in; which strategy bucket.
 *    These are a ranking aid the agent may weigh, not a filter. A filter with no calibration
 *    record would throw away candidates on an untested opinion.
 *
 * Both are best-effort. A Jev failure, timeout, or missing key leaves the field absent and the
 * cycle proceeds as if Jev did not exist.
 */

const SHADOW_INSTRUCTIONS =
  "Will this proposed stock trade close at a profit before its exit rules sell it?";

/** What the shadow forecaster is shown: the same evidence the agent had at entry, nothing later. */
export function shadowState(p: Proposal): Record<string, unknown> {
  return {
    ticker: p.ticker,
    side: p.side,
    thesis: p.thesis,
    strategyTag: p.strategyTag ?? null,
    redTeamVerdict: p.redTeamVerdict ?? null,
    exitRules: {
      stopLossPct: p.stopLossPct ?? null,
      trailingStopPct: p.trailingStopPct ?? null,
      takeProfitPct: p.takeProfitPct ?? null,
      maxHoldDays: p.maxHoldDays ?? null,
    },
  };
}

export interface ShadowConfidence {
  jevConfidence: number;
  jevModel: string;
}

export async function shadowConfidence(
  jev: JevClient,
  proposal: Proposal,
  logger: Pick<Console, "warn"> = console,
): Promise<ShadowConfidence | undefined> {
  try {
    const res = await jev.ask(shadowState(proposal), {
      profitable: {
        type: "noul",
        instructions: SHADOW_INSTRUCTIONS,
        criteria: {
          true: "The position is sold above its entry price, by the trailing stop, take-profit, or time exit.",
          false: "The position is sold at or below its entry price, by the stop-loss or time exit.",
        },
      },
    });
    return { jevConfidence: res.answers.profitable.noul, jevModel: res.model };
  } catch (err) {
    logger.warn(`[jev] shadow confidence unavailable for ${proposal.ticker}:`, err);
    return undefined;
  }
}

export interface JevScreen {
  /** Probability this is a fresh, stock-specific catalyst rather than commentary or old news. */
  freshCatalyst: number;
  /** Probability the market has already repriced for it. */
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  model: string;
}

export type ScreenedNewsItem = NewsItem & { jevScreen?: JevScreen };

/** The fixed taxonomy from positions.ts, so Jev's bucket and the agent's tag are the same words. */
function strategyCriteria(): Record<string, string> {
  const described: Record<string, string> = {
    "news-catalyst": "A specific, fresh, company-level event: contract, approval, guidance, product, legal outcome.",
    "earnings-play": "Positioning around a scheduled earnings report.",
    momentum: "A trend or breakout continuing, without a new discrete event.",
    "mean-reversion": "An overdone move expected to snap back.",
    "index-event": "Index inclusion, rebalancing, or a passive-flow event.",
    other: "None of the above, or not actionable.",
  };
  const criteria: Record<string, string> = {};
  for (const tag of STRATEGY_TAGS) criteria[tag] = described[tag] ?? tag;
  return criteria;
}

async function screenOne(jev: JevClient, item: NewsItem): Promise<JevScreen | undefined> {
  const res = await jev.ask(
    {
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      tickers: item.related,
    },
    {
      freshCatalyst: {
        type: "noul",
        instructions:
          "Is this a fresh, specific, company-level catalyst that could move the named stock, rather than general commentary, a recap, or macro news?",
      },
      pricedIn: {
        type: "noul",
        instructions:
          "Has the market most likely already repriced for this information (widely reported, hours old, or a reaction already described)?",
      },
      strategyTag: {
        type: "choice",
        instructions: "Which trading strategy bucket does this news best fit?",
        criteria: strategyCriteria(),
      },
    },
  );
  return {
    freshCatalyst: res.answers.freshCatalyst.noul,
    pricedIn: res.answers.pricedIn.noul,
    strategyTag: res.answers.strategyTag.choice,
    strategyTagConfidence: res.answers.strategyTag.confidence,
    model: res.model,
  };
}

/** Bounded so a long news day cannot turn into hundreds of calls; the tail is returned unscreened. */
export const JEV_SCREEN_MAX_ITEMS = 40;

export async function screenNews(
  jev: JevClient,
  items: readonly NewsItem[],
  logger: Pick<Console, "warn"> = console,
): Promise<ScreenedNewsItem[]> {
  const head = items.slice(0, JEV_SCREEN_MAX_ITEMS);
  const tail = items.slice(JEV_SCREEN_MAX_ITEMS);
  const screened = await Promise.all(
    head.map(async (item): Promise<ScreenedNewsItem> => {
      try {
        const jevScreen = await screenOne(jev, item);
        return jevScreen ? { ...item, jevScreen } : item;
      } catch (err) {
        logger.warn(`[jev] screen unavailable for "${item.headline.slice(0, 60)}":`, err);
        return item;
      }
    }),
  );
  return [...screened, ...tail];
}
