import { defineAgent } from "eve";

export default defineAgent({
  // Orchestrator: sequences the trading pipeline. Research + red-team subagents
  // run on Opus (see agent/subagents/*). Design lives in the Obsidian vault.
  model: "anthropic/claude-sonnet-4.6",
});
