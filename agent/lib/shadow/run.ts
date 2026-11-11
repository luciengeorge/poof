import { FinnhubError, type NewsItem, type Quote } from "../data.ts";
import type { JevClient } from "../jev.ts";
import { JEV_MODEL, JevError } from "../jev.ts";
import { screenOne } from "../jev-shadow.ts";
import { researchDay, shadowTick } from "../../../convex/shadowCalendar.ts";
import { canonicalUrl, newsEligibility, relativeOutcome, startPair, storyKey, validQuote, type PriceBasis, type TimedQuote } from "./policy.ts";
import type { Env, Lease, ShadowKind, ShadowStore } from "./store.ts";
import { ShadowBudgetError, ShadowProviderError } from "./providers.ts";

export interface ShadowDeps {
  store: ShadowStore; now: () => number; sleep: (ms: number) => Promise<void>;
  news: { getCompanyNews(symbol: string, from: string, to: string): Promise<NewsItem[]>; getQuote(symbol: string): Promise<Quote> };
  jev: JevClient;
  forecastsEnabled: boolean;
  bars: (symbol: string, from: string, to: string) => Promise<PriceBasis[]>;
}
export function shadowEnabled(env: Readonly<Record<string, string | undefined>>, kind: ShadowKind): boolean {
  return env.SHADOW_RESEARCH_ENABLED === "true" && env.SHADOW_FEED_QUOTAS_VERIFIED === "true" &&
    env[`SHADOW_${kind.toUpperCase()}_ENABLED`] === "true";
}
export function shadowDue(kind: ShadowKind, now: number): boolean {
  if ([12, 15, 18].includes(new Date(now).getUTCHours())) return false;
  if (kind === "score") return new Date(now).getUTCMinutes() === 9 &&
    /^202[67]-/.test(researchDay(now));
  return !("reason" in shadowTick(now, kind === "news" ? 15 : 5, kind === "positions" ? 2 : 0));
}
function timed(q: Quote): TimedQuote { return { symbol: q.symbol, price: q.price, at: q.timestamp ?? 0 }; }

/** The injected dependencies have no broker, execution agent, Slack dispatch, or live-memory writer. */
export async function runShadow(kind: ShadowKind, env: Env, owner: string,
  makeDeps: (lease: Lease) => ShadowDeps, store: ShadowStore,
): Promise<string> {
  const claim = await store.claim(env, kind, owner);
  if ("reason" in claim) return claim.reason;
  const lease = { env, owner, runId: claim.runId };
  let deps: ShadowDeps | undefined;
  try {
    deps = makeDeps(lease);
    const { now, sleep, news, jev } = deps;
    const deadline = claim.startedAt + 180_000;
    const checkTime = () => { if (now() > deadline - 20_000) throw new Error("shadow-time-budget"); };
    // Serialized physical requests, in addition to the cross-worker durable quota.
    let lastRequest = -Infinity;
    const pace = async () => { checkTime(); await sleep(Math.max(0, lastRequest + 3_200 - now())); checkTime(); lastRequest = now(); };
    if (kind === "score") {
      const due = await store.due(env, now());
      // Rotate pending rows when EOD data is delayed; a missing bar must not block all successors.
      const row = due[Math.floor(now() / 3_600_000) % Math.max(1, due.length)];
      if (row?.start && row.probability !== undefined) {
        const from = researchDay(row.start.stock.at), to = row.start.sessionDay;
        const stock = await deps.bars(row.ticker, from, to);
        const proxy = await deps.bars("SPY", from, to);
        const stockStart = stock.find((b) => b.day === from), stockEnd = stock.find((b) => b.day === to);
        const proxyStart = proxy.find((b) => b.day === from), proxyEnd = proxy.find((b) => b.day === to);
        if (stockStart && stockEnd && proxyStart && proxyEnd) {
          const outcome = relativeOutcome(row.probability, row.baseline, row.start, { stockStart, stockEnd, proxyStart, proxyEnd });
          if (!outcome) throw new Error("shadow-price-basis-invalid");
          await store.score(lease, row._id, { ...outcome, scoredAt: now(), source: "tiingo-adjusted-eod-v1" });
          await store.finish(lease, "completed", "scored"); return "scored";
        }
      }
      await store.finish(lease, "completed", row ? "outcome-data-pending" : "no-matured-forecasts");
      return row ? "outcome-data-pending" : "no-matured-forecasts";
    }
    const inputs = await store.inputs(lease);
    if (kind === "positions") {
      const quotes: TimedQuote[] = [];
      for (const ticker of [...new Set(inputs.held.map((p) => p.ticker.replace(/_US_EQ$/i, "")))].slice(0, 4)) {
        if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) continue;
        await pace(); const q = timed(await news.getQuote(ticker));
        if (validQuote(q, now())) quotes.push(q);
      }
      // This deployment has no durable confirmed quantity snapshot. Quotes never masquerade as exits.
      await store.finish(lease, "skipped", "position-state-unavailable", quotes);
      return "position-state-unavailable";
    }
    const pending: string[] = [];
    let truncated = 0;
    const offset = Math.floor(claim.slot) % Math.max(1, inputs.cursors.length);
    const cursors = [...inputs.cursors.slice(offset), ...inputs.cursors.slice(0, offset)];
    for (const cursor of cursors.slice(0, 16)) {
      await pace(); const through = now();
      const from = new Date(Math.max(through - 36 * 3_600_000, cursor.through - 900_000)).toISOString().slice(0, 10);
      const items = await news.getCompanyNews(cursor.ticker, from, new Date(through).toISOString().slice(0, 10));
      const firstSeenAt = now();
      const relevant = items.filter((i) => !Number.isFinite(i.datetime) || i.datetime * 1_000 >= Math.max(through - 36 * 3_600_000, cursor.through - 900_000));
      const capped = relevant.length > 50;
      if (capped) truncated++;
      const evidence = relevant.sort((a, b) => b.datetime - a.datetime).slice(0, 50).map((i) => {
        const candidate = i.datetime * 1_000;
        const publishedAt = Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
        const reason = newsEligibility(publishedAt, firstSeenAt);
        return { story: storyKey(i.headline, publishedAt || firstSeenAt), url: canonicalUrl(i.url),
          headline: i.headline.slice(0, 500), summary: i.summary.slice(0, 2_000), source: i.source.slice(0, 120),
          publishedAt, firstSeenAt, eligible: reason === null, ...(reason ? { reason } : {}) };
      });
      pending.push(...await store.ingest(lease, cursor.ticker, through, capped, evidence));
    }
    // Every durable event remains visible, including the unscreened tail. Next claim marks its
    // expired state; it can never be silently retried with information from a later day.
    const attemptCap = deps.forecastsEnabled ? 3 : 0;
    for (const id of pending.slice(0, attemptCap)) {
      checkTime(); const attemptId = `${owner}:${id}`;
      const row = await store.attempt(lease, id, attemptId);
      if (!row) continue;
      let prediction;
      try {
        const screen = await screenOne(jev, { headline: row.headline, summary: row.summary, source: row.source,
          datetime: row.publishedAt / 1_000, related: row.ticker, url: "" }).catch((error: unknown) => {
            if (error instanceof ShadowBudgetError || (error instanceof JevError && error.status === 429)) throw error;
            return undefined; // An unavailable annotation must not veto the forecast.
          });
        const response = await jev.ask({ ticker: row.ticker, headline: row.headline, summary: row.summary,
          source: row.source, publication: new Date(row.publishedAt).toISOString(), cutoff: new Date(row.inputCutoff).toISOString(),
          researchContract: "event-relative-v1; starting prices are collected only AFTER this probability is committed" }, {
          outperforms: { type: "noul", instructions: "Using only the supplied article, what is the probability that this stock's USD total return exceeds SPY's USD total return, from the prospective starting quotes collected after your answer is committed to the actual close of the next US regular session whose open follows commitment? A tie is false. Do not infer access to current prices or later news.",
            criteria: { true: "Stock total return strictly exceeds SPY total return.", false: "Stock total return is equal to or below SPY total return." } },
        });
        prediction = await store.prediction(lease, id, attemptId, { probability: response.answers.outperforms.noul,
          completedAt: now(), model: response.model, ...(screen ? { screen } : {}) });
      } catch (error) {
        // No automatic model replay and no invented 0.5. An attempted but unavailable answer is visible.
        await store.prediction(lease, id, attemptId, { probability: null, completedAt: now(), model: JEV_MODEL, reason: "forecast-unavailable" });
        if (error instanceof ShadowBudgetError || (error instanceof JevError && error.status === 429)) throw error;
        continue;
      }
      if (!prediction) continue;
      let pair = null;
      for (let attempt = 0; attempt < 3 && now() - prediction.committedAt < 40_000; attempt++) {
        // Refill both durable tokens before a paired burst; leave room for whole-second
        // provider timestamps after commitment. Pace BETWEEN pairs, not between legs.
        await sleep(Math.max(0, lastRequest + 6_400 - now(), Math.floor(prediction.committedAt / 1_000) * 1_000 + 1_000 - now()));
        await pace(); const stock = timed(await news.getQuote(row.ticker));
        checkTime(); const proxy = timed(await news.getQuote("SPY")); lastRequest = now();
        if (stock.symbol === row.ticker && startPair(stock, proxy, prediction.committedAt, now())) {
          pair = { stock, proxy, sessionOpen: prediction.session.open, sessionClose: prediction.session.close, sessionDay: prediction.session.day };
          break;
        }
      }
      await store.attachStart(lease, id, pair);
    }
    const reason = `news-ingested;truncated=${truncated};unattempted=${Math.max(0, pending.length - attemptCap)}`;
    await store.finish(lease, "completed", reason); return reason;
  } catch (error) {
    // Provider bodies can contain credentials. Persist a bounded category, never the raw error.
    const reason = error instanceof ShadowBudgetError ? "shadow-provider-budget" :
      error instanceof FinnhubError ? `shadow-finnhub-${error.status}` :
      error instanceof ShadowProviderError ? `shadow-tiingo-${error.status}` :
      error instanceof JevError ? `shadow-jev-${error.status ?? "unavailable"}` :
      error instanceof Error && error.message === "shadow-time-budget" ? "shadow-time-budget" : "shadow-dependency-unavailable";
    await store.finish(lease, "failed", reason);
    return reason;
  }
}
