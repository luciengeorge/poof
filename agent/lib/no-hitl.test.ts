import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- THE NO-HITL GUARANTEE, STRUCTURALLY ---
//
// This agent runs fully autonomously on a schedule with nobody watching in real time, so it must
// never pause to ask a human: the risk gate is its authorization (agent/instructions.md, "Hard
// rules"). eve's default harness ships an `ask_question` tool to EVERY agent, and a stray call to
// it PARKS the session until a human answers. That already happened in production once.
//
// THE TRAP THIS TEST EXISTS TO CLOSE. Disabling it at the root is not enough. A declared subagent
// inherits NOTHING from the root's authored slots: eve treats its directory as its own agent root,
// and an absent `tools/` slot falls back to the FRAMEWORK DEFAULT, not to the root's version (see
// node_modules/eve/docs/subagents.mdx, "The isolation boundary"). eve also proxies a descendant's
// `input.requested` up to the root channel so it can prompt the user, so a subagent's stray
// question parks the parent's live cycle just as effectively. `red_team` runs on every single
// trading cycle and had exactly this hole for months while the root looked locked down.
//
// The subagent list is READ FROM DISK rather than hardcoded, on purpose: a subagent added later
// fails this test on day one instead of silently shipping the hole again.

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const SUBAGENTS_DIR = `${AGENT_DIR}subagents`;

/** Every declared subagent, discovered the way eve discovers them: by directory. */
function declaredSubagents(): string[] {
  return readdirSync(SUBAGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A file that disables a framework tool: the `disableTool()` sentinel and nothing else. */
function assertDisablesTool(path: string, label: string): void {
  assert.ok(existsSync(path), `${label} must exist: without it eve restores the framework default`);
  const source = readFileSync(path, "utf8");
  assert.match(
    source,
    /import \{ disableTool \} from "eve\/tools";/,
    `${label} must import disableTool from eve/tools`,
  );
  assert.match(
    source,
    /^export default disableTool\(\);$/m,
    `${label} must export the disableTool() sentinel as its default`,
  );
}

test("the subagent list is discovered from disk and is not empty (the guard cannot go vacuous)", () => {
  const subagents = declaredSubagents();
  assert.ok(subagents.length > 0, "no subagents found: this test would otherwise assert nothing");
  // Pinned so a directory rename cannot quietly shrink what is checked.
  assert.deepEqual(subagents, ["memory_gate", "red_team", "report_judge"]);
});

test("the ROOT agent disables the built-in ask_question", () => {
  assertDisablesTool(`${AGENT_DIR}tools/ask_question.ts`, "agent/tools/ask_question.ts");
});

test("EVERY declared subagent disables the built-in ask_question in its own tools slot", () => {
  // If you are reading this because the test just failed after adding a subagent: that is the
  // point. Add `agent/subagents/<id>/tools/ask_question.ts` exporting `disableTool()`. The root's
  // copy does NOT cover your subagent, and without it your subagent can park a live cycle.
  for (const id of declaredSubagents()) {
    assertDisablesTool(
      `${SUBAGENTS_DIR}/${id}/tools/ask_question.ts`,
      `agent/subagents/${id}/tools/ask_question.ts`,
    );
  }
});

test("no subagent re-authors ask_question as a callable tool", () => {
  // Disabling and then re-implementing it would satisfy the check above in letter only.
  for (const id of declaredSubagents()) {
    const source = readFileSync(`${SUBAGENTS_DIR}/${id}/tools/ask_question.ts`, "utf8");
    assert.doesNotMatch(
      source,
      /defineTool|execute/,
      `agent/subagents/${id}/tools/ask_question.ts must only disable, never re-implement`,
    );
  }
});

test("the hard rules still state the no-HITL guarantee in prose as well", () => {
  // Prose alone was what failed before, so it is the belt and the disableTool files are the
  // braces. Both, not either.
  const instructions = readFileSync(`${AGENT_DIR}instructions.md`, "utf8");
  assert.match(instructions, /NEVER ask the user to confirm, approve, or clarify anything/);
});
