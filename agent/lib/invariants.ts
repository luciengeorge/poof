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
/** The tool that changes durable memory, and the judge that must vet a change first. */
export const AMEND_MEMORY = "amend_memory";
export const MEMORY_GATE = "memory_gate";

/** Every invariant name, in the order `checkInvariants` reports them. */
export const INVARIANT_NAMES = [
  "earnings-before-buy",
  "red-team-before-buy",
  "exits-before-entries",
  "cycle-recorded",
  "no-duplicate-orders",
  "memory-gate-before-amend",
] as const;

export type InvariantName = (typeof INVARIANT_NAMES)[number];

/**
 * One recorded order, reduced to what duplicate detection needs.
 *
 * `status` matters as much as the identity: only an order that actually reached the broker can be
 * a duplicate send.
 */
export interface OrderRowLike {
  ticker: string;
  side: string;
  status: string;
}

/**
 * Order statuses meaning the order REACHED THE BROKER, and so could constitute a duplicate send.
 *
 * "rejected" and "skipped" are deliberately excluded, and that exclusion is the whole reason this
 * invariant can be trusted. A cycle that tries to fully close a position, gets rejected on the
 * broker's minimum-position rule, and retries a workable partial produces two rows for the same
 * ticker and side. Only one was ever sent. Counting rejections would fail that cycle, which is
 * correct behaviour being reported as a violation.
 */
const SENT_TO_BROKER = new Set(["placed", "simulated"]);

/** Options describing how complete the recorded sequence is, plus the orders it produced. */
export interface CheckOptions {
  /**
   * The trace hit its recording cap, so tools beyond it are missing. An ABSENCE can then no
   * longer be distinguished from "not recorded", and an unknown must never masquerade as a
   * violation, so absence-based conclusions degrade to "not-applicable".
   */
  truncated?: boolean;
  /**
   * The orders this cycle recorded, if they were captured. Absent means "not observed", which is
   * never read as "none": duplication is then simply unknowable, not disproven.
   */
  orders?: readonly OrderRowLike[];
  /** The recorded order list hit its cap, so it is INCOMPLETE and cannot settle duplication. */
  ordersTruncated?: boolean;
}

/**
 * Did this cycle attempt a BUY at all?
 *
 * The three guards below are named "before-buy" / "before-entries" but were gated on `submit_orders`
 * PRESENCE, which is not the same thing. A cycle that submits only exits trips them, and on
 * 2026-08-06 one did: it read as "orders placed with no adversarial review" on a live-money account
 * when nothing was wrong, because de-risking needs no thesis and therefore no red team.
 *
 * ANY buy row counts, whatever its status. A BUY that the gate rejected still represents a decision
 * to buy, and that decision is exactly what should have been red-teamed first.
 *
 * "unknown" is deliberately NOT treated as "no". If the order list was never captured, or was
 * truncated, the guard keeps its stricter behaviour and stays applicable. Gating a safety guard on
 * evidence that might be missing would convert a noisy guard into a silently vacuous one, which is
 * strictly worse: a guard that says nothing looks exactly like a guard saying all is well.
 */
function buyAttempted(opts: CheckOptions): "yes" | "no" | "unknown" {
  if (opts.orders === undefined || opts.ordersTruncated === true) return "unknown";
  return opts.orders.some((o) => o.side.toUpperCase() === "BUY") ? "yes" : "no";
}

const SELL_ONLY_NOTE =
  "this cycle submitted only exits and attempted no BUY, so the guard was never exercised; " +
  "de-risking needs no thesis and therefore no review";

const TRUNCATED_NOTE =
  "the recorded tool sequence was TRUNCATED at its cap, so absence cannot be distinguished " +
  "from not-recorded; treated as not-applicable rather than a violation";

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
  truncated: boolean,
  /** The tool whose first occurrence must be preceded. Defaults to placing an order. */
  trigger: string = SUBMIT_ORDERS,
  /** When "no", the guarded path was not reached even though the trigger ran. */
  attempted: "yes" | "no" | "unknown" = "unknown",
): InvariantResult {
  const SUBMIT_ORDERS = trigger;
  const submitAt = sequence.indexOf(SUBMIT_ORDERS);
  if (submitAt === -1) {
    return {
      name,
      status: "not-applicable",
      detail: truncated
        ? `no ${SUBMIT_ORDERS} recorded, but ${TRUNCATED_NOTE}`
        : `no ${SUBMIT_ORDERS} in this cycle, so the guard was never exercised`,
    };
  }
  if (attempted === "no") {
    return { name, status: "not-applicable", detail: SELL_ONLY_NOTE };
  }
  const prerequisiteAt = sequence.indexOf(prerequisite);
  if (prerequisiteAt === -1) {
    // Ordering violations below are POSITIVE evidence and still fail even when truncated; this
    // one rests purely on absence, so truncation makes it unknowable.
    return truncated
      ? {
          name,
          status: "not-applicable",
          detail: `${prerequisite} was not recorded before ${SUBMIT_ORDERS}, but ${TRUNCATED_NOTE}`,
        }
      : {
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
export function checkInvariants(
  sequence: readonly string[],
  opts: CheckOptions = {},
): InvariantResult[] {
  const truncated = opts.truncated === true;
  const attempted = buyAttempted(opts);

  return [
    // All three are BUY-gated: they ask "if the agent decided to buy, did it do X first?". Passing
    // `attempted` is what stops a SELL-only cycle from reporting them as violations.
    prerequisiteBeforeSubmit(
      "earnings-before-buy",
      "get_earnings_calendar",
      sequence,
      truncated,
      SUBMIT_ORDERS,
      attempted,
    ),
    prerequisiteBeforeSubmit(
      "red-team-before-buy",
      "red_team",
      sequence,
      truncated,
      SUBMIT_ORDERS,
      attempted,
    ),
    prerequisiteBeforeSubmit(
      "exits-before-entries",
      "manage_positions",
      sequence,
      truncated,
      SUBMIT_ORDERS,
      attempted,
    ),
    // Unconditional: every cycle must leave a decision-log row, trade or no trade. Normally
    // never vacuous, which is exactly why it is the invariant that catches a cycle that died
    // silently part-way through. A truncated trace is the ONE case where its absence proves
    // nothing, because record_cycle runs at the very end and may sit beyond the cap.
    sequence.includes("record_cycle")
      ? { name: "cycle-recorded" as const, status: "pass" as const }
      : truncated
        ? {
            name: "cycle-recorded" as const,
            status: "not-applicable" as const,
            detail: `record_cycle was not recorded, but ${TRUNCATED_NOTE}`,
          }
        : {
            name: "cycle-recorded" as const,
            status: "fail" as const,
            detail: "record_cycle never ran, so this cycle left no decision-log row",
          },
    noDuplicateOrders(sequence, truncated, opts),
    // Durable memory may only change after an INDEPENDENT judge has vetted the change. The gate
    // advises on quality and this codebase's policy module enforces the structural rules, but
    // neither is worth much if the proposer can simply skip the review, so the sequence is checked
    // in production exactly as it is for red-teaming a trade.
    prerequisiteBeforeSubmit(
      "memory-gate-before-amend",
      MEMORY_GATE,
      sequence,
      truncated,
      AMEND_MEMORY,
    ),
  ];
}

/**
 * No instrument was sent to the broker twice in one cycle.
 *
 * THIS REPLACED A COUNT OF `submit_orders` CALLS, which was the wrong measurement. Multiple
 * submits are legitimate and routine: the agent submits sells and buys separately, and it retries
 * a workable variant when the broker rejects a first attempt. The first production cycle to do
 * that was reported as a violation while nothing whatever was wrong, and a guard that fires on
 * correct behaviour trains its reader to ignore it. The hazard actually worth alerting on is a
 * duplicate SEND (the same position sold or bought twice off one decision), which is a property
 * of the orders, not of how many calls produced them.
 *
 * Absence never convicts. No submits at all means the guard was not exercised; unrecorded or
 * truncated orders mean duplication is unknowable. Both are "not-applicable", so an observability
 * gap cannot masquerade as a double-spend.
 */
function noDuplicateOrders(
  sequence: readonly string[],
  truncated: boolean,
  opts: CheckOptions,
): InvariantResult {
  const name = "no-duplicate-orders" as const;
  if (!sequence.includes(SUBMIT_ORDERS)) {
    return {
      name,
      status: "not-applicable",
      detail: truncated
        ? `no ${SUBMIT_ORDERS} recorded, but ${TRUNCATED_NOTE}`
        : `no ${SUBMIT_ORDERS} in this cycle, so the guard was never exercised`,
    };
  }
  if (opts.orders === undefined) {
    return {
      name,
      status: "not-applicable",
      detail: `${SUBMIT_ORDERS} ran but its orders were not recorded, so duplication is unknowable`,
    };
  }
  if (opts.ordersTruncated === true) {
    return {
      name,
      status: "not-applicable",
      detail:
        "the recorded order list was TRUNCATED at its cap, so a duplicate may sit beyond it; " +
        "treated as not-applicable rather than a violation",
    };
  }

  const seen = new Map<string, number>();
  for (const order of opts.orders) {
    if (!SENT_TO_BROKER.has(order.status)) continue;
    const key = `${order.ticker}|${order.side}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length === 0) return { name, status: "pass" };
  return {
    name,
    status: "fail",
    detail: duplicates
      .map(([key, count]) => `${key.replace("|", " ")} sent ${count} times`)
      .join("; "),
  };
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
