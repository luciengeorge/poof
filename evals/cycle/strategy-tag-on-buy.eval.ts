import { defineEval } from "eve/evals";
import { STRATEGY_TAGS } from "../../agent/lib/positions.ts";

// Behavioral guardrail for strategy tagging (instructions.md step 7): every BUY must carry a
// `strategyTag` from the fixed taxonomy so per-type performance can be measured. Reaching a
// BUY in the demo agent is nondeterministic (the cycle can form zero candidates and no-trade),
// so, mirroring earnings-guard / red-team-before-buy, this asserts the conditional invariant:
// whenever submit_orders IS requested, every BUY proposal in its input carries a strategyTag
// drawn from the fixed set. The eval harness exposes tool-call arguments on `actions.requested`
// events (`action.input`), so this is checked at the value level. Vacuously true on a no-trade
// cycle, and SELLs (which are not tagged entries) are not required to carry a tag.
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
        return true; // no BUY reached this cycle, or all BUYs were tagged
      },
    );
  },
});
