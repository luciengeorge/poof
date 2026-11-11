import { FinnhubProvider } from "../data.ts";
import { timeoutFetch } from "../fetch-timeout.ts";
import type { PriceBasis } from "./policy.ts";
import type { Lease, ShadowStore } from "./store.ts";

export class ShadowBudgetError extends Error {}
export class ShadowProviderError extends Error {
  readonly status: number;
  constructor(status: number) { super("shadow-tiingo-unavailable"); this.status = status; }
}
export function shadowFinnhub(store: ShadowStore, lease: Lease, apiKey: string, fetchImpl: typeof fetch = fetch) {
  // Each physical request needs a durable permit; never use the retrying live singleton.
  const bounded: typeof fetch = async (input, init) => {
    if (!(await store.permit(lease, "finnhub"))) throw new ShadowBudgetError("shadow-finnhub-budget");
    return fetchImpl(input, init);
  };
  return new FinnhubProvider({ apiKey, fetchImpl: bounded, maxRetries: 0, timeoutMs: 8_000 });
}
export async function adjustedBars(
  store: ShadowStore, lease: Lease, apiKey: string, symbol: string, from: string, to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PriceBasis[]> {
  if (!(await store.permit(lease, "tiingo"))) throw new ShadowBudgetError("shadow-tiingo-budget");
  const url = new URL(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol.toLowerCase())}/prices`);
  url.search = new URLSearchParams({ startDate: from, endDate: to, format: "json", token: apiKey }).toString();
  const response = await timeoutFetch(8_000, fetchImpl)(url);
  if (!response.ok) throw new ShadowProviderError(response.status);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw) || raw.length > 30) throw new Error("shadow-tiingo-shape");
  return raw.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const r = value as Record<string, unknown>;
    if (typeof r.date !== "string" || typeof r.close !== "number" || typeof r.adjClose !== "number" ||
      !Number.isFinite(r.close) || !Number.isFinite(r.adjClose) || r.close <= 0 || r.adjClose <= 0) return [];
    return [{ day: r.date.slice(0, 10), rawClose: r.close, adjustedClose: r.adjClose }];
  });
}
