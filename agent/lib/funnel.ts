import type { Candle, NewsItem } from "./data.ts";
import { funnelScore } from "./funnel-score.ts";
import { sleep } from "./http-backoff.ts";
import type { JevClient } from "./jev.ts";
import type { FunnelItemRecord, StoredFunnelItem } from "./memory.ts";
import { STRATEGY_TAGS } from "./positions.ts";

/**
 * The wide funnel: read the whole universe's news before the cycle, let Jev screen every item,
 * rank in code, and leave a shortlist for the agent to read.
 *
 * WHY. The agent's candidate funnel was whatever fitted in one model's attention: general market
 * news plus a few company lookups, roughly thirty to fifty headlines a cycle. Jev screens eight
 * headlines in about 700 ms for a fraction of a cent, so the constraint that shaped the funnel is
 * gone. Reading five hundred names a day costs about half a cent. The picks already show positive
 * expectancy (+0.8% per closed trade); more and better-sorted candidates is the lever that
 * compounds it.
 *
 * SHAPE. Vercel Hobby caps a function at 300 s and Finnhub's free tier at 60 calls a minute, so
 * the universe is split into FUNNEL_CHUNKS slices and four schedules each take one. Each fire
 * claims the lowest unclaimed chunk for the day (see convex claimFunnelChunk), so Hobby's hour of
 * jitter cannot make two fires do the same work or leave a slice undone.
 *
 * THE FOURTH QUESTION. Beside the three screening questions, every item is asked the question the
 * crowd on X is excited about: will this stock be higher in ten trading days? The answer is
 * recorded and, ten trading days later, scored against the real price. It influences nothing.
 * If the crowd is right the Brier score will say so for pennies; if not, the same.
 */

export const FUNNEL_CHUNKS = 4;
/** Finnhub free tier is 60/min; one call a second with headroom for the occasional retry. */
export const FUNNEL_FINNHUB_INTERVAL_MS = 1_050;
/** Company news is fetched over this window, then trimmed to items that are actually recent. */
export const FUNNEL_NEWS_MAX_AGE_HOURS = 36;
export const FUNNEL_ITEMS_PER_TICKER = 5;
/** How many items one fire may screen, so a busy news day cannot outrun the 300 s budget. */
export const FUNNEL_MAX_ITEMS_PER_CHUNK = 220;
/** Jev calls in flight at once. Well under its 1,200 rpm; bounded so file descriptors stay sane. */
export const FUNNEL_JEV_CONCURRENCY = 8;
/** The directional shadow's horizon, matching the position hold window. */
export const FUNNEL_OUTCOME_TRADING_DAYS = 10;
export const FUNNEL_OUTCOMES_PER_RUN = 40;

export interface FunnelNewsSource {
  getCompanyNews(symbol: string, fromISO: string, toISO: string): Promise<NewsItem[]>;
  getCandles(symbol: string, fromISO: string, toISO: string): Promise<Candle[]>;
}

export interface FunnelMemory {
  upsertFunnelItems(items: FunnelItemRecord[]): Promise<{ inserted: number; skipped: number }>;
  funnelItemsAwaitingOutcome(screenedBefore: number, limit: number): Promise<StoredFunnelItem[]>;
  recordFunnelOutcome(input: { id: string; outcomeAt: number; outcomeUp: boolean; outcomePct: number }): Promise<unknown>;
}

export interface FunnelScreen {
  freshCatalyst: number;
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  higherIn10d: number;
  model: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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

/** One Jev call per item: the three screening questions plus the directional shadow. */
export async function screenFunnelItem(jev: JevClient, ticker: string, item: NewsItem): Promise<FunnelScreen> {
  const res = await jev.ask(
    {
      ticker,
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
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
      higherIn10d: {
        type: "noul",
        instructions: `Will ${ticker} close higher in ${FUNNEL_OUTCOME_TRADING_DAYS} trading days than it closes today?`,
      },
    },
  );
  return {
    freshCatalyst: res.answers.freshCatalyst.noul,
    pricedIn: res.answers.pricedIn.noul,
    strategyTag: res.answers.strategyTag.choice,
    strategyTagConfidence: res.answers.strategyTag.confidence,
    higherIn10d: res.answers.higherIn10d.noul,
    model: res.model,
  };
}

/** Keep the recent, deduplicated, most useful few items for one ticker. */
export function selectTickerNews(items: readonly NewsItem[], now: number): NewsItem[] {
  const cutoff = now - FUNNEL_NEWS_MAX_AGE_HOURS * 3_600_000;
  const seen = new Set<string>();
  return items
    .filter((n) => n.datetime * 1000 >= cutoff && n.headline.trim().length > 0 && n.url.length > 0)
    .filter((n) => (seen.has(n.url) ? false : (seen.add(n.url), true)))
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, FUNNEL_ITEMS_PER_TICKER);
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface FunnelChunkResult {
  tickers: number;
  fetched: number;
  screened: number;
  inserted: number;
  skipped: number;
  failures: number;
}

/**
 * Fetch, screen, score and store one chunk of the universe.
 *
 * Finnhub calls are sequential and paced (one source of rate-limit pressure); Jev calls run with
 * bounded concurrency as the news arrives. Any single ticker failing is counted and skipped, so
 * one bad symbol never costs the rest of the slice.
 */
export async function runFunnelChunk(
  tickers: readonly string[],
  deps: {
    news: FunnelNewsSource;
    jev: JevClient;
    memory: FunnelMemory;
    now?: () => number;
    sleepImpl?: (ms: number) => Promise<void>;
    logger?: Pick<Console, "warn">;
  },
): Promise<FunnelChunkResult> {
  const now = deps.now ?? Date.now;
  const pause = deps.sleepImpl ?? sleep;
  const logger = deps.logger ?? console;
  const startedAt = now();
  const day = utcDay(startedAt);
  const fromISO = utcDay(startedAt - 2 * 86_400_000);
  const toISO = day;

  const candidates: { ticker: string; item: NewsItem }[] = [];
  let failures = 0;
  for (const ticker of tickers) {
    try {
      const raw = await deps.news.getCompanyNews(ticker, fromISO, toISO);
      for (const item of selectTickerNews(raw, startedAt)) candidates.push({ ticker, item });
    } catch (err) {
      failures += 1;
      logger.warn(`[funnel] news failed for ${ticker}:`, err);
    }
    if (candidates.length >= FUNNEL_MAX_ITEMS_PER_CHUNK) break;
    await pause(FUNNEL_FINNHUB_INTERVAL_MS);
  }

  const screenedAt = now();
  const records = await mapBounded(candidates.slice(0, FUNNEL_MAX_ITEMS_PER_CHUNK), FUNNEL_JEV_CONCURRENCY, async ({ ticker, item }) => {
    try {
      const s = await screenFunnelItem(deps.jev, ticker, item);
      const publishedAt = item.datetime * 1000;
      const record: FunnelItemRecord = {
        day,
        ticker,
        headline: item.headline,
        summary: item.summary.slice(0, 600),
        source: item.source,
        url: item.url,
        publishedAt,
        screenedAt,
        model: s.model,
        freshCatalyst: s.freshCatalyst,
        pricedIn: s.pricedIn,
        strategyTag: s.strategyTag,
        strategyTagConfidence: s.strategyTagConfidence,
        higherIn10d: s.higherIn10d,
        score: funnelScore({ ...s, publishedAt }, screenedAt),
      };
      return record;
    } catch (err) {
      failures += 1;
      logger.warn(`[funnel] screen failed for ${ticker} "${item.headline.slice(0, 60)}":`, err);
      return null;
    }
  });
  const good = records.filter((r): r is FunnelItemRecord => r !== null);

  let inserted = 0;
  let skipped = 0;
  // Batches keep each mutation well under Convex's argument size limit on a heavy news day.
  for (let i = 0; i < good.length; i += 50) {
    const res = await deps.memory.upsertFunnelItems(good.slice(i, i + 50));
    inserted += res.inserted;
    skipped += res.skipped;
  }
  return { tickers: tickers.length, fetched: candidates.length, screened: good.length, inserted, skipped, failures };
}

/**
 * The close on the screening day and the close ten trading days later, from daily candles.
 * Returns null until enough sessions have printed.
 */
export function outcomeFromCandles(candles: readonly Candle[], screenedDay: string): { outcomeUp: boolean; outcomePct: number } | null {
  const sorted = [...candles].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = sorted.findIndex((c) => c.date >= screenedDay);
  if (start < 0) return null;
  const end = start + FUNNEL_OUTCOME_TRADING_DAYS;
  const a = sorted[start];
  const b = sorted[end];
  if (!a || !b || !(a.close > 0)) return null;
  const outcomePct = (b.close / a.close - 1) * 100;
  return { outcomeUp: b.close > a.close, outcomePct };
}

/**
 * Score the directional shadow for items old enough to have an answer. Bounded per run and
 * best-effort per item, so this never competes with the screening for the time budget.
 */
export async function scoreFunnelOutcomes(deps: {
  news: FunnelNewsSource;
  memory: FunnelMemory;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
}): Promise<{ scored: number; pending: number; failures: number }> {
  const now = deps.now ?? Date.now;
  const pause = deps.sleepImpl ?? sleep;
  const logger = deps.logger ?? console;
  const at = now();
  // Ten trading days is at least fourteen calendar days; a little more covers holidays.
  const screenedBefore = at - 16 * 86_400_000;
  const items = await deps.memory.funnelItemsAwaitingOutcome(screenedBefore, FUNNEL_OUTCOMES_PER_RUN);
  let scored = 0;
  let pending = 0;
  let failures = 0;
  for (const item of items) {
    try {
      const screenedDay = utcDay(item.screenedAt);
      const candles = await deps.news.getCandles(item.ticker, screenedDay, utcDay(at));
      const outcome = outcomeFromCandles(candles, screenedDay);
      if (!outcome) {
        pending += 1;
        continue;
      }
      await deps.memory.recordFunnelOutcome({ id: item._id, outcomeAt: at, ...outcome });
      scored += 1;
    } catch (err) {
      failures += 1;
      logger.warn(`[funnel] outcome failed for ${item.ticker}:`, err);
    }
    await pause(FUNNEL_FINNHUB_INTERVAL_MS);
  }
  return { scored, pending, failures };
}
