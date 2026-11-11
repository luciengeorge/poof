import { isAmbient } from "../../lib/ambient-permissions.ts";
import { defineAgent, defineDynamic } from "eve";

const definition = defineAgent({
  description:
    "Independent skeptical risk reviewer. Given ONE proposed trade thesis, argues against it and returns a verdict (keep / shrink / veto) with a reason. Cannot place trades; can only reduce risk.",
  // Same model as the orchestrator. `reasoning` is REQUIRED, not optional: the GPT-5.6 series
  // defaults to reasoning "none", and an adversarial risk reviewer with reasoning disabled
  // would rubber-stamp theses while still looking like it ran. xhigh because this is the only
  // check that argues against a trade before the code gate sees it.
  model: "openai/gpt-5.6-luna",
  reasoning: "xhigh",
});

export default defineDynamic((ctx) => isAmbient(ctx) ? null : definition);
