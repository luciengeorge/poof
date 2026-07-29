import { disableTool } from "eve/tools";

// Disable eve's built-in `ask_question` framework tool for the report_judge subagent.
//
// Same reasoning as agent/subagents/red_team/tools/ask_question.ts, and NOT redundant with the
// root's agent/tools/ask_question.ts: a declared subagent inherits nothing from the root's
// authored slots, and an absent `tools/` slot falls back to the FRAMEWORK DEFAULT rather than to
// the root's version (node_modules/eve/docs/subagents.mdx, "The isolation boundary").
//
// A judge that could ask a question would be doubly wrong. It grades stored data from a cycle
// that finished days ago, so there is nothing a human answer could change, and its own
// instructions already forbid asking for more input. Removing the tool makes that structural.
// Pinned by agent/lib/no-hitl.test.ts for every declared subagent.
export default disableTool();
