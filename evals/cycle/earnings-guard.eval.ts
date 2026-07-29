import { defineEval } from "eve/evals";
import { invariantSatisfied } from "../lib/cycle-invariants.ts";

// Behavioral guardrail for the earnings binary-event guard (Signal step, instructions.md
// step 4): a candidate must get an earnings-calendar lookup before the agent commits to
// buying it: holding through an earnings print is uncontrolled gap risk a stop can't
// protect. Reaching a BUY in the demo agent is nondeterministic (the cycle can form zero
// candidates and no-trade, in which case no earnings check is needed), so this asserts the
// weaker, still safety-critical CONDITIONAL invariant: whenever submit_orders IS requested,
// get_earnings_calendar was requested earlier in the same run.
//
// The invariant itself is defined once in agent/lib/invariants.ts and is the SAME definition
// asserted against real production cycles by agent/hooks/trace-cycle.ts, so this guard cannot
// be green in CI while unenforced in production. A no-trade cycle still passes, but
// `invariantSatisfied` LOGS "PASSED VACUOUSLY" so a human reading CI can tell a verified guard
// from one that was never reached.
export default defineEval({
  async test(t) {
    await t.send(
      "Run one trading cycle now, following your instructions, and post the summary.",
    );
    t.succeeded();
    t.eventsSatisfy(
      "submit_orders is only requested after the earnings calendar was checked",
      (events) => invariantSatisfied(events, "earnings-before-buy"),
    );
  },
});
