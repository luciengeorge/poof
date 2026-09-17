import type { NewsItem } from "./data.ts";
import type { JevClient } from "./jev.ts";

/**
 * Has the news since entry undermined the reason this position was opened?
 *
 * THE GAP. The instructions say "if a position's thesis is now broken, close it early". In seven
 * weeks live that never happened once: 32 of 32 exits were the max-hold timer. Nothing re-read a
 * position's thesis against what had happened since entry, so a thesis could be dead for a week
 * and the position would still sit there until the clock ran out.
 *
 * Jev makes the re-read cheap enough to do for every open position every cycle. The answer is a
 * probability the agent SEES in review_performance, with the headline that drove it. It flags; it
 * never sells. The decision to close early stays with the agent, which has the thesis, the P&L
 * and the context this check does not.
 */

/** At or above this, the position is listed in `thesisBreakFlags` so the agent cannot miss it. */
export const THESIS_BREAK_THRESHOLD = 0.7;
/** The most recent items are what matter; older news was already known when earlier cycles ran. */
export const THESIS_BREAK_MAX_ITEMS = 12;

export interface ThesisBreakInput {
  ticker: string;
  thesis: string;
  /** Unix ms the position was opened. Only news at or after this counts. */
  openedAt: number;
  news: readonly NewsItem[];
}

export interface ThesisBreakCheck {
  /** Probability the thesis has been contradicted, 0..1. */
  risk: number;
  model: string;
  headlinesConsidered: number;
  topHeadline?: string;
}

/** News published since entry, newest first, capped. NewsItem.datetime is unix SECONDS. */
export function newsSinceEntry(news: readonly NewsItem[], openedAt: number): NewsItem[] {
  return news
    .filter((n) => n.datetime * 1000 >= openedAt && n.headline.trim().length > 0)
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, THESIS_BREAK_MAX_ITEMS);
}

export async function thesisBreakCheck(
  jev: JevClient,
  input: ThesisBreakInput,
  logger: Pick<Console, "warn"> = console,
): Promise<ThesisBreakCheck | undefined> {
  const recent = newsSinceEntry(input.news, input.openedAt);
  // No news since entry is not a break, and not worth a call: nothing has changed to judge.
  if (recent.length === 0) return { risk: 0, model: "none", headlinesConsidered: 0 };
  try {
    const res = await jev.ask(
      {
        ticker: input.ticker,
        thesis: input.thesis,
        openedAt: new Date(input.openedAt).toISOString(),
        news: recent.map((n) => ({
          headline: n.headline,
          summary: n.summary,
          source: n.source,
          publishedAt: new Date(n.datetime * 1000).toISOString(),
        })),
      },
      {
        broken: {
          type: "noul",
          instructions: "Has news since entry contradicted or invalidated this trade thesis?",
          criteria: {
            true: "A development since entry undermines the specific reason for holding.",
            false: "News is neutral, supportive, or unrelated to the thesis.",
          },
        },
      },
    );
    return {
      risk: res.answers.broken.noul,
      model: res.model,
      headlinesConsidered: recent.length,
      topHeadline: recent[0]?.headline,
    };
  } catch (err) {
    logger.warn(`[jev] thesis-break check unavailable for ${input.ticker}:`, err);
    return undefined;
  }
}

/** Tickers whose risk crosses the threshold, for the flags list. */
export function thesisBreakFlags(
  positions: readonly { ticker: string; thesisBreak?: { risk: number } }[],
): string[] {
  return positions
    .filter((p) => (p.thesisBreak?.risk ?? 0) >= THESIS_BREAK_THRESHOLD)
    .map((p) => p.ticker);
}
