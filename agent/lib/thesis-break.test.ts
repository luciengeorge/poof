import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { NewsItem } from "./data.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import {
  newsSinceEntry,
  THESIS_BREAK_MAX_ITEMS,
  THESIS_BREAK_THRESHOLD,
  thesisBreakCheck,
  thesisBreakFlags,
} from "./thesis-break.ts";

const OPENED = Date.parse("2026-09-10T15:00:00Z");
const H = 3_600_000;
const quiet = { warn: () => {} };

function item(hoursAfterEntry: number, headline = "Acme cuts guidance"): NewsItem {
  return {
    headline,
    summary: "s",
    source: "reuters",
    url: `https://n/${hoursAfterEntry}`,
    datetime: Math.floor((OPENED + hoursAfterEntry * H) / 1000),
    related: "ACME",
  };
}

function fakeJev(noul = 0.8, fail = false) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions as Record<string, JevQuestion>) });
      if (fail) throw new Error("jev down");
      return { model: "jev-1.13.0", answers: { broken: { type: "noul", noul } }, usage: { input_tokens: 1, output_tokens: 0 } } as JevResponse<typeof questions>;
    },
  };
  return { client, asked };
}

test("no news since entry is risk 0 and costs no Jev call", async () => {
  const { client, asked } = fakeJev();
  const out = await thesisBreakCheck(client, { ticker: "ACME", thesis: "t", openedAt: OPENED, news: [item(-5)] }, quiet);
  assert.deepEqual(out, { risk: 0, model: "none", headlinesConsidered: 0 });
  assert.equal(asked.length, 0);
});

test("news before entry is excluded; news since entry is what Jev sees", async () => {
  const { client, asked } = fakeJev(0.9);
  const news = [item(-2, "old"), item(1, "new one"), item(3, "newest")];
  const out = await thesisBreakCheck(client, { ticker: "ACME", thesis: "guidance holds", openedAt: OPENED, news }, quiet);
  assert.equal(out?.risk, 0.9);
  assert.equal(out?.headlinesConsidered, 2);
  assert.equal(out?.topHeadline, "newest");
  const sent = JSON.stringify(asked[0]?.state);
  assert.match(sent, /guidance holds/);
  assert.match(sent, /newest/);
  assert.doesNotMatch(sent, /"old"/);
  assert.deepEqual(asked[0]?.ids, ["broken"]);
});

test("the most recent items are kept when there are more than the cap", () => {
  const news = Array.from({ length: THESIS_BREAK_MAX_ITEMS + 5 }, (_v, i) => item(i + 1, `h${i + 1}`));
  const kept = newsSinceEntry(news, OPENED);
  assert.equal(kept.length, THESIS_BREAK_MAX_ITEMS);
  assert.equal(kept[0]?.headline, `h${THESIS_BREAK_MAX_ITEMS + 5}`);
});

test("a Jev failure returns undefined and never throws into the cycle", async () => {
  const { client } = fakeJev(0.5, true);
  const out = await thesisBreakCheck(client, { ticker: "ACME", thesis: "t", openedAt: OPENED, news: [item(1)] }, quiet);
  assert.equal(out, undefined);
});

test("flags list exactly the positions at or above the threshold", () => {
  const flags = thesisBreakFlags([
    { ticker: "A", thesisBreak: { risk: THESIS_BREAK_THRESHOLD } },
    { ticker: "B", thesisBreak: { risk: THESIS_BREAK_THRESHOLD - 0.01 } },
    { ticker: "C" },
    { ticker: "D", thesisBreak: { risk: 0.95 } },
  ]);
  assert.deepEqual(flags, ["A", "D"]);
});

test("review_performance runs the check and surfaces the flags (structural)", () => {
  // Mutation testing in this repo has shown unit tests alone do not prove wiring.
  const src = readFileSync(new URL("../tools/review_performance.ts", import.meta.url), "utf8");
  assert.match(src, /thesisBreakCheck\(/);
  assert.match(src, /thesisBreakFlags\(/);
  assert.match(src, /thesisBreakFlags:/);
  const prompt = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
  assert.match(prompt, /thesisBreakFlags/);
});
