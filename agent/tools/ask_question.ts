import { disableTool } from "eve/tools";

// Disable eve's built-in `ask_question` framework tool. This agent runs fully
// autonomously on a schedule (see agent/instructions.md "Hard rules") and must never
// pause to ask a human — the risk gate is its authorization. Leaving the framework
// tool exposed let the model occasionally emit a stray HITL input request that parked
// a session. Removing it enforces the no-HITL guarantee structurally, not just in prose.
export default disableTool();
