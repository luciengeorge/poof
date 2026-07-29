import { disableTool } from "eve/tools";

// Disable eve's built-in `ask_question` framework tool for the red_team subagent.
//
// THIS IS NOT REDUNDANT WITH THE ROOT'S agent/tools/ask_question.ts. A declared subagent
// inherits NOTHING from the root's authored slots: eve's discovery treats its directory as its
// own agent root, and an absent slot falls back to the FRAMEWORK DEFAULT, not to the root's
// version (see node_modules/eve/docs/subagents.mdx, "The isolation boundary"). `ask_question`
// ships in the default harness for every agent, so without this file red_team gets it back.
//
// That is a live hazard, not a theoretical one. red_team runs on EVERY trading cycle, and eve
// proxies a descendant's `input.requested` up to the root channel so it can prompt the user, so
// one stray HITL call from the risk reviewer PARKS a live cycle waiting for a human who is not
// watching. That incident already happened once at the root; it was fixed there and left open in
// the subagent that fires most often.
//
// The agent runs fully autonomously on a schedule (see agent/instructions.md "Hard rules") and
// must never pause to ask a human: the risk gate is its authorization. Enforced structurally
// here, not just in prose, and pinned by agent/lib/no-hitl.test.ts for every declared subagent.
export default disableTool();
