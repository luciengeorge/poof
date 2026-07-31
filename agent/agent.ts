import { defineAgent } from "eve";

export default defineAgent({
  // Orchestrator: sequences the trading pipeline and makes the trade calls. Subagents use the
  // same model (see agent/subagents/*). Design lives in the Obsidian vault.
  //
  // GPT-5.6 Luna via the Vercel AI Gateway, verified reachable without BYOK. About 20-25x
  // cheaper per token than Opus 4.8 ($0.20/$1.20 per 1M vs $5/$25), which matters because
  // model spend was a large fraction of this account's size. Luna is the cheapest tier of the
  // GPT-5.6 series, so reasoning depth is bought back explicitly below rather than assumed.
  //
  // CRITICAL: the GPT-5.6 series defaults to reasoning "none", so reasoning is DISABLED unless
  // an effort level is set. Never drop `reasoning` from this config: without it a live-money
  // agent trades with no reasoning at all, silently and with no error. Reasoning bills as
  // output ($1.20/1M), so xhigh here is still far cheaper than Opus was.
  model: "openai/gpt-5.6-luna",
  reasoning: "xhigh",
});
