import { defineAgent } from "eve";

export default defineAgent({
  description:
    "LLM-as-judge for report QUALITY. Given ONE already-published cycle report plus the tool " +
    "outputs it was written from, grades it 1-5 on grounding, consistency, calibration and " +
    "completeness and returns structured scores only. It GRADES, it never rewrites: it cannot " +
    "produce a corrected report, and it cannot change, delay, or block anything. Called from " +
    "the weekly scorecard schedule over stored cycle traces, never during a live trading cycle.",
  // Same model as the orchestrator and red_team: judging report quality is judgement work, and
  // this runs about 5 times a week (one completed cycle per weekday), so the cost is small.
  model: "anthropic/claude-opus-4.8",
});
