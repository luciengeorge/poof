export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for a 429: prefer Retry-After (seconds), else the rate-limit period, else 2^attempt s. Capped at 10s. */
export function retryDelayMs(h: Headers, attempt: number): number {
  const retryAfter = Number(h.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  const period = Number(h.get("x-ratelimit-period"));
  if (Number.isFinite(period) && period > 0) {
    return Math.min(period * 1000, 10_000);
  }
  return Math.min(2 ** attempt * 1000, 10_000);
}
