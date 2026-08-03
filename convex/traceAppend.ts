/**
 * The ACCUMULATION rules for a cycle trace, as pure decisions: how a tool name joins the
 * sequence, and how a batch of quoted prices joins the stored map.
 *
 * It lives in `convex/` (not `agent/lib/`) so `convex/memory.ts` can import it: the Convex
 * typecheck config does not allow `.ts` import specifiers, so it cannot reach into `agent/`.
 * Keeping it pure and in ONE place means the mutation is not the only description of the rule,
 * and the rule can be unit-tested without a Convex deployment (see agent/lib/trace-append.test.ts,
 * which lives under agent/ only because that is where the test-runner glob looks).
 *
 * Two hazards, both of which would otherwise produce a FALSE violation alert, and an alert
 * nobody believes is worse than no alert:
 *  1. RE-DELIVERY. A turn is a durable workflow that resumes from its last completed step, so an
 *     `action.result` recorded just before a crash can fire again. Appending it twice would put a
 *     second `submit_orders` in the sequence and trip `single-submit`.
 *  2. TRUNCATION. Past the cap, tools are no longer recorded. Dropping them silently would make
 *     a late `record_cycle` look absent and fail `cycle-recorded`, so the cap is reported instead
 *     and the caller marks the trace truncated.
 */

/** Hard cap on the recorded sequence: a runaway turn must not grow the document without end. */
export const MAX_TOOL_SEQUENCE = 200;

export type AppendDecision =
  /** Already recorded under this callId: a re-delivery, not a second real tool call. */
  | { kind: "duplicate" }
  /** The cap is reached: record nothing more and mark the trace truncated. */
  | { kind: "truncated" }
  /** Record it, with the resulting arrays. */
  | { kind: "append"; toolSequence: string[]; callIds: string[] };

/**
 * Hard cap on the recorded quote map. Unlike the orders/exits/positions bounds (which live in
 * agent/lib/cycle-trace.ts, because one tool result is capped there and then stored whole), the
 * quote map ACCUMULATES across the several get_prices calls one cycle makes, so its cap has to
 * be applied where the already-stored map is visible: here.
 */
export const MAX_TRACE_QUOTES = 30;

/**
 * Merge one batch of ticker-to-price quotes into the map already on the trace, bounded.
 *
 * Accumulating rather than overwriting is the point: a price the report quotes may have been
 * fetched in the cycle's first batch, and a later batch must not erase it, or the judge would
 * read a correctly sourced price as invented. Past the cap, a NEW ticker is dropped and reported
 * (the caller marks the map truncated, loudly, exactly like the tool-sequence cap); updating a
 * ticker already in the map is always allowed, since it cannot grow the document and refusing it
 * would leave a stale price standing as ground truth.
 */
export function mergeQuoteMap(
  existing: Readonly<Record<string, number>> | undefined,
  incoming: Readonly<Record<string, number>>,
  cap: number = MAX_TRACE_QUOTES,
): { quotes: Record<string, number>; truncated: boolean } {
  const quotes: Record<string, number> = { ...(existing ?? {}) };
  let truncated = false;
  for (const [ticker, price] of Object.entries(incoming)) {
    if (!Number.isFinite(price)) continue;
    if (!(ticker in quotes) && Object.keys(quotes).length >= cap) {
      truncated = true;
      continue;
    }
    quotes[ticker] = price;
  }
  return { quotes, truncated };
}

export function decideAppend(
  existing: { toolSequence: readonly string[]; callIds: readonly string[] },
  toolName: string,
  callId: string,
): AppendDecision {
  // An empty callId cannot be deduplicated. Append it anyway rather than dropping it: losing a
  // real tool call would itself produce a false verdict.
  if (callId !== "" && existing.callIds.includes(callId)) return { kind: "duplicate" };
  if (existing.toolSequence.length >= MAX_TOOL_SEQUENCE) return { kind: "truncated" };
  return {
    kind: "append",
    toolSequence: [...existing.toolSequence, toolName],
    callIds: callId === "" ? [...existing.callIds] : [...existing.callIds, callId],
  };
}
