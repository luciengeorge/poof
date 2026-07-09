import { defineEval } from "eve/evals";

// Behavioral guardrail for the scheduled trading cycle. Runs in DRY_RUN + demo
// (see the eval workflow / local defaults), so no real orders are placed.
// Guards: (1) the agent runs autonomously and never parks on a HITL question
// (t.succeeded() fails if the run parked) — the regression that stalled Slack threads;
// (2) it follows the cycle discipline: recall -> manage exits -> review performance,
// before any trading.
export default defineEval({
  async test(t) {
    await t.send(
      "Run one trading cycle now, following your instructions, and post the summary.",
    );
    t.succeeded(); // did not fail AND did not park on unanswered HITL input
    t.toolOrder(["recall_memory", "manage_positions", "review_performance"]);
  },
});
