import { defineAgent } from "eve";

export default defineAgent({
  description:
    "LLM-as-judge for report QUALITY. Given ONE already-published cycle report plus the tool " +
    "outputs it was written from, grades it 1-5 on grounding, consistency, calibration and " +
    "completeness and returns structured scores only. It GRADES, it never rewrites: it cannot " +
    "produce a corrected report, and it cannot change, delay, or block anything. Called from " +
    "the weekly scorecard schedule over stored cycle traces, never during a live trading cycle.",
  // Same model as the orchestrator and red_team. `reasoning` is REQUIRED: the GPT-5.6 series
  // defaults to reasoning "none", and a grader with reasoning disabled would return plausible
  // scores without actually checking the report against the tool outputs. "high" rather than
  // xhigh because grading against a fixed rubric is a bounded task, unlike forming a thesis.
  model: "openai/gpt-5.6-luna",
  reasoning: "high",
});
