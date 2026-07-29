/**
 * Behavioural invariants for one trading cycle, expressed over the ORDERED sequence of tool
 * (and subagent) names the cycle actually invoked.
 *
 * THE SINGLE SOURCE OF TRUTH, shared by both eval surfaces:
 *   - OFFLINE (evals/cycle/*.eval.ts): the sequence is built from `actions.requested` events
 *     of a demo/dry-run agent run in CI.
 *   - ONLINE (agent/hooks/trace-cycle.ts): the sequence is built from `action.result` events
 *     of the real production cycle and asserted at the turn boundary.
 * One definition means a guard cannot be green offline and unenforced in production.
 *
 * WHY "not-applicable" IS A FIRST-CLASS STATUS. The submit-gated invariants are CONDITIONAL:
 * "if the agent bought, it must have checked earnings first". On a no-trade cycle they hold
 * vacuously. A plain boolean therefore reports "verified" and "never reached" identically,
 * which is how a guarded path can rot unnoticed for months while CI stays green. Vacuity is
 * tracked explicitly so a human can see WHICH guards were actually exercised.
 *
 * Pure: no I/O, no clock, no environment. This module is an OBSERVER. Nothing here is an
 * input to the risk gate, position sizing, or order placement (see the isolation test in
 * observers.test.ts); a failing invariant alerts and never blocks a trade.
 */

export type InvariantStatus = "pass" | "fail" | "not-applicable";

export interface InvariantResult {
  name: string;
  status: InvariantStatus;
  /** Human-readable explanation. Always set for "fail" and "not-applicable". */
  detail?: string;
}

/** The tool whose presence makes the conditional invariants applicable. */
export const SUBMIT_ORDERS = "submit_orders";

/** Every invariant name, in the order `checkInvariants` reports them. */
export const INVARIANT_NAMES = [
  "earnings-before-buy",
  "red-team-before-buy",
  "exits-before-entries",
  "cycle-recorded",
  "single-submit",
] as const;

export type InvariantName = (typeof INVARIANT_NAMES)[number];

/**
 * "If the cycle submitted an order, `prerequisite` must have run strictly earlier."
 *
 * Guarded against the FIRST submit_orders: a prerequisite that only appears between two
 * submits left the first one unguarded, which is a real failure, not a pass.
 */
function prerequisiteBeforeSubmit(
  name: InvariantName,
  prerequisite: string,
  sequence: readonly string[],
): InvariantResult {
  const submitAt = sequence.indexOf(SUBMIT_ORDERS);
  if (submitAt === -1) {
    return {
      name,
      status: "not-applicable",
      detail: `no ${SUBMIT_ORDERS} in this cycle, so the guard was never exercised`,
    };
  }
  const prerequisiteAt = sequence.indexOf(prerequisite);
  if (prerequisiteAt === -1) {
    return {
      name,
      status: "fail",
      detail: `${SUBMIT_ORDERS} ran at step ${submitAt} but ${prerequisite} never ran`,
    };
  }
  if (prerequisiteAt > submitAt) {
    return {
      name,
      status: "fail",
      detail: `${prerequisite} ran at step ${prerequisiteAt}, after ${SUBMIT_ORDERS} at step ${submitAt}`,
    };
  }
  return { name, status: "pass" };
}

/**
 * Evaluate every invariant against one cycle's ordered tool sequence.
 *
 * `toolSequence` is invocation order, earliest first, and may contain any tool or subagent
 * name; unrecognised names are simply not referenced by any invariant.
 */
export function checkInvariants(sequence: readonly string[]): InvariantResult[] {
  const submitCount = sequence.filter((name) => name === SUBMIT_ORDERS).length;

  return [
    prerequisiteBeforeSubmit("earnings-before-buy", "get_earnings_calendar", sequence),
    prerequisiteBeforeSubmit("red-team-before-buy", "red_team", sequence),
    prerequisiteBeforeSubmit("exits-before-entries", "manage_positions", sequence),
    // Unconditional: every cycle must leave a decision-log row, trade or no trade. This one
    // is never vacuous, which is exactly why it is the invariant that catches a cycle that
    // died silently part-way through.
    sequence.includes("record_cycle")
      ? { name: "cycle-recorded" as const, status: "pass" as const }
      : {
          name: "cycle-recorded" as const,
          status: "fail" as const,
          detail: "record_cycle never ran, so this cycle left no decision-log row",
        },
    // One cycle places one batch of orders. A second submit means the agent (or a step
    // re-run) is placing orders twice off one decision.
    submitCount === 0
      ? {
          name: "single-submit" as const,
          status: "not-applicable" as const,
          detail: `no ${SUBMIT_ORDERS} in this cycle, so the guard was never exercised`,
        }
      : submitCount === 1
        ? { name: "single-submit" as const, status: "pass" as const }
        : {
            name: "single-submit" as const,
            status: "fail" as const,
            detail: `${SUBMIT_ORDERS} ran ${submitCount} times in one cycle`,
          },
  ];
}

/** The invariants that were broken. Empty means nothing is known to be wrong. */
export function violatedInvariants(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((r) => r.status === "fail");
}

/**
 * The invariants that held vacuously. Not a failure, but not evidence either: these guards
 * were never reached by this cycle.
 */
export function vacuousInvariants(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((r) => r.status === "not-applicable");
}

/** Look one invariant up by name. */
export function invariantByName(
  results: readonly InvariantResult[],
  name: string,
): InvariantResult | undefined {
  return results.find((r) => r.name === name);
}

/** One-line summary for a log line or a Slack alert. */
export function summarizeInvariants(results: readonly InvariantResult[]): string {
  return results.map((r) => `${r.name}=${r.status}`).join(" ");
}
