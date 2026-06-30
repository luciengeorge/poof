import { defineAgent } from "eve";

export default defineAgent({
  // Orchestrator: sequences the trading pipeline and makes the trade calls. On Opus for
  // sharper judgement — it runs ~once/day so the cost is small. Subagents also run on Opus
  // (see agent/subagents/*). Design lives in the Obsidian vault.
  model: "anthropic/claude-opus-4.8",
});
