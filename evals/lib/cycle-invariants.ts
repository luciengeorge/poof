/**
 * Offline (CI) side of the shared cycle invariants.
 *
 * The invariant definitions live in agent/lib/invariants.ts and are the SINGLE SOURCE OF TRUTH:
 * the same `checkInvariants` grades a demo run here in CI and a real production cycle in
 * agent/hooks/trace-cycle.ts. This module only adapts the eval event stream to the string
 * sequence that function takes, and makes vacuity VISIBLE in the CI log.
 *
 * WHY THE LOGGING MATTERS. The submit-gated invariants hold vacuously when the cycle never
 * reached a BUY, which is common in the demo agent. A green run therefore does not prove the
 * guarded path was exercised. Printing "held VACUOUSLY" means a human reading CI can tell
 * "verified" from "never reached" instead of the two looking identical.
 *
 * Two readings of the same 3-state result live here: `invariantSatisfied` (vacuity passes, for
 * a cycle that may legitimately no-trade) and `invariantVerified` (vacuity FAILS, for an eval
 * that demands the guarded path actually be exercised).
 */

import {
  checkInvariants,
  invariantByName,
  SUBMIT_ORDERS,
  type InvariantName,
} from "../../agent/lib/invariants.ts";
import { requestedActionNames, type EventLike } from "../../agent/lib/cycle-trace.ts";

/**
 * Grade one named invariant against the run, keeping the existing pass/fail semantics:
 * "not-applicable" still passes (the cycle legitimately never reached a BUY), but it is logged
 * as vacuous so the distinction is not lost.
 */
export function invariantSatisfied(
  events: readonly EventLike[],
  name: InvariantName,
): boolean {
  const sequence = requestedActionNames(events);
  const result = invariantByName(checkInvariants(sequence), name);
  if (!result) {
    console.error(`[eval] no invariant named ${name}`);
    return false;
  }
  if (result.status === "not-applicable") {
    console.log(
      `[eval] ${name}: PASSED VACUOUSLY (${result.detail ?? "guard never exercised"}). ` +
        `Tool sequence: ${sequence.join(" -> ")}`,
    );
    return true;
  }
  if (result.status === "fail") {
    console.error(
      `[eval] ${name}: VIOLATED (${result.detail ?? "no detail"}). ` +
        `Tool sequence: ${sequence.join(" -> ")}`,
    );
    return false;
  }
  console.log(`[eval] ${name}: verified against a real ${SUBMIT_ORDERS} in this run.`);
  return true;
}

/**
 * POSITIVE verification of one named invariant: the guarded path must have been EXERCISED and
 * held. Same single source of truth (`checkInvariants`), stricter reading of its 3-state result:
 * only "pass" passes, and "not-applicable" (no submit_orders, so the guard was never reached)
 * FAILS instead of passing vacuously.
 *
 * WHY THE ADAPTER EXISTS. `invariantSatisfied` above is right for a normal cycle, which may
 * legitimately no-trade: it must not fail an agent for not buying. But a suite made only of
 * conditional guards can go green with every guard unexercised, which is exactly what happened
 * when all three submit-gated invariants logged "PASSED VACUOUSLY". This adapter is the other
 * half of the pair, for an eval whose prompt DEMANDS a trade, and it is here rather than
 * inside agent/lib/invariants.ts so the shared checker's semantics stay unchanged for the
 * conditional evals and for the production hook.
 */
export function invariantVerified(
  events: readonly EventLike[],
  name: InvariantName,
): boolean {
  const sequence = requestedActionNames(events);
  const result = invariantByName(checkInvariants(sequence), name);
  if (!result) {
    console.error(`[eval] no invariant named ${name}`);
    return false;
  }
  if (result.status === "pass") {
    console.log(`[eval] ${name}: VERIFIED against a real ${SUBMIT_ORDERS} in this run.`);
    return true;
  }
  const why =
    result.status === "not-applicable"
      ? `the guarded path was NOT EXERCISED, so this guard is UNVERIFIED (${result.detail ?? "no " + SUBMIT_ORDERS})`
      : `VIOLATED (${result.detail ?? "no detail"})`;
  console.error(`[eval] ${name}: ${why}. Tool sequence: ${sequence.join(" -> ")}`);
  return false;
}

/**
 * Did the run actually exercise the guarded (order-submitting) path? Uses the shared invariants
 * so "the guard was never reached" means the same thing here as it does in production. Logs the
 * vacuous case for the same reason as above.
 */
export function guardedPathExercised(
  events: readonly EventLike[],
  label: string,
): boolean {
  const sequence = requestedActionNames(events);
  const submitted = invariantByName(checkInvariants(sequence), "single-submit");
  if (submitted?.status === "not-applicable") {
    console.log(
      `[eval] ${label}: PASSED VACUOUSLY (no ${SUBMIT_ORDERS} in this run). ` +
        `Tool sequence: ${sequence.join(" -> ")}`,
    );
    return false;
  }
  return true;
}
