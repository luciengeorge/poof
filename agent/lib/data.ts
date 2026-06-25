const FINNHUB_BASE = "https://finnhub.io/api/v1";

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

export interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote>;
  getCompanyNews(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<NewsItem[]>;
  getMarketNews(): Promise<NewsItem[]>;
}

export interface FinnhubConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
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

  constructor(cfg: FinnhubConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(FINNHUB_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", this.apiKey);
    const res = await this.fetchImpl(url);
    const text = await res.text();
    if (!res.ok) throw new FinnhubError(res.status, text);
    return JSON.parse(text) as T;
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
}

export function finnhubFromEnv(fetchImpl?: typeof fetch): FinnhubProvider {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY is not set");
  return new FinnhubProvider({ apiKey, fetchImpl });
}
