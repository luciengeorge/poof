/**
 * The append rule for a cycle trace's tool sequence, as a pure decision.
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
