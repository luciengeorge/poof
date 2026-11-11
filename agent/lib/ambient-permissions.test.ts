import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { AMBIENT_TOOLS, isAmbient, withAmbientReadOnly } from "./ambient-permissions.ts";

const ambient = { session: { auth: { current: { attributes: { poofAmbient: "true" } } } } } as unknown as ToolContext;
test("ambient writes fail before the executor, regardless of prompt or tool inputs", () => {
  let calls = 0;
  const tool = withAmbientReadOnly("submit_orders", defineTool({ inputSchema: z.object({}), description: "test", execute() { calls++; return "placed"; } }));
  assert.throws(() => tool.execute({}, ambient), /Ambient conversation/); assert.equal(calls, 0);
  assert.equal(tool.execute({}, { session: { auth: { current: null } } } as unknown as ToolContext), "placed");
  assert.equal(calls, 1); assert.equal(isAmbient(undefined), false);
});
test("all authored tools are covered, and new names fail closed", () => {
  const dir = new URL("../tools/", import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "no_reply.ts")) {
    const src = readFileSync(new URL(name, dir), "utf8");
    assert.ok(src.includes(`withAmbientReadOnly("${name.slice(0, -3)}"`), name);
  }
  assert.equal(AMBIENT_TOOLS.has("recall_memory"), false);
  assert.equal(AMBIENT_TOOLS.has("record_cycle"), false);
  assert.equal(AMBIENT_TOOLS.has("manage_positions"), false);
  assert.equal(AMBIENT_TOOLS.has("new_unreviewed_tool"), false);
});
test("real money and memory tools reject ambient calls before accessing dependencies", async () => {
  for (const name of ["submit_orders", "manage_positions", "amend_memory", "record_cycle", "recall_memory"]) {
    const tool = (await import(new URL(`../tools/${name}.ts`, import.meta.url).href)).default;
    await assert.rejects(Promise.resolve().then(() => tool.execute({}, ambient)), /Ambient conversation cannot use/);
  }
});
test("ambient has no default sandbox/delegation and messages queue behind existing turns", () => {
  assert.match(readFileSync(new URL("../agent.ts", import.meta.url), "utf8"), /defaultTools: false/);
  const slack = readFileSync(new URL("../channels/slack.ts", import.meta.url), "utf8");
  assert.match(slack, /turnPolicy: "queue"/);
  assert.match(slack, /route\.auth\.attributes\.poofAmbient !== "true"/);
  assert.match(readFileSync(new URL("../hooks/record-messages.ts", import.meta.url), "utf8"), /if \(isAmbient\(ctx\)\) return/);
  for (const name of ["red_team", "memory_gate", "report_judge"]) {
    assert.match(readFileSync(new URL(`../subagents/${name}/agent.ts`, import.meta.url), "utf8"), /isAmbient\(ctx\) \? null/);
  }
});
