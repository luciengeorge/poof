/**
 * A time-bounded `fetch`, for HTTP calls made from inside an eve hook.
 *
 * WHY THIS EXISTS. Hooks run INLINE in eve's event pipeline (that is exactly why a thrown hook
 * escalates to `turn.failed`). An endpoint that ERRORS is already harmless: the caller catches
 * it and warns. An endpoint that HANGS is not: without a deadline, a black-holed connection
 * stalls the pipeline until the OS TCP timeout, and the online-eval hook makes one small call
 * per tool result, so the exposure is multiplied by the tool-call count. On a live trading
 * cycle that is a real hang risk.
 *
 * Two layers, deliberately:
 *  1. an `AbortSignal` so the underlying request is actually torn down, and
 *  2. a race against the same deadline, so the CALLER stops awaiting even if the fetch
 *     implementation ignores the signal.
 * Layer 2 is what turns "hangs forever" into "throws, gets caught, logs a warning".
 *
 * NOT applied to the trading path. `memoryFromEnv()` keeps its untimed client by default: a
 * timeout there would convert a slow-but-healthy Convex into a fail-closed halt and could
 * block a legitimate trade, which is precisely the class of change observability must not make.
 */

export type FetchLike = typeof globalThis.fetch;

/**
 * Budget for one observability HTTP call (a tiny Convex mutation, a Slack webhook post). Long
 * enough that a healthy endpoint never trips it, short enough that a dead one cannot stall a
 * trading cycle.
 */
export const OBSERVER_FETCH_TIMEOUT_MS = 4_000;

/** Wrap a fetch implementation so every call is abandoned after `timeoutMs`. */
export function timeoutFetch(
  timeoutMs: number,
  fetchImpl: FetchLike = globalThis.fetch,
): FetchLike {
  return async (input, init) => {
    const controller = new AbortController();
    // Compose with a caller-supplied signal so an outer cancellation still wins.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abandoned = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new Error(`fetch timed out after ${timeoutMs}ms`)),
      );
    });
    const attempt = fetchImpl(input, { ...init, signal });
    // The race may walk away from `attempt`; keep its later rejection from surfacing as an
    // unhandled rejection (which in Node would be far worse than the timeout itself).
    attempt.catch(() => {});
    try {
      return await Promise.race([attempt, abandoned]);
    } finally {
      clearTimeout(timer);
    }
  };
}
