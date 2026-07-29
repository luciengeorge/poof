import { defineEval } from "eve/evals";
import { STRATEGY_TAGS } from "../../agent/lib/positions.ts";
import { guardedPathExercised } from "../lib/cycle-invariants.ts";

// Behavioral guardrail for strategy tagging (instructions.md step 7): every BUY must carry a
// `strategyTag` from the fixed taxonomy so per-type performance can be measured. Reaching a
// BUY in the demo agent is nondeterministic (the cycle can form zero candidates and no-trade),
// so, mirroring earnings-guard / red-team-before-buy, this asserts the CONDITIONAL invariant:
// whenever submit_orders IS requested, every BUY proposal in its input carries a strategyTag
// drawn from the fixed set. SELLs (which are not tagged entries) are not required to carry one.
//
// Applicability comes from the shared invariants (agent/lib/invariants.ts) via
// `guardedPathExercised`, so "the guarded path was never reached" means exactly the same thing
// here as it does for the other two evals and for the production hook, and the vacuous case is
// LOGGED rather than silently green. The tag check itself stays local because it is a
// VALUE-level assertion on tool arguments, not an ordering invariant over the tool sequence:
// the eval harness exposes tool-call arguments on `actions.requested` events (`action.input`).
const TAGS = new Set<string>(STRATEGY_TAGS);

export default defineEval({
  async test(t) {
    await t.send(
      "Run one trading cycle now, following your instructions, and post the summary.",
    );
    t.succeeded();
    t.eventsSatisfy(
      "every BUY submitted via submit_orders carries a strategyTag from the fixed taxonomy",
      (events) => {
        if (!guardedPathExercised(events, "strategy-tag-on-buy")) return true;
        for (const event of events) {
          if (event.type !== "actions.requested") continue;
          for (const action of event.data.actions) {
            if (action.kind !== "tool-call" || action.toolName !== "submit_orders") continue;
            const proposals = (action.input as { proposals?: unknown[] })?.proposals;
            if (!Array.isArray(proposals)) return false;
            for (const p of proposals) {
              const proposal = p as { side?: string; strategyTag?: string };
              if (proposal.side !== "BUY") continue; // only entries are tagged
              if (!proposal.strategyTag || !TAGS.has(proposal.strategyTag)) return false;
            }
          }
        }
        return true; // every BUY in this run was tagged
      },
    );
  },
});
