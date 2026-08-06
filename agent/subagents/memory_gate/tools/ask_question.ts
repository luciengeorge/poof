import { disableTool } from "eve/tools";

// Disable eve's built-in `ask_question` framework tool for the memory_gate subagent.
//
// Same reasoning as agent/subagents/red_team/tools/ask_question.ts, and NOT redundant with the
// root's agent/tools/ask_question.ts: a declared subagent inherits nothing from the root's
// authored slots, and an absent `tools/` slot falls back to the FRAMEWORK DEFAULT rather than to
// the root's version (node_modules/eve/docs/subagents.mdx, "The isolation boundary").
//
// This gate runs on EVERY cycle that proposes a memory edit, so like red_team it is one of the
// frequently-fired subagents where a stray HITL call would park a live run waiting for a human who
// is not watching. It also has nothing to ask about: judging a candidate memory against a fixed
// rubric is decidable from what it was given, and when a candidate is genuinely ambiguous its
// instructions tell it to REJECT and say what would make the rule admissible, which is the correct
// answer rather than a question. Pinned by agent/lib/no-hitl.test.ts for every declared subagent.
export default disableTool();
