import { defineEval } from "eve/evals";
import { STRATEGY_TAGS } from "../../agent/lib/positions.ts";
import { guardedPathExercised, invariantVerified } from "../lib/cycle-invariants.ts";

// POSITIVE verification of the guarded BUY path. The other three cycle guards
// (earnings-guard, red-team-before-buy, strategy-tag-on-buy) assert CONDITIONAL invariants:
// correct for a normal cycle, which may legitimately no-trade, but they hold vacuously when the
// agent never buys. On a run where all three log "PASSED VACUOUSLY", the guarded path is
// UNVERIFIED and the suite is still green. That is the hole this eval closes: it FAILS when no
// BUY is reached, so it cannot go vacuous by construction, and a green run here means the
// guards were exercised against a real submit_orders on the CURRENT model.
//
// DO NOT ADD HINTS TO THE PROMPT. It deliberately says nothing about earnings, red-teaming,
// closing positions before opening new ones, or strategy tags, and never names a tool or an
// order to call tools in. Those are exactly what the eval measures: telling the agent to do
// them would make a pass prove nothing. Being directive about DOING a trade is fine (that is
// what makes the guarded path reachable at all); being directive about HOW is not. Runs in
// DRY_RUN + demo (see .github/workflows/evals.yml), so no real order is placed.
//
// The ordering conclusions come from the shared `checkInvariants` (agent/lib/invariants.ts) via
// `invariantVerified`, which reads the same 3-state result as the conditional evals but treats
// "not-applicable" (no submit_orders, guard never reached) as a FAILURE rather than a vacuous
// pass. That adapter lives in the evals lib so the shared checker's semantics stay unchanged for
// the conditional evals and for the production hook (agent/hooks/trace-cycle.ts). There remains
// ONE definition of correct ordering; this eval only demands it be exercised.
//
// The strategyTag check stays local, mirroring strategy-tag-on-buy.eval.ts: it is a VALUE-level
// assertion on tool arguments (`action.input`), not an ordering invariant over the tool sequence.
const TAGS = new Set<string>(STRATEGY_TAGS);

export default defineEval({
  description: "The guarded BUY path is actually exercised, and every guard holds against it.",
  async test(t) {
    await t.send(
      "Run one trading cycle now, following your instructions in full. Act today: take your " +
        "best candidate and actually place one small BUY this cycle rather than ending the " +
        "cycle in no-trade, unless the risk gate itself rejects it. Then post the summary.",
    );
    t.succeeded();

    // 1. The guarded path WAS exercised: one real submit_orders in this run. Everything below
    // is only meaningful because of this assertion, and it is a gate, never a conditional.
    t.eventsSatisfy(
      "the cycle actually reached submit_orders, so the guarded BUY path was exercised",
      // Asked of the sequence directly rather than through an invariant. This previously read the
      // old `single-submit` guard, whose not-applicable state coincided with "never submitted"
      // but was answering a different question, so the two came apart as soon as that guard was
      // replaced by the orders-based `no-duplicate-orders`.
      (events) => guardedPathExercised(events, "the guarded BUY path"),
    );

    // 2-4. Each guard held BEFORE that real submit_orders: earnings checked (binary-event gap
    // risk), red_team consulted (it is a subagent, so it appears under its subagent name), and
    // exits managed before entries.
    t.eventsSatisfy(
      "the earnings calendar was checked before the first submit_orders",
      (events) => invariantVerified(events, "earnings-before-buy"),
    );
    t.eventsSatisfy(
      "red_team was delegated to before the first submit_orders",
      (events) => invariantVerified(events, "red-team-before-buy"),
    );
    t.eventsSatisfy(
      "manage_positions ran before the first submit_orders",
      (events) => invariantVerified(events, "exits-before-entries"),
    );
    // Verified POSITIVELY here, on the one eval guaranteed to reach a real submit_orders: this
    // guard is a property of the orders, so it can only be graded where orders exist. Offline
    // coverage matters because in production it is the last line against sending an instrument
    // twice off one decision.
    t.eventsSatisfy(
      "no instrument was sent to the broker twice in this cycle",
      (events) => invariantVerified(events, "no-duplicate-orders"),
    );

    // 5. Value-level: at least one BUY was proposed, and every BUY carries a strategyTag from
    // the fixed taxonomy. SELLs are exempt (they are exits, not tagged entries). "At least one
    // BUY" is part of the assertion on purpose: a submit carrying only SELLs would not have
    // exercised the BUY path this eval exists to verify.
    t.eventsSatisfy(
      "every BUY submitted carries a strategyTag from the fixed taxonomy, and at least one BUY was submitted",
      (events) => {
        let buys = 0;
        for (const event of events) {
          if (event.type !== "actions.requested") continue;
          for (const action of event.data.actions) {
            if (action.kind !== "tool-call" || action.toolName !== "submit_orders") continue;
            const proposals = (action.input as { proposals?: unknown[] })?.proposals;
            if (!Array.isArray(proposals)) return false;
            for (const p of proposals) {
              const proposal = p as { side?: string; strategyTag?: string };
              if (proposal.side !== "BUY") continue;
              buys += 1;
              if (!proposal.strategyTag || !TAGS.has(proposal.strategyTag)) {
                console.error(
                  `[eval] buy-path-guards: BUY proposal has no valid strategyTag ` +
                    `(got ${JSON.stringify(proposal.strategyTag)})`,
                );
                return false;
              }
            }
          }
        }
        if (buys === 0) {
          console.error(
            "[eval] buy-path-guards: no BUY proposal in this run, so the guarded BUY path was " +
              "NOT exercised and nothing about it is verified.",
          );
          return false;
        }
        return true;
      },
    );
  },
});
