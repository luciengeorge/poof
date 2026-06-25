import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Independent skeptical risk reviewer. Given ONE proposed trade thesis, argues against it and returns a verdict (keep / shrink / veto) with a reason. Cannot place trades; can only reduce risk.",
  model: "anthropic/claude-opus-4.8",
});
