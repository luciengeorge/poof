import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { aggregateEvalHealth, formatEvalHealth, type EvalHealthTrace } from "./eval-health.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import { jevDurabilityCheck } from "./jev-durability.ts";
import { jevGroundingCheck } from "./jev-grounding.ts";

const quiet = { warn: () => {} };

function fakeJev(values: Record<string, number>, fail = false) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions as Record<string, JevQuestion>) });
      if (fail) throw new Error("jev down");
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions as Record<string, JevQuestion>)) answers[id] = { type: "noul", noul: values[id] ?? 0.5 };
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 0 } } as JevResponse<typeof questions>;
    },
  };
  return { client, asked };
}

test("grounding asks both questions with the report and the ground truth as state", async () => {
  const { client, asked } = fakeJev({ supported: 0.91, contradicted: 0.04 });
  const out = await jevGroundingCheck(client, { reportText: "Account is worth £249.", groundTruth: { accountValueGbp: 249 }, coverage: ["cash captured"] }, quiet);
  assert.deepEqual(out, { supported: 0.91, contradicted: 0.04, model: "jev-1.13.0" });
  assert.deepEqual(asked[0]?.ids.sort(), ["contradicted", "supported"]);
  const sent = JSON.stringify(asked[0]?.state);
  assert.match(sent, /£249/);
  assert.match(sent, /accountValueGbp/);
});

test("grounding skips an empty report and survives a Jev failure", async () => {
  const good = fakeJev({});
  assert.equal(await jevGroundingCheck(good.client, { reportText: "   ", groundTruth: {} }, quiet), undefined);
  assert.equal(good.asked.length, 0);
  const bad = fakeJev({}, true);
  assert.equal(await jevGroundingCheck(bad.client, { reportText: "x", groundTruth: {} }, quiet), undefined);
});

test("durability asks one question over the proposed rule and survives a failure", async () => {
  const { client, asked } = fakeJev({ durable: 0.22 });
  const out = await jevDurabilityCheck(client, { condition: "IF a stop is hit", action: "never trade again", reason: "lost once" }, quiet);
  assert.deepEqual(out, { durable: 0.22, model: "jev-1.13.0" });
  assert.deepEqual(asked[0]?.ids, ["durable"]);
  assert.match(JSON.stringify(asked[0]?.state), /never trade again/);
  const bad = fakeJev({}, true);
  assert.equal(await jevDurabilityCheck(bad.client, { condition: "c", action: "a" }, quiet), undefined);
});

function trace(over: Partial<EvalHealthTrace> & { reportScore?: EvalHealthTrace["reportScore"] }): EvalHealthTrace {
  return {
    sessionId: "s",
    turnId: over.turnId ?? "t",
    completedAt: Date.parse("2026-09-15T16:00:00Z"),
    toolSequence: [],
    invariants: [],
    judgedAt: 1,
    ...over,
  };
}

test("eval health averages Jev grounding over the judged cycles that carry it, and renders one line", () => {
  const judged = (turnId: string, jev?: { jevSupported: number; jevContradicted: number }) =>
    trace({
      turnId,
      reportScore: { status: "judged", grounding: 4, consistency: 4, calibration: 4, completeness: 4, overall: 4, findings: [], ...(jev ?? {}) },
    });
  const health = aggregateEvalHealth(
    [judged("a", { jevSupported: 0.9, jevContradicted: 0.1 }), judged("b", { jevSupported: 0.7, jevContradicted: 0.3 }), judged("c")],
  );
  assert.deepEqual(health.reportQuality.jevGrounding, { supported: 0.8, contradicted: 0.2, n: 2 });
  const text = formatEvalHealth(health).join("\n");
  assert.match(text, /Jev grounding \(second opinion, n=2\): supported 0\.8, contradicted 0\.2/);

  const none = aggregateEvalHealth([judged("a")]);
  assert.equal(none.reportQuality.jevGrounding, null);
  assert.doesNotMatch(formatEvalHealth(none).join("\n"), /Jev grounding/);
});

test("the two checks are wired beside the LLM judgements, not instead of them (structural)", () => {
  const save = readFileSync(new URL("../tools/save_report_score.ts", import.meta.url), "utf8");
  assert.match(save, /jevGroundingCheck\(/);
  // The LLM verdict is still parsed and stored the same way; Jev fields are spread in beside it.
  assert.match(save, /parseJudgeVerdict\(verdict\)/);
  assert.match(save, /\.\.\.parsed\.score, \.\.\.\(jevGrounding \?\? \{\}\)/);
  const amend = readFileSync(new URL("../tools/amend_memory.ts", import.meta.url), "utf8");
  assert.match(amend, /jevDurabilityCheck\(/);
  assert.match(amend, /applyMemoryEdits\(/, "the policy still applies the edits; Jev only annotates");
});
