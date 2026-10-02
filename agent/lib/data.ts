import { sleep, retryDelayMs } from "./http-backoff.ts";
import { timeoutFetch } from "./fetch-timeout.ts";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

/**
 * Deadline for one Finnhub HTTP attempt, matching JEV_TIMEOUT_MS. The wide funnel reads company
 * news for a 126-ticker chunk one ticker at a time inside Vercel's 300 s function wall, and a
 * platform kill runs no catch and no finally, so one read that hangs (rather than errors) used to
 * be able to take the whole function down and leave the chunk at `started` for good. Past this
 * deadline the read throws instead, which the funnel's per-ticker catch counts as a failure.
 */
export const FINNHUB_TIMEOUT_MS = 8_000;

/**
 * Ceiling for one `get()` including its 429 retries and their backoff sleeps. The per-attempt
 * deadline alone does not bound the call: four attempts plus three ten-second backoffs is 62 s,
 * and the funnel's headroom inside the 300 s wall is about 151 s, so three bad tickers would still
 * kill the function. The budget is checked before each backoff sleep, so the attempt after the
 * last permitted sleep can still run to its own deadline: one call ends within
 * FINNHUB_CALL_BUDGET_MS + FINNHUB_TIMEOUT_MS. Past the budget the call throws the same
 * FinnhubError(429) that running out of retries throws, so no caller sees a new error type.
 */
export const FINNHUB_CALL_BUDGET_MS = 20_000;

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
}

export interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number;
  related: string;
}

/** A scheduled earnings report. `hour`: "bmo" (before open), "amc" (after close), "dmh", or "". */
export interface EarningsEvent {
  symbol: string;
  date: string; // YYYY-MM-DD
  hour: string;
  epsEstimate: number | null;
}

/** A daily OHLC bar for one symbol. Consumed by the backtest / replay harness. */
export interface Candle {
  date: string; // YYYY-MM-DD (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote>;
  getCompanyNews(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<NewsItem[]>;
  getMarketNews(): Promise<NewsItem[]>;
  getEarningsCalendar(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<EarningsEvent[]>;
  getCandles(
    symbol: string,
    fromISO: string,
    toISO: string,
    resolution?: string,
  ): Promise<Candle[]>;
}

export interface FinnhubConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt deadline; defaults to FINNHUB_TIMEOUT_MS. Tests pass a short one. */
  timeoutMs?: number;
  /** Whole-call budget across retries; defaults to FINNHUB_CALL_BUDGET_MS. */
  callBudgetMs?: number;
}

export class FinnhubError extends Error {
  status: number;
  body: string;
  rateLimited: boolean;
  constructor(status: number, body: string) {
    super(`Finnhub API error ${status}: ${body}`);
    this.name = "FinnhubError";
    this.status = status;
    this.body = body;
    this.rateLimited = status === 429;
  }
}

interface RawQuote {
  c: number;
  pc: number;
  dp: number;
}

interface RawNews {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number;
  related?: string;
}

interface RawEarnings {
  symbol: string;
  date: string;
  hour?: string;
  epsEstimate?: number | null;
}

/** Finnhub /stock/candle payload: parallel arrays keyed by index, `s` is "ok" | "no_data". */
interface RawCandles {
  s: string;
  t?: number[]; // unix seconds
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
}

function mapNews(r: RawNews): NewsItem {
  return {
    headline: r.headline,
    summary: r.summary,
    source: r.source,
    url: r.url,
    datetime: r.datetime,
    related: r.related ?? "",
  };
}

export class FinnhubProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly callBudgetMs: number;

  constructor(cfg: FinnhubConfig) {
    this.apiKey = cfg.apiKey;
    // The default fetch is looked up per request, not captured: finnhubFromEnv memoises this
    // provider, and one holding a captured fetch would ignore a stub installed after it was built
    // and reach the live API. Wrapped once so every attempt, retries included, has the deadline.
    const fetchImpl: typeof fetch = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
    this.fetchImpl = timeoutFetch(cfg.timeoutMs ?? FINNHUB_TIMEOUT_MS, fetchImpl);
    this.callBudgetMs = cfg.callBudgetMs ?? FINNHUB_CALL_BUDGET_MS;
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(FINNHUB_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", this.apiKey);
    // Finnhub's free tier is tightly rate-limited. Back off and retry on 429
    // honoring Retry-After, so a single busy symbol doesn't fail the request.
    const maxRetries = 3;
    const deadline = Date.now() + this.callBudgetMs;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url);
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as T;
      if (res.status === 429 && attempt < maxRetries) {
        const delay = retryDelayMs(res.headers, attempt);
        if (Date.now() + delay >= deadline) throw new FinnhubError(res.status, text);
        await sleep(delay);
        continue;
      }
      throw new FinnhubError(res.status, text);
    }
  }

  async getQuote(symbol: string): Promise<Quote> {
    const q = await this.get<RawQuote>("/quote", { symbol });
    return { symbol, price: q.c, prevClose: q.pc, changePct: q.dp };
  }

  async getCompanyNews(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<NewsItem[]> {
    const raw = await this.get<RawNews[]>("/company-news", {
      symbol,
      from: fromISO,
      to: toISO,
    });
    return raw.map(mapNews);
  }

  async getMarketNews(): Promise<NewsItem[]> {
    const raw = await this.get<RawNews[]>("/news", { category: "general" });
    return raw.map(mapNews);
  }

  async getEarningsCalendar(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<EarningsEvent[]> {
    const raw = await this.get<{ earningsCalendar?: RawEarnings[] }>(
      "/calendar/earnings",
      { symbol, from: fromISO, to: toISO },
    );
    return (raw.earningsCalendar ?? []).map((e) => ({
      symbol: e.symbol,
      date: e.date,
      hour: e.hour ?? "",
      epsEstimate: e.epsEstimate ?? null,
    }));
  }

  /**
   * Daily OHLC candles for a symbol, mapped from Finnhub's /stock/candle parallel-array
   * payload into a sorted Candle[]. NOTE: /stock/candle is gated on our current API tier,
   * so live calls 403 ("no access"); this mapping exists so the harness is ready the moment
   * a provider/tier that serves candles is wired in. `fromISO`/`toISO` are YYYY-MM-DD and are
   * converted to the unix-second `from`/`to` window Finnhub expects. Returns [] on `no_data`.
   */
  async getCandles(
    symbol: string,
    fromISO: string,
    toISO: string,
    resolution: string = "D",
  ): Promise<Candle[]> {
    const from = Math.floor(Date.parse(fromISO) / 1000);
    const to = Math.floor(Date.parse(toISO) / 1000);
    const raw = await this.get<RawCandles>("/stock/candle", {
      symbol,
      resolution,
      from: String(from),
      to: String(to),
    });
    return mapCandles(raw);
  }
}

/** Map Finnhub's parallel-array candle payload into a Candle[] sorted ascending by date. */
export function mapCandles(raw: RawCandles): Candle[] {
  if (raw.s !== "ok" || !raw.t || !raw.o || !raw.h || !raw.l || !raw.c) return [];
  const candles: Candle[] = raw.t.map((sec, i) => ({
    date: new Date(sec * 1000).toISOString().slice(0, 10),
    open: raw.o![i],
    high: raw.h![i],
    low: raw.l![i],
    close: raw.c![i],
  }));
  return candles.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Per-process singleton so every tool in one serverless invocation shares one provider, mirroring
 * t212FromEnv and frankfurterFromEnv. Finnhub is the most called external service here and was the
 * only one still constructing a fresh client per call site, which left nowhere for a shared request
 * budget to live. Only memoised on the default path; callers that inject a fetchImpl (tests) always
 * get a fresh provider.
 */
let providerSingleton: FinnhubProvider | null = null;

export function finnhubFromEnv(fetchImpl?: typeof fetch): FinnhubProvider {
  if (!fetchImpl && providerSingleton) return providerSingleton;
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY is not set");
  const p = new FinnhubProvider({ apiKey, fetchImpl });
  if (!fetchImpl) providerSingleton = p;
  return p;
}

/** Test hook: drop the per-process provider. Mirrors resetT212Singleton and resetFxCache. */
export function resetFinnhubProvider(): void {
  providerSingleton = null;
}
