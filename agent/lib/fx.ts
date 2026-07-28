/**
 * Live instrument -> account FX (USD -> GBP) for pricing US positions in the GBP account.
 *
 * Resolution order (deliberate, and never a silent default):
 *   1. USD_GBP_RATE env, ONLY if it parses to a valid positive number. This is a manual
 *      override for a human who wants to pin the rate. An empty/blank/invalid value is NOT
 *      treated as a rate; it falls through (the old code's empty-string handling silently
 *      standing in a stale 0.79 is exactly the bug this replaces).
 *   2. A live daily rate from frankfurter.app (free, no API key).
 *   3. A hardcoded fallback, used ONLY if the live fetch fails, and LOUDLY: a warning is
 *      logged and the resolution carries source: "fallback" so callers can surface it to a
 *      human. A persistent FX-fetch failure must never again quietly drift the account value.
 */
import { sleep, retryDelayMs } from "./http-backoff.ts";

// Canonical host. api.frankfurter.app 301-redirects here; fetch follows it, but pointing at
// the real endpoint saves the extra hop. Response shape is unchanged:
// { amount, base, date, rates: { GBP } }.
const FRANKFURTER_LATEST = "https://api.frankfurter.dev/v1/latest";

/** Last-resort USD->GBP if the live source is unreachable. Only used with a loud warning. */
export const FX_FALLBACK_USD_GBP = 0.75;

/** Where a resolved rate came from. "fallback" means the live fetch failed. */
export type FxSource = "env" | "live" | "fallback";

export interface FxResolution {
  rate: number;
  source: FxSource;
}

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

interface FrankfurterLatest {
  rates?: Record<string, number>;
}

/**
 * Pure mapper: pull USD->GBP out of a frankfurter `/latest?from=USD&to=GBP` body
 * (`{ rates: { GBP: number } }`). Throws FxError on a missing/non-positive rate rather
 * than returning a bogus number.
 */
export function mapFrankfurterRate(body: unknown): number {
  const rate = (body as FrankfurterLatest)?.rates?.GBP;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new FxError("frankfurter response missing a valid rates.GBP");
  }
  return rate;
}

export interface FxConfig {
  fetchImpl?: typeof fetch;
}

/** Fetches the daily USD->GBP rate from frankfurter.app. Mirrors the Tiingo/T212 backoff. */
export class FrankfurterProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: FxConfig = {}) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async getUsdGbp(): Promise<number> {
    const url = new URL(FRANKFURTER_LATEST);
    url.searchParams.set("from", "USD");
    url.searchParams.set("to", "GBP");
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url);
      const text = await res.text();
      if (res.ok) return mapFrankfurterRate(JSON.parse(text));
      if (res.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(res.headers, attempt));
        continue;
      }
      throw new FxError(`frankfurter error ${res.status}: ${text}`);
    }
  }
}

type EnvLike = Record<string, string | undefined>;

/**
 * USD_GBP_RATE as a MANUAL OVERRIDE: only a valid positive number counts. Empty/blank/
 * non-numeric returns null (it is not a rate), so resolution falls through to the live fetch
 * instead of silently pinning a default.
 */
export function fxOverrideFromEnv(env: EnvLike = process.env): number | null {
  const raw = env.USD_GBP_RATE;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Provider singleton so the default path shares one instance per process (mirrors t212). */
let providerSingleton: FrankfurterProvider | null = null;

export function frankfurterFromEnv(fetchImpl?: typeof fetch): FrankfurterProvider {
  if (!fetchImpl && providerSingleton) return providerSingleton;
  const p = new FrankfurterProvider({ fetchImpl });
  if (!fetchImpl) providerSingleton = p;
  return p;
}

/**
 * Resolve USD->GBP once: env override, else live fetch, else the loud fallback. Never throws:
 * a fetch failure degrades to the fallback with a warning + source: "fallback" so the caller
 * can flag it, rather than aborting a cycle.
 */
export async function resolveUsdGbp(opts?: {
  provider?: FrankfurterProvider;
  env?: EnvLike;
}): Promise<FxResolution> {
  const env = opts?.env ?? process.env;
  const override = fxOverrideFromEnv(env);
  if (override !== null) return { rate: override, source: "env" };
  const provider = opts?.provider ?? frankfurterFromEnv();
  try {
    return { rate: await provider.getUsdGbp(), source: "live" };
  } catch (err) {
    console.warn(
      `[fx] live USD->GBP fetch FAILED; using hardcoded fallback ${FX_FALLBACK_USD_GBP}. ` +
        "Account value may drift until the FX source recovers or USD_GBP_RATE is set. Cause:",
      err,
    );
    return { rate: FX_FALLBACK_USD_GBP, source: "fallback" };
  }
}

// T212's cash/portfolio reads are re-hit several times per cycle; the same holds for FX.
// Memoize the resolution (a promise, so concurrent callers share one fetch) with a modest TTL
// so every tool in one cycle prices positions at the SAME rate (gate consistency) without
// refetching, while a long-lived warm process still refreshes daily FX at most hourly.
const FX_CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { value: Promise<FxResolution>; expires: number } | null = null;

/** Resolve (and cache per process/cycle) the USD->GBP rate. Use this from tools. */
export function fxForCycle(): Promise<FxResolution> {
  if (cache && cache.expires > Date.now()) return cache.value;
  const value = resolveUsdGbp();
  cache = { value, expires: Date.now() + FX_CACHE_TTL_MS };
  return value;
}

/** Test hook: clear the per-process FX cache. */
export function resetFxCache(): void {
  cache = null;
}
