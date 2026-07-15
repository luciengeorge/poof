import { defineEval } from "eve/evals";

// Behavioral guardrail for the earnings binary-event guard (Signal step, instructions.md
// step 4): every surviving candidate must get an earnings-calendar lookup before the agent
// decides how to size or exit it. Holding through an earnings print is uncontrolled gap risk
// a stop can't protect, so this must run on every cycle that forms a candidate thesis.
export default defineEval({
  async test(t) {
    await t.send(
      "Run one trading cycle now, following your instructions, and post the summary.",
    );
    t.succeeded();
    t.calledTool("get_earnings_calendar");
  },
});
