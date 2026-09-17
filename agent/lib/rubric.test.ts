import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import {
  binaryEventInWindow,
  RUBRIC_SHRINK_CONNECTS_BELOW,
  RUBRIC_SHRINK_PRICED_ABOVE,
  RUBRIC_SHRINK_SUBSTANCE_BELOW,
  RUBRIC_VETO_CONNECTS_BELOW,
  RUBRIC_VETO_SUBSTANCE_BELOW,
  rubricCheck,
  rubricVerdict,
  type RubricAnswers,
} from "./rubric.ts";

const strong: RubricAnswers = { pricedIn: 0.2, catalystConnects: 0.9, substance: 0.9 };
const quiet = { warn: () => {} };
const EPS = 0.001;

test("a strong, fresh, connected thesis is kept with no reasons", () => {
  assert.deepEqual(rubricVerdict(strong, false), { verdict: "keep", reasons: [] });
});

test("veto boundaries: just below vetoes, at the line does not", () => {
  const c = rubricVerdict({ ...strong, catalystConnects: RUBRIC_VETO_CONNECTS_BELOW - EPS }, false);
  assert.equal(c.verdict, "veto");
  assert.match(c.reasons[0] ?? "", /does not connect/);
  assert.notEqual(rubricVerdict({ ...strong, catalystConnects: RUBRIC_VETO_CONNECTS_BELOW }, false).verdict, "veto");

  const s = rubricVerdict({ ...strong, substance: RUBRIC_VETO_SUBSTANCE_BELOW - EPS }, false);
  assert.equal(s.verdict, "veto");
  assert.match(s.reasons[0] ?? "", /no specific catalyst/);
  assert.notEqual(rubricVerdict({ ...strong, substance: RUBRIC_VETO_SUBSTANCE_BELOW }, false).verdict, "veto");
});

test("shrink boundaries: just past shrinks, at the line keeps", () => {
  assert.equal(rubricVerdict({ ...strong, pricedIn: RUBRIC_SHRINK_PRICED_ABOVE + EPS }, false).verdict, "shrink");
  assert.equal(rubricVerdict({ ...strong, pricedIn: RUBRIC_SHRINK_PRICED_ABOVE }, false).verdict, "keep");
  assert.equal(rubricVerdict({ ...strong, catalystConnects: RUBRIC_SHRINK_CONNECTS_BELOW - EPS }, false).verdict, "shrink");
  assert.equal(rubricVerdict({ ...strong, catalystConnects: RUBRIC_SHRINK_CONNECTS_BELOW }, false).verdict, "keep");
  assert.equal(rubricVerdict({ ...strong, substance: RUBRIC_SHRINK_SUBSTANCE_BELOW - EPS }, false).verdict, "shrink");
  assert.equal(rubricVerdict({ ...strong, substance: RUBRIC_SHRINK_SUBSTANCE_BELOW }, false).verdict, "keep");
});

test("a binary event inside the window vetoes, unless the trade is an earnings play", () => {
  assert.equal(rubricVerdict(strong, true).verdict, "veto");
  assert.match(rubricVerdict(strong, true).reasons[0] ?? "", /earnings print inside the hold window/);
  assert.equal(rubricVerdict(strong, true, "earnings-play").verdict, "keep");
  assert.equal(rubricVerdict(strong, true, "news-catalyst").verdict, "veto");
});

test("reasons name every triggered rule with its number, and a veto wins over a shrink", () => {
  const r = rubricVerdict({ pricedIn: 0.9, catalystConnects: 0.1, substance: 0.9 }, false);
  assert.equal(r.verdict, "veto");
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0] ?? "", /0\.10 < 0\.35/);
  const s = rubricVerdict({ pricedIn: 0.9, catalystConnects: 0.5, substance: 0.5 }, false);
  assert.equal(s.verdict, "shrink");
  assert.equal(s.reasons.length, 3);
});

test("the binary-event test is arithmetic on the calendar, not a Jev question", () => {
  assert.equal(binaryEventInWindow({ nextEarnings: { date: "2026-09-25", daysUntil: 8 }, maxHoldDays: 10 }), true);
  assert.equal(binaryEventInWindow({ nextEarnings: { date: "2026-09-25", daysUntil: 8 }, maxHoldDays: 5 }), false);
  assert.equal(binaryEventInWindow({ nextEarnings: null }), false);
  assert.equal(binaryEventInWindow({ nextEarnings: { date: "2026-12-01", daysUntil: 75 } }), false);
});

function fakeJev(a: RubricAnswers, fail = false) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions as Record<string, JevQuestion>) });
      if (fail) throw new Error("jev down");
      return {
        model: "jev-1.13.0",
        answers: {
          pricedIn: { type: "noul", noul: a.pricedIn },
          catalystConnects: { type: "noul", noul: a.catalystConnects },
          substance: { type: "noul", noul: a.substance },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as JevResponse<typeof questions>;
    },
  };
  return { client, asked };
}

test("rubricCheck asks exactly the three text questions and applies the rule in code", async () => {
  const { client, asked } = fakeJev({ pricedIn: 0.8, catalystConnects: 0.9, substance: 0.9 });
  const out = await rubricCheck(client, { ticker: "NVDA_US_EQ", thesis: "Guidance raised.", strategyTag: "news-catalyst" }, quiet);
  assert.deepEqual(asked[0]?.ids.sort(), ["catalystConnects", "pricedIn", "substance"]);
  assert.match(JSON.stringify(asked[0]?.state), /Guidance raised/);
  assert.equal(out?.verdict, "shrink");
  assert.match(out?.reasons[0] ?? "", /priced in/);
  assert.equal(out?.binaryEventInWindow, false);
  assert.equal(out?.model, "jev-1.13.0");
});

test("rubricCheck computes the binary flag from the calendar even when Jev is strong", async () => {
  const { client } = fakeJev(strong);
  const out = await rubricCheck(client, { ticker: "X", thesis: "t", nextEarnings: { date: "2026-09-25", daysUntil: 8 } }, quiet);
  assert.equal(out?.binaryEventInWindow, true);
  assert.equal(out?.verdict, "veto");
});

test("a Jev failure returns undefined and never throws into the cycle", async () => {
  const { client } = fakeJev(strong, true);
  assert.equal(await rubricCheck(client, { ticker: "X", thesis: "t" }, quiet), undefined);
});

test("the rubric is wired ahead of the red team (structural)", () => {
  // Mutation testing in this repo has shown unit tests alone do not prove wiring.
  const tool = readFileSync(new URL("../tools/rubric_check.ts", import.meta.url), "utf8");
  assert.match(tool, /rubricCheck\(/);
  const prompt = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
  const rubricAt = prompt.indexOf("rubric_check");
  const redTeamAt = prompt.indexOf("to the `red_team` subagent");
  assert.ok(rubricAt > 0 && redTeamAt > 0 && rubricAt < redTeamAt, "rubric_check must be called before red_team in the prompt");
  const redTeam = readFileSync(new URL("../subagents/red_team/instructions.md", import.meta.url), "utf8");
  assert.match(redTeam, /rubric/i);
  assert.doesNotMatch(redTeam, /usually weak/);
});
