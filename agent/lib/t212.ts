import { sleep, retryDelayMs } from "./http-backoff.ts";

export type T212Env = "demo" | "live";
export type TimeValidity = "DAY" | "GTC";

const HOSTS: Record<T212Env, string> = {
  demo: "https://demo.trading212.com/api/v0",
  live: "https://live.trading212.com/api/v0",
};

export interface T212Config {
  apiKey: string;
  apiSecret: string;
  env: T212Env;
  fetchImpl?: typeof fetch;
}

export interface CashBalance {
  total: number;
  free: number;
  blocked: number;
  invested: number;
  pieCash: number;
  result: number;
  ppl: number;
}

export interface T212Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  maxBuy: number;
  maxSell: number;
  pieQuantity: number;
}

export interface T212Order {
  id: number;
  ticker: string;
  quantity: number;
  [k: string]: unknown;
}

export interface Instrument {
  ticker: string;
  name: string;
  currencyCode: string;
  type: string;
  [k: string]: unknown;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
  period: number;
  used: number;
}

export class T212Error extends Error {
  status: number;
  body: string;
  rateLimited: boolean;
  constructor(status: number, body: string) {
    super(`Trading 212 API error ${status}: ${body}`);
    this.name = "T212Error";
    this.status = status;
    this.body = body;
    this.rateLimited = status === 429;
  }
}

function buildAuthHeader(apiKey: string, apiSecret: string): string {
  return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
}

// T212's cash/portfolio endpoints are tightly rate-limited (~1 req/5s), and a single cycle
// re-reads them several times (get_account, review_performance, manage_positions,
// submit_orders). Cache the bodies briefly so redundant reads don't trip the 429 backoff;
// callers that need a guaranteed-current snapshot (the risk gate) can force a fresh fetch.
const SNAPSHOT_CACHE_TTL_MS = 8000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class T212Client {
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private rateLimit: RateLimitInfo | null = null;
  private cashCache: CacheEntry<CashBalance> | null = null;
  private portfolioCache: CacheEntry<T212Position[]> | null = null;

  constructor(cfg: T212Config) {
    this.base = HOSTS[cfg.env];
    this.auth = buildAuthHeader(cfg.apiKey, cfg.apiSecret);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  lastRateLimit(): RateLimitInfo | null {
    return this.rateLimit;
  }

  private captureRateLimit(h: Headers): void {
    const num = (k: string): number => {
      const v = h.get(k);
      return v === null ? NaN : Number(v);
    };
    const limit = num("x-ratelimit-limit");
    if (!Number.isNaN(limit)) {
      this.rateLimit = {
        limit,
        remaining: num("x-ratelimit-remaining"),
        resetAt: num("x-ratelimit-reset"),
        period: num("x-ratelimit-period"),
        used: num("x-ratelimit-used"),
      };
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // The T212 API is tightly rate-limited (some endpoints 1 req / few seconds). Back off
    // and retry on 429 honoring Retry-After / the reset window, so a cycle's several reads
    // don't fail on a transient limit.
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      this.captureRateLimit(res.headers);
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
      if (res.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(res.headers, attempt));
        continue;
      }
      throw new T212Error(res.status, text);
    }
  }

  async getCash(opts?: { fresh?: boolean }): Promise<CashBalance> {
    if (!opts?.fresh && this.cashCache && this.cashCache.expires > Date.now()) {
      return this.cashCache.value;
    }
    const value = await this.request<CashBalance>("GET", "/equity/account/cash");
    this.cashCache = { value, expires: Date.now() + SNAPSHOT_CACHE_TTL_MS };
    return value;
  }

  async getPortfolio(opts?: { fresh?: boolean }): Promise<T212Position[]> {
    if (!opts?.fresh && this.portfolioCache && this.portfolioCache.expires > Date.now()) {
      return this.portfolioCache.value;
    }
    const value = await this.request<T212Position[]>("GET", "/equity/portfolio");
    this.portfolioCache = { value, expires: Date.now() + SNAPSHOT_CACHE_TTL_MS };
    return value;
  }

  getPosition(ticker: string): Promise<T212Position> {
    return this.request("GET", `/equity/portfolio/${encodeURIComponent(ticker)}`);
  }

  getInstruments(): Promise<Instrument[]> {
    return this.request("GET", "/equity/metadata/instruments");
  }

  getPendingOrders(): Promise<T212Order[]> {
    return this.request("GET", "/equity/orders");
  }

  placeMarketOrder(input: {
    ticker: string;
    quantity: number;
  }): Promise<T212Order> {
    return this.request("POST", "/equity/orders/market", input);
  }

  placeLimitOrder(input: {
    ticker: string;
    quantity: number;
    limitPrice: number;
    timeValidity: TimeValidity;
  }): Promise<T212Order> {
    return this.request("POST", "/equity/orders/limit", input);
  }

  async cancelOrder(id: number): Promise<void> {
    await this.request<void>("DELETE", `/equity/orders/${id}`);
  }
}

// Per-process singleton so every tool invoked within one serverless invocation (one cycle)
// shares the same client, and thus the same getCash/getPortfolio cache. Only memoized for
// the default (no injected fetchImpl) path; callers that pass a fetchImpl (tests) always get
// a fresh client.
let singleton: T212Client | null = null;

export function t212FromEnv(fetchImpl?: typeof fetch): T212Client {
  if (!fetchImpl && singleton) return singleton;
  const apiKey = process.env.TRADING212_API_KEY;
  // Accept either name: TRADING212_API_SECRET (docs) or TRADING212_SECRET_KEY.
  const apiSecret =
    process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  const env = (process.env.TRADING212_ENV ?? "demo") as T212Env;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "TRADING212_API_KEY and TRADING212_API_SECRET (or TRADING212_SECRET_KEY) must be set",
    );
  }
  const client = new T212Client({ apiKey, apiSecret, env, fetchImpl });
  if (!fetchImpl) singleton = client;
  return client;
}
