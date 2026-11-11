import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Eve 1.0 makes ask_question opt-in. Do not add it at the root or in a
// subagent: a question can park an autonomous trading cycle indefinitely.

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const SUBAGENTS_DIR = `${AGENT_DIR}subagents`;

/** Every declared subagent, discovered the way eve discovers them: by directory. */
function declaredSubagents(): string[] {
  return readdirSync(SUBAGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("the subagent list is discovered from disk and is not empty (the guard cannot go vacuous)", () => {
  const subagents = declaredSubagents();
  assert.ok(subagents.length > 0, "no subagents found: this test would otherwise assert nothing");
  // Pinned so a directory rename cannot quietly shrink what is checked.
  assert.deepEqual(subagents, ["memory_gate", "red_team", "report_judge"]);
});

test("ask_question is not opted in at the root or in any declared subagent", () => {
  for (const dir of [AGENT_DIR, ...declaredSubagents().map((id) => `${SUBAGENTS_DIR}/${id}/`)]) {
    assert.ok(!existsSync(`${dir}tools/ask_question.ts`), `${dir} must not expose ask_question`);
  }
});

test("the hard rules still state the no-HITL guarantee in prose as well", () => {
  // Keep the policy explicit as well as leaving the question tool out of every agent.
  const instructions = readFileSync(`${AGENT_DIR}instructions.md`, "utf8");
  assert.match(instructions, /NEVER ask the user to confirm, approve, or clarify anything/);
});
