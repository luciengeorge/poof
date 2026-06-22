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

export class T212Client {
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private rateLimit: RateLimitInfo | null = null;

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
    if (!res.ok) throw new T212Error(res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getCash(): Promise<CashBalance> {
    return this.request("GET", "/equity/account/cash");
  }

  getPortfolio(): Promise<T212Position[]> {
    return this.request("GET", "/equity/portfolio");
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
