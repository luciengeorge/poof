import { sleep, retryDelayMs } from "./http-backoff.ts";
import type { Candle } from "./data.ts";

const TIINGO_BASE = "https://api.tiingo.com/tiingo/daily";

export interface TiingoConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class TiingoError extends Error {
  status: number;
  body: string;
  rateLimited: boolean;
  constructor(status: number, body: string) {
    super(`Tiingo API error ${status}: ${body}`);
    this.name = "TiingoError";
    this.status = status;
    this.body = body;
    this.rateLimited = status === 429;
  }
}

/** One row of Tiingo's daily-prices payload. We only consume the adjusted OHLC. */
interface RawTiingoPrice {
  date: string; // ISO datetime, e.g. "2024-01-03T00:00:00.000Z"
  adjOpen?: number;
  adjHigh?: number;
  adjLow?: number;
  adjClose?: number;
}

/**
 * Historical daily candles for one symbol, sourced from Tiingo's daily-prices REST endpoint.
 * Unlike Finnhub's /stock/candle (gated on our tier), Tiingo serves adjusted end-of-day bars
 * on the free tier, which is why the backtest harness uses it as the live candle source.
 */
export class TiingoProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TiingoConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(TIINGO_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", this.apiKey);
    // Back off and retry on 429 honoring Retry-After, matching the Finnhub client.
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url);
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as T;
      if (res.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(res.headers, attempt));
        continue;
      }
      throw new TiingoError(res.status, text);
    }
  }

  /**
   * Adjusted daily OHLC for `symbol` over [fromISO, toISO] (both YYYY-MM-DD). Tiingo expects
   * plain lowercase symbols. Uses the ADJUSTED fields so splits/dividends are handled, and
   * returns a Candle[] sorted ascending by date.
   */
  async getCandles(
    symbol: string,
    fromISO: string,
    toISO: string,
  ): Promise<Candle[]> {
    const raw = await this.get<RawTiingoPrice[]>(
      `/${symbol.toLowerCase()}/prices`,
      { startDate: fromISO, endDate: toISO, format: "json" },
    );
    return mapTiingoPrices(raw);
  }
}

/**
 * Map Tiingo's daily-prices rows into Candle[] using the ADJUSTED OHLC, with the ISO date
 * truncated to YYYY-MM-DD and sorted ascending. Rows missing any adjusted field are skipped.
 */
export function mapTiingoPrices(raw: RawTiingoPrice[]): Candle[] {
  const candles: Candle[] = [];
  for (const r of raw) {
    if (
      typeof r.adjOpen !== "number" ||
      typeof r.adjHigh !== "number" ||
      typeof r.adjLow !== "number" ||
      typeof r.adjClose !== "number"
    ) {
      continue;
    }
    candles.push({
      date: r.date.slice(0, 10),
      open: r.adjOpen,
      high: r.adjHigh,
      low: r.adjLow,
      close: r.adjClose,
    });
  }
  return candles.sort((a, b) => a.date.localeCompare(b.date));
}

export function tiingoFromEnv(fetchImpl?: typeof fetch): TiingoProvider {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) throw new Error("TIINGO_API_KEY is not set");
  return new TiingoProvider({ apiKey, fetchImpl });
}
